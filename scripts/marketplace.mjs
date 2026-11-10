/**
 * PF2e Marketplace
 * A marketplace window over PF2e's own merchants: markets (a name, picture, description and the shops in them),
 * browsed without opening merchant sheets. Shops stay ordinary PF2e merchant loot actors, so they keep working as
 * merchant sheets without the module.
 */

import { esc, cleanStore, cleanMarket, byMarketOrder, canSee, canTrade, shopsOf, formatCp, groupStock } from "./helpers.mjs";
import { isMerchant, actorLevel, stockRows, descriptionOf, merchantData } from "./pf2e.mjs";

const MOD = "pf2e-marketplace";
/** Browser storage keys, per world and user. */
const storeKey = (what) => `${MOD}.${what}.${game.world?.id ?? "world"}.${game.user?.id ?? "user"}`;
const DialogV2 = () => foundry.applications.api.DialogV2;
const TextEditor = () => foundry.applications.ux.TextEditor.implementation;

/* ------------------------------------------------------------------ */
/* Window memory                                                      */
/* ------------------------------------------------------------------ */

/* The same code in each of Sir Bayard's modules. A window made with rememberWindow keeps the size and place the user
 * gives it, in this browser, and comes back from minimized whole: Foundry's restore animation can stall at the title
 * bar's height (seen on 14.370, core windows too) and Foundry sets the size while it runs, so a restored window came
 * back as a strip. */

/** Wait for an element's own transitions to end; a hidden tab pauses them, so after a second they're finished by hand. */
async function settleWindow(el) {
  const anims = el?.getAnimations?.() ?? [];
  if (!anims.length) return;
  await Promise.race([Promise.all(anims.map((a) => a.finished.catch(() => null))), new Promise((r) => setTimeout(r, 1200))]);
  for (const a of el.getAnimations?.() ?? []) {
    try {
      a.finish();
    } catch {
      /* an animation that can't finish (infinite) is left alone */
    }
  }
}

/**
 * Give an ApplicationV2 class window memory.
 * @param {typeof ApplicationV2} Base
 * @param {string} key          localStorage key for this window
 * @param {object} [opts]
 * @param {boolean|"width"} [opts.size] what to keep besides the place: true for width and height, "width" for a window
 *   whose height fits its content, false for a window sized wholly by its content
 */
function rememberWindow(Base, key, { size = true } = {}) {
  const MIN_W = 240, MIN_H = 120;
  const load = () => {
    let v;
    try {
      v = JSON.parse(globalThis.localStorage?.getItem(key) ?? "null");
    } catch {
      return {};
    }
    if (!v || typeof v !== "object") return {};
    const W = globalThis.innerWidth ?? 1920, H = globalThis.innerHeight ?? 1080;
    const out = {};
    // A size saved while the window was collapsed is no size at all.
    if (size === true && v.width >= MIN_W && v.height >= MIN_H) {
      out.width = Math.min(v.width, W);
      out.height = Math.min(v.height, H);
    } else if (size === "width" && v.width >= MIN_W) out.width = Math.min(v.width, W);
    const w = out.width ?? MIN_W, h = out.height ?? MIN_H;
    if (Number.isFinite(v.left)) out.left = Math.max(0, Math.min(v.left, W - w));
    if (Number.isFinite(v.top)) out.top = Math.max(0, Math.min(v.top, H - h));
    return out;
  };
  let timer = null;
  const save = (position) => {
    // Copy now: Foundry hands over its own live position object, which may change before the save runs.
    const pos = { left: position.left, top: position.top, width: position.width, height: position.height };
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const v = { left: pos.left, top: pos.top };
        if (size) v.width = pos.width;
        if (size === true) v.height = pos.height;
        globalThis.localStorage?.setItem(key, JSON.stringify(v));
      } catch {
        /* no storage: the window opens where Foundry puts it */
      }
    }, 300);
  };

  return class extends Base {
    #beforeMin = null;
    #restoring = false;
    #restore = null;

    constructor(options = {}) {
      super(foundry.utils.mergeObject({ position: load() }, options, { inplace: false }));
    }

    /** Restore a minimized window before drawing it: a draw that ends while it's collapsed takes the title bar's size. */
    async render(options = {}, _options = {}) {
      if ((this.minimized || this.#restore) && (options === true || options?.force)) {
        const open = this.rendered;
        await this.maximize();
        // Closed while it was being restored: don't open it again.
        if (open && !this.rendered) return this;
      }
      return super.render(options, _options);
    }

    async minimize() {
      if (!this.minimized && this.rendered) {
        const auto = this.options.position ?? {};
        this.#beforeMin = {
          width: auto.width === "auto" ? "auto" : this.position.width,
          height: auto.height === "auto" ? "auto" : this.position.height,
        };
      }
      return super.minimize();
    }

    maximize() {
      // A restore already under way is the one to wait for.
      if (this.#restore) return this.#restore;
      if (!this.minimized) return super.maximize();
      this.#restore = this.#restoreWhole().finally(() => (this.#restore = null));
      return this.#restore;
    }

    async #restoreWhole() {
      const was = this.#beforeMin;
      this.#restoring = true;
      try {
        const pending = super.maximize();
        for (const a of this.element?.getAnimations?.() ?? []) {
          try {
            a.finish();
          } catch {
            /* nothing to finish */
          }
        }
        await pending;
        await settleWindow(this.element);
        // Not if it was closed or minimized again meanwhile.
        if (was && this.rendered && !this.minimized) this.setPosition(was);
      } finally {
        this.#restoring = false;
      }
    }

    /** Remember the size and place the user gives the window (not while it's minimized or being restored). */
    _onPosition(position) {
      super._onPosition?.(position);
      if (!this.rendered || this.minimized || this.#restoring) return;
      if (![position.left, position.top].every(Number.isFinite)) return;
      if (size && !(position.width >= MIN_W)) return;
      if (size === true && !(position.height >= MIN_H)) return;
      save(position);
    }
  };
}

/* ------------------------------------------------------------------ */
/* The store                                                          */
/* ------------------------------------------------------------------ */

/** The markets, checked. Every client can read them (Foundry sends world settings to everyone). */
const store = () => cleanStore(game.settings.get(MOD, "store"));
const marketsSorted = () => store().markets.sort(byMarketOrder);
const marketById = (id) => store().markets.find((m) => m.id === id) ?? null;

/** Change the store (GMs only). Writes run one after another, each on the latest copy. */
let writing = Promise.resolve();
function mutate(fn) {
  if (!game.user.isGM) return Promise.resolve(false);
  writing = writing.then(async () => {
    const data = store();
    if (fn(data) === false) return false;
    await game.settings.set(MOD, "store", cleanStore(data));
    return true;
  }).catch((err) => {
    console.error(`${MOD} | couldn't save the markets`, err);
    ui.notifications.error("Marketplace: couldn't save that change. See the console.");
    return false;
  });
  return writing;
}
const mutateMarket = (id, fn) => mutate((d) => {
  const m = d.markets.find((x) => x.id === id);
  return m ? fn(m, d) : false;
});

/** Actors as plain rows for the shop lists. */
const actorRows = () => game.actors.filter((a) => a.type === "loot").map((a) => ({
  id: a.id, name: a.name, folder: a.folder?.id ?? null, merchant: isMerchant(a), hidden: !!a.getFlag?.(MOD, "hidden") || !!a.flags?.[MOD]?.hidden,
}));
const parentOf = (id) => game.folders.get(id)?.folder?.id ?? null;
const shopsFor = (market) => shopsOf(market, actorRows(), parentOf, game.user.isGM);

/* ------------------------------------------------------------------ */
/* The window                                                         */
/* ------------------------------------------------------------------ */

const openApps = new Set();
let refreshTimer = null;
function refresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    for (const app of openApps) if (app.rendered) app.render();
  }, 100);
}

function loadView() {
  try {
    return JSON.parse(localStorage.getItem(storeKey("view"))) ?? {};
  } catch {
    return {};
  }
}
function saveView(v) {
  try {
    localStorage.setItem(storeKey("view"), JSON.stringify({ market: v.market, shop: v.shop }));
  } catch {
    /* no storage: the view resets on reload */
  }
}

/** Actor folders for the market editor, nested ones indented. */
function actorFolderOptions(selected) {
  const out = [];
  const walk = (parent, depth) => {
    const kids = game.folders.filter((f) => f.type === "Actor" && (f.folder?.id ?? null) === parent).sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
    for (const f of kids) {
      out.push(`<option value="${esc(f.id)}" ${f.id === selected ? "selected" : ""}>${"  ".repeat(depth)}${esc(f.name)}</option>`);
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out.join("");
}

const RARITY = { uncommon: "Uncommon", rare: "Rare", unique: "Unique" };

const Base = rememberWindow(foundry.applications.api.ApplicationV2, `${MOD}.size`);

class MarketApp extends Base {
  static DEFAULT_OPTIONS = {
    id: MOD,
    classes: ["pmk"],
    tag: "div",
    window: { title: "Marketplace", icon: "fa-solid fa-store", resizable: true },
    position: { width: 1000, height: 720 },
    actions: {
      pmkMarket: MarketApp.#onMarket,
      pmkShop: MarketApp.#onShop,
      pmkBack: MarketApp.#onBack,
      pmkItem: MarketApp.#onItem,
      pmkNewMarket: MarketApp.#onNewMarket,
      pmkEditMarket: MarketApp.#onEditMarket,
      pmkDeleteMarket: MarketApp.#onDeleteMarket,
      pmkToggle: MarketApp.#onToggle,
      pmkNewShop: MarketApp.#onNewShop,
      pmkRemoveShop: MarketApp.#onRemoveShop,
      pmkHideShop: MarketApp.#onHideShop,
      pmkSheet: MarketApp.#onSheet,
    },
  };

  constructor(options = {}) {
    super(options);
    const saved = loadView();
    this.view = { market: saved.market ?? null, shop: saved.shop ?? null, query: "", open: new Set() };
    /** Item descriptions, enriched once per item version. */
    this.descs = new Map();
  }

  get isGM() {
    return game.user.isGM;
  }

  /** The markets this user can see. */
  markets() {
    return marketsSorted().filter((m) => canSee(m, this.isGM));
  }

  async _renderHTML() {
    const markets = this.markets();
    let market = markets.find((m) => m.id === this.view.market) ?? null;
    if (!market) {
      market = markets[0] ?? null;
      this.view.shop = null;
    }
    this.view.market = market?.id ?? null;
    const shops = market ? shopsFor(market) : [];
    if (this.view.shop && !shops.some((s) => s.id === this.view.shop)) this.view.shop = null;
    saveView(this.view);

    const rail = markets.map((m) => {
      const marks = this.isGM
        ? `<span class="pmk-marks"><i class="fa-solid ${m.visible ? "fa-eye" : "fa-eye-slash pmk-off"}" data-tooltip="${m.visible ? "Players can see it" : "Hidden from players"}"></i><i class="fa-solid ${m.open ? "fa-store" : "fa-store-slash pmk-off"}" data-tooltip="${m.open ? "Open for trade" : "Not open for trade"}"></i></span>`
        : (m.open ? "" : `<span class="pmk-marks"><i class="fa-solid fa-store-slash pmk-off" data-tooltip="Browse only for now"></i></span>`);
      return `<a class="pmk-mk ${m.id === this.view.market ? "active" : ""}" data-action="pmkMarket" data-id="${esc(m.id)}">
        ${m.img ? `<img src="${esc(m.img)}" alt="">` : `<i class="fa-solid fa-landmark pmk-noimg"></i>`}
        <span class="pmk-mkn">${esc(m.name)}</span>${marks}</a>`;
    }).join("") || `<p class="pmk-none">${this.isGM ? "No markets yet." : "No markets to visit yet."}</p>`;

    let main;
    if (!market) main = this.#emptyHTML();
    else if (this.view.shop) main = await this.#shopHTML(market, game.actors.get(this.view.shop));
    else main = await this.#marketHTML(market, shops);

    return `<div class="pmk-shell">
      <nav class="pmk-rail">
        <div class="pmk-railhead">Markets</div>
        <div class="pmk-mks">${rail}</div>
        ${this.isGM ? `<button type="button" class="pmk-newmk" data-action="pmkNewMarket"><i class="fa-solid fa-plus"></i> New market</button>` : ""}
      </nav>
      <section class="pmk-main">${main}</section>
    </div>`;
  }

  #emptyHTML() {
    return this.isGM
      ? `<div class="pmk-empty"><i class="fa-solid fa-store"></i><p>Make a market to hold your shops: a town's market district, a bazaar, a trading post.</p>
          <button type="button" data-action="pmkNewMarket"><i class="fa-solid fa-plus"></i> New market</button></div>`
      : `<div class="pmk-empty"><i class="fa-solid fa-store"></i><p>There are no markets to visit yet.</p></div>`;
  }

  /** A line saying what players can do here. */
  #statusHTML(market) {
    if (this.isGM) {
      const text = !market.visible ? "Hidden from players." : market.open ? "Players can see it and shop here." : "Players can see and browse it, but not trade.";
      return `<p class="pmk-status ${market.visible && market.open ? "pmk-good" : ""}">${text}</p>`;
    }
    return market.open ? `<p class="pmk-status pmk-good"><i class="fa-solid fa-store"></i> Open for trade.</p>`
      : `<p class="pmk-status"><i class="fa-solid fa-store-slash"></i> You can look around, but you can't trade here right now.</p>`;
  }

  async #marketHTML(market, shops) {
    const desc = market.description ? await TextEditor().enrichHTML(market.description, { secrets: this.isGM }) : "";
    const level = market.level !== null ? `Level ${market.level}` : "";
    const sub = [level, `${shops.length} ${shops.length === 1 ? "shop" : "shops"}`].filter(Boolean).join(" · ");
    const gmBar = this.isGM ? `<div class="pmk-gmbar">
        <button type="button" class="pmk-tog ${market.visible ? "on" : ""}" data-action="pmkToggle" data-what="visible" data-tooltip="Players see and browse this market"><i class="fa-solid ${market.visible ? "fa-eye" : "fa-eye-slash"}"></i> Visible</button>
        <button type="button" class="pmk-tog ${market.open ? "on" : ""}" data-action="pmkToggle" data-what="open" data-tooltip="Players can buy, sell and trade here"><i class="fa-solid ${market.open ? "fa-store" : "fa-store-slash"}"></i> Open</button>
        <span class="pmk-gap"></span>
        <button type="button" data-action="pmkNewShop"><i class="fa-solid fa-plus"></i> New shop</button>
        <button type="button" data-action="pmkEditMarket"><i class="fa-solid fa-pen"></i> Edit</button>
        <button type="button" data-action="pmkDeleteMarket" data-tooltip="Delete this market (its shops stay)"><i class="fa-solid fa-trash"></i></button>
      </div>` : "";
    const folder = market.folder ? game.folders.get(market.folder) : null;
    const cards = shops.map((s) => {
      const actor = game.actors.get(s.id);
      const rows = stockRows(actor);
      const count = rows.length;
      const marks = this.isGM ? [
        s.hidden ? `<i class="fa-solid fa-eye-slash" data-tooltip="Hidden from players"></i>` : "",
        s.byHand ? `<a class="pmk-x" data-action="pmkRemoveShop" data-id="${esc(s.id)}" data-tooltip="Take it out of this market (the merchant stays)"><i class="fa-solid fa-xmark"></i></a>` : "",
      ].join("") : "";
      return `<a class="pmk-shop" data-action="pmkShop" data-id="${esc(s.id)}">
        <img src="${esc(actor?.img ?? "")}" alt="">
        <span class="pmk-shopn">${esc(s.name)}</span>
        <span class="pmk-shops">${count} ${count === 1 ? "item" : "items"}${actorLevel(actor) ? ` · level ${actorLevel(actor)}` : ""}</span>
        ${marks ? `<span class="pmk-shopm">${marks}</span>` : ""}
      </a>`;
    }).join("");
    const none = this.isGM
      ? `<p class="pmk-none">No shops yet. Use New shop, put PF2e merchants in ${folder ? `the folder <strong>${esc(folder.name)}</strong>` : "this market's folder (Edit to choose one)"}, or drag merchants here.</p>`
      : `<p class="pmk-none">No shops here yet.</p>`;
    const hint = this.isGM && shops.length ? `<p class="pmk-hint">${folder ? `Merchants in <strong>${esc(folder.name)}</strong> are this market's shops.` : "This market has no folder."} Drag a merchant here to add one by hand.</p>` : "";
    return `<div class="pmk-market pmk-drop">
      <header class="pmk-mhead">
        ${market.img ? `<img class="pmk-banner" src="${esc(market.img)}" alt="">` : ""}
        <div class="pmk-mtitle"><h2>${esc(market.name)}</h2>${sub ? `<div class="pmk-sub">${esc(sub)}</div>` : ""}</div>
      </header>
      ${gmBar}
      ${this.#statusHTML(market)}
      ${desc ? `<div class="pmk-desc">${desc}</div>` : ""}
      <h3 class="pmk-h">Shops</h3>
      ${shops.length ? `<div class="pmk-shopgrid">${cards}</div>` : none}
      ${hint}
    </div>`;
  }

  async #shopHTML(market, actor) {
    if (!actor) return this.#marketHTML(market, shopsFor(market));
    const rows = stockRows(actor);
    const groups = groupStock(rows, this.view.query);
    const hidden = !!actor.flags?.[MOD]?.hidden;
    const gmBar = this.isGM ? `<div class="pmk-gmbar">
        <button type="button" class="pmk-tog ${hidden ? "" : "on"}" data-action="pmkHideShop" data-tooltip="${hidden ? "Hidden from players, even in a visible market" : "Players see this shop when its market is visible"}"><i class="fa-solid ${hidden ? "fa-eye-slash" : "fa-eye"}"></i> ${hidden ? "Hidden" : "Shown"}</button>
        <span class="pmk-gap"></span>
        <button type="button" data-action="pmkSheet"><i class="fa-solid fa-file-invoice"></i> Merchant sheet</button>
      </div>` : "";
    const list = [];
    for (const [key, label, items] of groups) {
      list.push(`<div class="pmk-gh">${esc(label)} <span class="pmk-count">${items.length}</span></div>`);
      for (const r of items) {
        const open = this.view.open.has(r.id);
        const rar = RARITY[r.rarity] ? `<span class="pmk-rar pmk-${esc(r.rarity)}">${RARITY[r.rarity]}</span>` : "";
        const lvl = `<span class="pmk-lvl">${r.level}</span>`;
        const note = r.holds ? `<span class="pmk-note">holds ${r.holds} ${r.holds === 1 ? "item" : "items"}; not for sale as it is</span>`
          : !r.identified && this.isGM ? `<span class="pmk-note">unidentified on the sheet; players see it, and buy it, identified</span>` : "";
        const price = `${esc(formatCp(r.cp))}${r.per > 1 ? ` <span class="pmk-per">for ${r.per}</span>` : ""}`;
        list.push(`<div class="pmk-row ${open ? "open" : ""} ${r.qty ? "" : "pmk-out"}" data-action="pmkItem" data-id="${esc(r.id)}">
          <img src="${esc(r.img)}" alt="">
          <span class="pmk-rn">${esc(r.name)} ${rar}${note}</span>
          ${lvl}
          <span class="pmk-qty">${r.qty ? `×${r.qty}` : "sold out"}</span>
          <span class="pmk-price">${price}</span>
        </div>`);
        if (open) list.push(`<div class="pmk-rdesc">${await this.#description(actor, r.id) || `<p class="pmk-none">No description.</p>`}</div>`);
      }
      void key;
    }
    const body = rows.length ? (list.length ? list.join("") : `<p class="pmk-none">Nothing here matches "${esc(this.view.query)}".</p>`)
      : `<p class="pmk-none">${this.isGM ? "Nothing in stock. Open the merchant sheet and drag items in from the compendium." : "Nothing in stock."}</p>`;
    return `<div class="pmk-shopview">
      <header class="pmk-shead">
        <a class="pmk-back" data-action="pmkBack"><i class="fa-solid fa-arrow-left"></i> ${esc(market.name)}</a>
        <div class="pmk-stitle"><img src="${esc(actor.img)}" alt=""><div><h2>${esc(actor.name)}</h2>
          <div class="pmk-sub">${rows.length} ${rows.length === 1 ? "item" : "items"}${actorLevel(actor) ? ` · level ${actorLevel(actor)}` : ""}</div></div></div>
      </header>
      ${gmBar}
      ${this.#statusHTML(market)}
      <label class="pmk-search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" name="pmk-q" value="${esc(this.view.query)}" placeholder="Search this shop" autocomplete="off"></label>
      <div class="pmk-stock">
        <div class="pmk-rowhead"><span></span><span>Item</span><span>Level</span><span>Stock</span><span>Price</span></div>
        ${body}
      </div>
    </div>`;
  }

  /** An item's description, enriched once per version of the item. */
  async #description(actor, itemId) {
    const item = actor.items.get(itemId);
    if (!item) return "";
    const key = `${item.uuid}|${item._stats?.modifiedTime ?? 0}`;
    if (!this.descs.has(key)) {
      const html = await TextEditor().enrichHTML(descriptionOf(item), { secrets: this.isGM, rollData: item.getRollData?.(), relativeTo: item });
      this.descs.set(key, html);
    }
    return this.descs.get(key);
  }

  _replaceHTML(result, content) {
    const scroller = content.querySelector(".pmk-main");
    const scroll = scroller?.scrollTop ?? 0;
    const where = scroller?.dataset.where;
    // Someone typing in the search box keeps their place when a change elsewhere redraws the window.
    const typing = document.activeElement?.name === "pmk-q" && content.contains(document.activeElement) ? document.activeElement : null;
    const caret = typing ? [typing.selectionStart, typing.selectionEnd] : null;
    content.innerHTML = result;
    const main = content.querySelector(".pmk-main");
    if (main) {
      main.dataset.where = `${this.view.market}|${this.view.shop}`;
      if (where === main.dataset.where) main.scrollTop = scroll;
    }
    if (typing) {
      const input = content.querySelector('input[name="pmk-q"]');
      input?.focus();
      if (caret) input?.setSelectionRange(...caret);
    }
  }

  _onFirstRender() {
    openApps.add(this);
  }

  _onClose() {
    openApps.delete(this);
  }

  _onRender() {
    const input = this.element.querySelector('input[name="pmk-q"]');
    input?.addEventListener("input", () => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        this.view.query = input.value;
        this.render();
      }, 200);
    });
    // GM: drag a merchant onto a market page to add it to the market by hand.
    const drop = this.element.querySelector(".pmk-drop");
    if (drop && this.isGM) {
      drop.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        drop.classList.add("pmk-dropping");
      });
      drop.addEventListener("dragleave", (ev) => {
        if (!drop.contains(ev.relatedTarget)) drop.classList.remove("pmk-dropping");
      });
      drop.addEventListener("drop", (ev) => {
        drop.classList.remove("pmk-dropping");
        this.#onDropActor(ev);
      });
    }
  }

  async #onDropActor(event) {
    event.preventDefault();
    const data = TextEditor().getDragEventData(event);
    if (data?.type !== "Actor" || !data.uuid) return;
    const actor = await fromUuid(data.uuid);
    if (!actor || actor.pack) return void ui.notifications.warn("Marketplace: drag a merchant from the Actors tab (import a compendium actor first).");
    if (!isMerchant(actor)) return void ui.notifications.warn("Marketplace: only PF2e merchants can be shops: a loot actor with its sheet set to Merchant.");
    const id = this.view.market;
    await mutateMarket(id, (m) => {
      if (m.extra.includes(actor.id)) return false;
      m.extra.push(actor.id);
    });
  }

  static open(marketId = null, shopId = null) {
    const app = [...openApps][0] ?? new MarketApp();
    if (marketId) {
      app.view.market = marketId;
      app.view.shop = shopId;
      app.view.query = "";
    }
    app.render({ force: true });
    return app;
  }

  /* ---------------- Actions ---------------- */

  static #onMarket(event, target) {
    this.view.market = target.dataset.id;
    this.view.shop = null;
    this.view.query = "";
    this.render();
  }

  static #onShop(event, target) {
    // The remove button on a card isn't a click on the card.
    if (event.target.closest(".pmk-x")) return;
    this.view.shop = target.dataset.id;
    this.view.query = "";
    this.view.open = new Set();
    this.render();
  }

  static #onBack() {
    this.view.shop = null;
    this.view.query = "";
    this.render();
  }

  static #onItem(event, target) {
    const id = target.dataset.id;
    if (this.view.open.has(id)) this.view.open.delete(id);
    else this.view.open.add(id);
    this.render();
  }

  static async #onNewMarket() {
    if (!this.isGM) return;
    const data = await marketDialog(null);
    if (!data) return;
    const id = foundry.utils.randomID(16);
    let folder = data.folder;
    if (folder === "_new") folder = (await Folder.create({ name: data.name, type: "Actor" }))?.id ?? null;
    await mutate((d) => {
      const sort = Math.max(0, ...d.markets.map((m) => m.sort)) + 1;
      d.markets.push({ id, name: data.name, img: data.img, description: data.description, level: data.level, folder, extra: [], visible: false, open: false, sort, created: Date.now() });
    });
    this.view.market = id;
    this.view.shop = null;
    this.render();
  }

  static async #onEditMarket() {
    if (!this.isGM) return;
    const market = marketById(this.view.market);
    if (!market) return;
    const data = await marketDialog(market);
    if (!data) return;
    let folder = data.folder;
    if (folder === "_new") folder = (await Folder.create({ name: data.name, type: "Actor" }))?.id ?? null;
    await mutateMarket(market.id, (m) => {
      Object.assign(m, { name: data.name, img: data.img, description: data.description, level: data.level, folder });
    });
  }

  static async #onDeleteMarket() {
    if (!this.isGM) return;
    const market = marketById(this.view.market);
    if (!market) return;
    const ok = await DialogV2().confirm({
      window: { title: "Delete market" },
      classes: ["pmk-dialog"],
      content: `<p>Delete the market <strong>${esc(market.name)}</strong>? Its merchants and their folder stay; only the market goes.</p>`,
      rejectClose: false,
    });
    if (!ok) return;
    await mutate((d) => {
      d.markets = d.markets.filter((m) => m.id !== market.id);
    });
    this.view.market = null;
    this.view.shop = null;
  }

  static async #onToggle(event, target) {
    if (!this.isGM) return;
    const what = target.dataset.what;
    if (what !== "visible" && what !== "open") return;
    await mutateMarket(this.view.market, (m) => {
      m[what] = !m[what];
      // Open for trade means players can see it too.
      if (what === "open" && m.open) m.visible = true;
      if (what === "visible" && !m.visible) m.open = false;
    });
  }

  static async #onNewShop() {
    if (!this.isGM) return;
    const market = marketById(this.view.market);
    if (!market) return;
    const name = await DialogV2().prompt({
      window: { title: "New shop", icon: "fa-solid fa-shop" },
      classes: ["pmk-dialog"],
      content: `<div class="pmk-form"><label>Name <input type="text" name="name" placeholder="Edric's Arms and Armor" autofocus></label>
        <p class="pmk-hint">A PF2e merchant is made in this market's folder and its sheet opens, so you can drag in its stock.</p></div>`,
      ok: { label: "Make it", icon: "fa-solid fa-check", callback: (event, button) => button.form.elements.name.value.trim() },
      rejectClose: false,
    });
    if (!name) return;
    let folder = market.folder && game.folders.get(market.folder) ? market.folder : null;
    if (!folder) {
      folder = (await Folder.create({ name: market.name, type: "Actor" }))?.id ?? null;
      if (folder) await mutateMarket(market.id, (m) => void (m.folder = folder));
    }
    const actor = await Actor.create(merchantData(String(name).slice(0, 120), folder));
    if (!actor) return;
    this.view.shop = actor.id;
    this.render();
    actor.sheet.render(true);
  }

  static async #onRemoveShop(event, target) {
    if (!this.isGM) return;
    const id = target.dataset.id;
    await mutateMarket(this.view.market, (m) => {
      if (!m.extra.includes(id)) return false;
      m.extra = m.extra.filter((x) => x !== id);
    });
  }

  static async #onHideShop() {
    if (!this.isGM) return;
    const actor = game.actors.get(this.view.shop);
    if (!actor) return;
    await actor.update({ [`flags.${MOD}.hidden`]: !actor.flags?.[MOD]?.hidden });
  }

  static #onSheet() {
    game.actors.get(this.view.shop)?.sheet.render(true);
  }
}

/** The GM's form for a market. Resolves to the fields, or null when canceled. */
async function marketDialog(market) {
  const m = market ?? { name: "", img: "", description: "", level: null, folder: "_new" };
  const editor = foundry.applications.elements.HTMLProseMirrorElement.create({ name: "description", value: m.description ?? "", toggled: false, height: 180 });
  const data = await DialogV2().wait({
    window: { title: market ? "Edit market" : "New market", icon: "fa-solid fa-landmark" },
    classes: ["pmk-dialog"],
    position: { width: 560 },
    content: `<div class="pmk-form">
      <label>Name <input type="text" name="name" value="${esc(m.name)}" placeholder="Harbor Market" autofocus></label>
      <label>Picture <span class="pmk-pick"><input type="text" name="img" value="${esc(m.img)}" placeholder="A banner or map of the market"><button type="button" class="pmk-browse" data-tooltip="Browse"><i class="fa-solid fa-file-image"></i></button></span></label>
      <label>Level <input type="number" name="level" value="${m.level ?? ""}" min="-1" max="30" step="1" placeholder="none"></label>
      <label>Merchant folder <select name="folder">
        <option value="">(none: add shops by hand)</option>
        <option value="_new" ${m.folder === "_new" ? "selected" : ""}>A new folder named after the market</option>
        ${actorFolderOptions(m.folder)}
      </select></label>
      <p class="pmk-hint">Every PF2e merchant in this folder (and the folders inside it) is a shop in the market.</p>
      <div class="pmk-field">Description ${editor.outerHTML}</div>
    </div>`,
    render: (event, dialog) => {
      const root = dialog.element ?? event?.target?.element;
      root?.querySelector(".pmk-browse")?.addEventListener("click", () => {
        const input = root.querySelector('input[name="img"]');
        const FP = foundry.applications.apps.FilePicker.implementation;
        new FP({ type: "image", current: input.value, callback: (path) => (input.value = path) }).render(true);
      });
    },
    buttons: [
      { action: "ok", label: market ? "Save" : "Make it", icon: "fa-solid fa-check", default: true, callback: (event, button) => {
        const e = button.form.elements;
        const level = e.level.value === "" ? null : Number(e.level.value);
        return { name: e.name.value.trim().slice(0, 120) || "Market", img: e.img.value.trim(), level, folder: e.folder.value || null, description: e.description.value ?? "" };
      } },
      { action: "cancel", label: "Cancel" },
    ],
    rejectClose: false,
  });
  if (!data || typeof data !== "object") return null;
  const checked = cleanMarket({ id: "x", ...data, folder: data.folder === "_new" ? null : data.folder });
  return { ...checked, folder: data.folder === "_new" ? "_new" : checked.folder };
}

/* ------------------------------------------------------------------ */
/* Registration                                                       */
/* ------------------------------------------------------------------ */

/** A Marketplace button at the top of the Actors tab. */
function addDirectoryButton(app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector(".pmk-open")) return;
  const bar = root.querySelector(".header-actions") ?? root.querySelector(".directory-header");
  if (!bar) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pmk-open";
  btn.innerHTML = `<i class="fa-solid fa-store"></i> Marketplace`;
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    MarketApp.open();
  });
  bar.append(btn);
}

Hooks.once("init", () => {
  game.settings.register(MOD, "store", {
    scope: "world", config: false, type: Object, default: { markets: [] },
    onChange: () => refresh(),
  });
  try {
    game.keybindings.register(MOD, "open", {
      name: "Open the Marketplace",
      hint: "Opens the marketplace window, or brings it to the front.",
      editable: [],
      onDown: () => {
        MarketApp.open();
        return true;
      },
    });
  } catch (err) {
    console.warn(`${MOD} | the hotkey couldn't be registered`, err);
  }
});

Hooks.once("ready", () => {
  game.modules.get(MOD).api = { open: (marketId, shopId) => MarketApp.open(marketId, shopId), markets: () => store().markets, refresh };
  const dir = ui.actors ?? ui.sidebar?.tabs?.actors;
  if (dir?.element) addDirectoryButton(dir, dir.element);
});
Hooks.on("renderActorDirectory", addDirectoryButton);

/* Anything that changes what a shop or market shows redraws the window. */
const lootActor = (a) => a?.type === "loot";
for (const hook of ["createActor", "updateActor", "deleteActor"]) Hooks.on(hook, (a) => lootActor(a) && refresh());
for (const hook of ["createItem", "updateItem", "deleteItem"]) Hooks.on(hook, (item) => lootActor(item.parent) && refresh());
for (const hook of ["createFolder", "updateFolder", "deleteFolder"]) Hooks.on(hook, (f) => f.type === "Actor" && refresh());
