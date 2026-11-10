/**
 * PF2e Marketplace
 * A marketplace window over PF2e's own merchants: markets (a name, picture, description and the shops in them),
 * browsed without opening merchant sheets. Shops stay ordinary PF2e merchant loot actors, so they keep working as
 * merchant sheets without the module.
 */

import { esc, cleanStore, cleanMarket, byMarketOrder, canSee, canTrade, shopsOf, formatCp, priceFor, groupStock, cleanLines, addToCart, listOf } from "./helpers.mjs";
import {
  isMerchant, actorLevel, stockRows, descriptionOf, merchantData, realItem, priceOf, sellable, quantityOf, fundsCp, pay, receive,
  boughtCopy, giveItems, takeFromStock, buyersFor,
} from "./pf2e.mjs";

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

/** A market where this user may trade with this shop (null if none): it must be open, and the shop not hidden from
 * them. GMs can trade anywhere. */
function tradeMarketFor(shopId, user) {
  const rows = actorRows();
  return store().markets.find((m) => canTrade(m, user.isGM) && shopsOf(m, rows, parentOf, user.isGM).some((s) => s.id === shopId)) ?? null;
}

/* ------------------------------------------------------------------ */
/* The cart (per user, in this browser)                               */
/* ------------------------------------------------------------------ */

function loadCart() {
  try {
    const v = JSON.parse(localStorage.getItem(storeKey("cart"))) ?? {};
    return { lines: cleanLines(v.lines), buyer: typeof v.buyer === "string" ? v.buyer : null };
  } catch {
    return { lines: [], buyer: null };
  }
}
function saveCart(cart) {
  try {
    localStorage.setItem(storeKey("cart"), JSON.stringify({ lines: cleanLines(cart.lines), buyer: cart.buyer }));
  } catch {
    /* no storage: the cart lasts until reload */
  }
}

/** The actors this user can buy for, and the one chosen (their own character first). */
function buyerChoices(cart) {
  const list = buyersFor(game.user, game.actors.contents).sort((a, b) => (a.type === "party") - (b.type === "party") || a.name.localeCompare(b.name));
  const chosen = list.find((a) => a.id === cart.buyer) ?? list.find((a) => a.id === game.user.character?.id) ?? list[0] ?? null;
  return { list, chosen };
}

/** What each cart line is now: its shop, item, price and anything wrong with it. */
function cartState(lines) {
  return lines.map((l) => {
    const shop = game.actors.get(l.shop);
    const item = isMerchant(shop) ? shop.items.get(l.item) : null;
    const stock = item ? quantityOf(item) : 0;
    const { cp, per } = item ? priceOf(item) : { cp: 0, per: 1 };
    const market = shop ? tradeMarketFor(shop.id, game.user) : null;
    let problem = null;
    if (!shop || !isMerchant(shop)) problem = "This shop is gone.";
    else if (!item || !sellable(item)) problem = "No longer for sale.";
    else if (!market) problem = "This shop isn't open for trade right now.";
    else if (stock < l.qty) problem = stock ? `Only ${stock} left.` : "Sold out.";
    return { ...l, shopDoc: shop, itemDoc: item, stock, cp, per, price: priceFor(cp, per, l.qty), market, problem };
  });
}

/* ------------------------------------------------------------------ */
/* Trading through the GM's client                                    */
/* ------------------------------------------------------------------ */

const SOCKET = `module.${MOD}`;
const isPrimaryGM = () => game.user.isGM && game.users.activeGM?.id === game.user.id;

/* Foundry's active GM is a user, not a browser tab, so the same GM in two tabs would act twice. Each GM tab gets an
 * id and tells the others about itself; only the tab with the lowest id among the primary GM's live tabs acts. A
 * hidden tab's timers can slow to about once a minute, so a tab is forgotten only after 150 s without a word, and each
 * tab answers an announcement from a tab with a higher id (socket messages aren't slowed). */
const CLIENT_ID = globalThis.foundry?.utils?.randomID?.(16) ?? Math.random().toString(36).slice(2, 18);
const gmTabs = new Map();
const TAB_TTL = 150000;
let lastAnswer = 0;
function iAmLeader() {
  if (!isPrimaryGM()) return false;
  const now = Date.now();
  for (const [id, seen] of gmTabs) if (now - seen > TAB_TTL) gmTabs.delete(id);
  return [...gmTabs.keys()].every((id) => CLIENT_ID < id);
}
function announceTab(hello = false) {
  if (game.user.isGM) game.socket.emit(SOCKET, { type: "gmtab", client: CLIENT_ID, hello });
}

/** Requests waiting for the GM's answer. */
const pending = new Map();
function askGM(msg) {
  if (!game.users.activeGM) {
    ui.notifications.warn("Marketplace: a GM needs to be logged in to trade.");
    return false;
  }
  const rid = foundry.utils.randomID(12);
  pending.set(rid, setTimeout(() => {
    pending.delete(rid);
    ui.notifications.warn("Marketplace: the GM's client didn't answer. Check your inventory, then try again.");
    refresh();
  }, 20000));
  game.socket.emit(SOCKET, { ...msg, rid });
  return rid;
}
function answered(rid) {
  if (!rid || !pending.has(rid)) return false;
  clearTimeout(pending.get(rid));
  pending.delete(rid);
  return true;
}

/** A trade that can't go ahead (the user is told why). */
class Refused extends Error {}

/** Trades run one at a time on the GM's client, so two buyers can't both take the last one. */
let tradeQueue = Promise.resolve();
function queued(fn) {
  const run = tradeQueue.then(fn);
  tradeQueue = run.catch(() => null);
  return run;
}

/**
 * Buy a cart (on the GM's client, or a GM's own). Everything is checked before anything moves: the buyer is the
 * sender's to buy for, each shop is open to them, each item is for sale in that quantity, the total matches what the
 * buyer saw, and the buyer can pay. Then the buyer pays, gets the items, and each shop's stock and coins change.
 */
async function processBuy(msg, sender) {
  const lines = cleanLines(msg.lines);
  if (!lines.length) throw new Refused("the cart is empty.");
  const buyer = game.actors.get(String(msg.buyer ?? ""));
  if (!buyer || !buyersFor(sender, [buyer]).length) throw new Refused("you can't buy for that character.");
  const plan = [];
  let total = 0;
  for (const l of lines) {
    const shop = game.actors.get(l.shop);
    if (!isMerchant(shop)) throw new Refused("a shop in the cart is gone.");
    if (!tradeMarketFor(shop.id, sender)) throw new Refused(`${shop.name} isn't open for trade.`);
    const item = shop.items.get(l.item);
    if (!item || !sellable(item)) throw new Refused(`something in the cart from ${shop.name} isn't for sale any more.`);
    if (l.qty > quantityOf(item)) throw new Refused(`${shop.name} has only ${quantityOf(item)} of ${realItem(item).name}.`);
    const { cp, per } = priceOf(item);
    const price = priceFor(cp, per, l.qty);
    plan.push({ shop, item, qty: l.qty, price, name: realItem(item).name });
    total += price;
  }
  if (Number(msg.total) !== total) throw new Refused("prices or stock changed since you looked. Check the cart and try again.");
  if (fundsCp(buyer) < total) throw new Refused(`${buyer.name} hasn't enough money: it costs ${formatCp(total)}.`);
  if (!(await pay(buyer, total))) throw new Refused(`${buyer.name} hasn't enough money: it costs ${formatCp(total)}.`);
  try {
    await giveItems(buyer, plan.map((p) => boughtCopy(p.item, p.qty)));
  } catch (err) {
    // Nothing was handed over: give the money back.
    await receive(buyer, total).catch(() => null);
    throw err;
  }
  const byShop = new Map();
  for (const p of plan) byShop.set(p.shop.id, [...(byShop.get(p.shop.id) ?? []), p]);
  for (const group of byShop.values()) {
    for (const p of group) await takeFromStock(p.item, p.qty);
    await receive(group[0].shop, group.reduce((n, p) => n + p.price, 0));
  }
  return { buyer: buyer.name, total, names: plan.map((p) => (p.qty > 1 ? `${p.name} ×${p.qty}` : p.name)), lines };
}

/** What a trade's buyer is told, and what the GM sees when a player bought. */
const boughtText = (r) => `${r.buyer} bought ${listOf(r.names)} for ${formatCp(r.total)}.`;

/** The cart's lines that were bought come out of it. */
function clearBought(lines) {
  const cart = loadCart();
  const gone = new Set(lines.map((l) => `${l.shop}.${l.item}`));
  cart.lines = cart.lines.filter((l) => !gone.has(`${l.shop}.${l.item}`));
  saveCart(cart);
  refresh();
}

/** The active GM's client acts on a player's request. */
async function onRequest(msg, sender) {
  const reply = (extra) => game.socket.emit(SOCKET, { users: [sender.id], rid: typeof msg.rid === "string" ? msg.rid : null, ...extra });
  try {
    if (msg.type === "buy") {
      const r = await queued(() => processBuy(msg, sender));
      reply({ type: "done", what: "buy", text: boughtText(r), lines: r.lines });
      ui.notifications.info(esc(`Marketplace: ${sender.name}: ${boughtText(r)}`));
    }
  } catch (err) {
    if (err instanceof Refused) return reply({ type: "fail", text: `Marketplace: ${err.message}` });
    console.error(`${MOD} | a player's trade failed`, err);
    reply({ type: "fail", text: `Marketplace: that didn't work (${err.message}). Check your inventory.` });
    ui.notifications.error(`Marketplace: a trade by ${esc(sender.name)} failed partway. See the console.`);
  }
}

/** Socket messages: the GM's lead tab takes players' requests; a player's client takes the GM's answers. Foundry
 * passes the sender's id. */
function onSocket(msg, senderId) {
  if (!msg?.type) return;
  const sender = game.users.get(senderId);
  if (game.user.isGM) {
    if (msg.type === "gmtab" && sender?.id === game.user.id && typeof msg.client === "string") {
      gmTabs.set(msg.client, Date.now());
      if (msg.hello || (msg.client > CLIENT_ID && Date.now() - lastAnswer > 5000)) {
        lastAnswer = Date.now();
        announceTab(false);
      }
    } else if (msg.type === "gmbye" && sender?.id === game.user.id) gmTabs.delete(msg.client);
    else if (sender && !sender.isGM && msg.type === "buy" && iAmLeader()) onRequest(msg, sender);
    return;
  }
  if (!sender?.isGM) return;
  if (Array.isArray(msg.users) && !msg.users.includes(game.user.id)) return;
  if (msg.type !== "done" && msg.type !== "fail") return;
  // Only answers to this client's own requests (a GM answers the user, who may have two windows open).
  if (!answered(msg.rid)) return;
  if (msg.type === "fail") {
    ui.notifications.warn(esc(String(msg.text ?? "Marketplace: that didn't work.")));
    return refresh();
  }
  if (msg.what === "buy") {
    clearBought(cleanLines(msg.lines));
    ui.notifications.info(esc(`Marketplace: ${String(msg.text ?? "Bought.")}`));
  }
}

/** Check out: a GM buys at once; a player asks the GM's client. */
let buying = false;
async function checkout() {
  if (buying) return;
  const cart = loadCart();
  const { chosen } = buyerChoices(cart);
  const state = cartState(cart.lines);
  if (!chosen) return void ui.notifications.warn("Marketplace: you have no character to buy for.");
  if (!state.length) return;
  const bad = state.find((l) => l.problem);
  if (bad) return void ui.notifications.warn(`Marketplace: fix the cart first: ${bad.problem}`);
  const total = state.reduce((n, l) => n + l.price, 0);
  if (fundsCp(chosen) < total) return void ui.notifications.warn(esc(`Marketplace: ${chosen.name} hasn't enough money.`));
  const msg = { type: "buy", buyer: chosen.id, lines: cart.lines, total };
  if (game.user.isGM) {
    buying = true;
    try {
      const r = await queued(() => processBuy(msg, game.user));
      clearBought(r.lines);
      ui.notifications.info(esc(`Marketplace: ${boughtText(r)}`));
    } catch (err) {
      if (err instanceof Refused) ui.notifications.warn(esc(`Marketplace: ${err.message}`));
      else {
        console.error(`${MOD} | buying failed`, err);
        ui.notifications.error("Marketplace: buying failed partway. See the console.");
      }
    } finally {
      buying = false;
      refresh();
    }
    return;
  }
  if (askGM(msg)) {
    buying = true;
    setTimeout(() => (buying = false), 1500);
  }
}

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
      pmkAdd: MarketApp.#onAdd,
      pmkCart: MarketApp.#onCart,
      pmkCartBack: MarketApp.#onCartBack,
      pmkCartRemove: MarketApp.#onCartRemove,
      pmkCheckout: MarketApp.#onCheckout,
    },
  };

  constructor(options = {}) {
    super(options);
    const saved = loadView();
    this.view = { market: saved.market ?? null, shop: saved.shop ?? null, cart: false, query: "", open: new Set() };
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

    const cart = loadCart();
    let main;
    if (this.view.cart) main = this.#cartHTML(cart);
    else if (!market) main = this.#emptyHTML();
    else if (this.view.shop) main = await this.#shopHTML(market, game.actors.get(this.view.shop));
    else main = await this.#marketHTML(market, shops);

    return `<div class="pmk-shell">
      <nav class="pmk-rail">
        <div class="pmk-railhead">Markets</div>
        <div class="pmk-mks">${rail}</div>
        <a class="pmk-mk pmk-cartlink ${this.view.cart ? "active" : ""}" data-action="pmkCart"><i class="fa-solid fa-cart-shopping pmk-noimg"></i><span class="pmk-mkn">Cart</span>${cart.lines.length ? `<span class="pmk-count">${cart.lines.length}</span>` : ""}</a>
        ${this.isGM ? `<button type="button" class="pmk-newmk" data-action="pmkNewMarket"><i class="fa-solid fa-plus"></i> <span>New market</span></button>` : ""}
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
    const trade = canTrade(market, this.isGM);
    const inCart = new Map(loadCart().lines.filter((l) => l.shop === actor.id).map((l) => [l.item, l.qty]));
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
          ${this.#addHTML(r, trade, inCart.get(r.id) ?? 0)}
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
        <div class="pmk-rowhead"><span></span><span>Item</span><span>Level</span><span>Stock</span><span>Price</span><span></span></div>
        ${body}
      </div>
    </div>`;
  }

  /** The add-to-cart button for a stock row: only where this user can trade, for something in stock and for sale. */
  #addHTML(r, trade, have) {
    if (!trade || !r.qty || r.holds) return `<span class="pmk-add"></span>`;
    const full = have >= r.qty;
    const tip = full ? "All of it is in your cart" : r.per > 1 ? `Add ${Math.min(r.per, r.qty - have)} to the cart` : "Add to the cart";
    return `<span class="pmk-add"><a class="pmk-addbtn ${full ? "pmk-full" : ""}" data-action="pmkAdd" data-id="${esc(r.id)}" data-tooltip="${esc(tip)}"><i class="fa-solid fa-cart-plus"></i>${have ? `<span class="pmk-have">${have}</span>` : ""}</a></span>`;
  }

  /** The cart: who's buying, what's in it by shop, the total and what's left after paying. */
  #cartHTML(cart) {
    const { list, chosen } = buyerChoices(cart);
    const state = cartState(cart.lines);
    const back = `<a class="pmk-back" data-action="pmkCartBack"><i class="fa-solid fa-arrow-left"></i> Back to the market</a>`;
    if (!state.length) {
      return `<div class="pmk-cartview"><header class="pmk-shead">${back}<h2>Cart</h2></header>
        <p class="pmk-none">The cart is empty. Add things from a shop with <i class="fa-solid fa-cart-plus"></i>.</p></div>`;
    }
    const total = state.reduce((n, l) => n + l.price, 0);
    const have = chosen ? fundsCp(chosen) : 0;
    const groups = new Map();
    for (const l of state) groups.set(l.shop, [...(groups.get(l.shop) ?? []), l]);
    const body = [...groups.values()].map((lines) => {
      const shop = lines[0].shopDoc;
      const where = lines[0].market ? ` <span class="pmk-dim">${esc(lines[0].market.name)}</span>` : "";
      return `<div class="pmk-gh">${esc(shop?.name ?? "A shop that's gone")}${where}</div>` + lines.map((l) => {
        const real = l.itemDoc ? realItem(l.itemDoc) : { name: "Gone", img: "" };
        const max = Math.max(1, l.stock);
        return `<div class="pmk-crow ${l.problem ? "pmk-bad" : ""}">
          <img src="${esc(real.img)}" alt="">
          <span class="pmk-rn">${esc(real.name)}${l.problem ? `<span class="pmk-note pmk-warn">${esc(l.problem)}</span>` : ""}</span>
          <input type="number" class="pmk-qtyin" name="pmk-qty" data-shop="${esc(l.shop)}" data-item="${esc(l.item)}" value="${l.qty}" min="1" max="${max}" step="1">
          <span class="pmk-price">${esc(formatCp(l.price))}</span>
          <a class="pmk-x" data-action="pmkCartRemove" data-shop="${esc(l.shop)}" data-item="${esc(l.item)}" data-tooltip="Take it out of the cart"><i class="fa-solid fa-xmark"></i></a>
        </div>`;
      }).join("");
    }).join("");
    const buyers = list.map((a) => `<option value="${esc(a.id)}" ${a.id === chosen?.id ? "selected" : ""}>${esc(a.name)}${a.type === "party" ? " (party stash)" : ""}: ${esc(formatCp(fundsCp(a), "no money"))}</option>`).join("");
    const short = chosen && have < total;
    const bad = state.some((l) => l.problem);
    const noGM = !this.isGM && !game.users.activeGM;
    const why = !chosen ? "You have no character to buy for." : noGM ? "A GM needs to be logged in to trade." : bad ? "Fix the lines marked above first." : short ? `${esc(chosen.name)} is ${esc(formatCp(total - have))} short.` : "";
    return `<div class="pmk-cartview">
      <header class="pmk-shead">${back}<h2>Cart</h2></header>
      <label class="pmk-buyer">Buying for ${list.length ? `<select name="pmk-buyer">${buyers}</select>` : `<em>no character</em>`}</label>
      <div class="pmk-stock">${body}</div>
      <div class="pmk-total">
        <div><span>Total</span><strong>${esc(formatCp(total))}</strong></div>
        ${chosen ? `<div class="pmk-dim"><span>${esc(chosen.name)} has</span><span>${esc(formatCp(have, "no money"))}</span></div>
        <div class="${short ? "pmk-warn" : "pmk-dim"}"><span>Left after</span><span>${short ? "not enough" : esc(formatCp(have - total, "nothing"))}</span></div>` : ""}
      </div>
      ${why ? `<p class="pmk-status">${why}</p>` : ""}
      <div class="pmk-checkout"><button type="button" data-action="pmkCheckout" ${why ? "disabled" : ""}><i class="fa-solid fa-coins"></i> Buy for ${esc(formatCp(total))}</button></div>
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
    for (const q of this.element.querySelectorAll('input[name="pmk-qty"]')) {
      q.addEventListener("change", () => {
        const cart = loadCart();
        const line = cart.lines.find((l) => l.shop === q.dataset.shop && l.item === q.dataset.item);
        if (!line) return;
        line.qty = Math.max(1, Math.min(Math.floor(Number(q.value)) || 1, Number(q.max) || 1));
        saveCart(cart);
        this.render();
      });
    }
    this.element.querySelector('select[name="pmk-buyer"]')?.addEventListener("change", (ev) => {
      const cart = loadCart();
      cart.buyer = ev.target.value;
      saveCart(cart);
      this.render();
    });
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
      app.view.cart = false;
      app.view.market = marketId;
      app.view.shop = shopId;
      app.view.query = "";
    }
    app.render({ force: true });
    return app;
  }

  /* ---------------- Actions ---------------- */

  static #onMarket(event, target) {
    this.view.cart = false;
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
    this.view.cart = false;
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

  static #onAdd(event, target) {
    const actor = game.actors.get(this.view.shop);
    const item = actor?.items.get(target.dataset.id);
    if (!item || !sellable(item)) return;
    const market = marketById(this.view.market);
    if (!canTrade(market, this.isGM)) return void ui.notifications.warn("Marketplace: this market isn't open for trade right now.");
    const cart = loadCart();
    const { per } = priceOf(item);
    cart.lines = addToCart(cart.lines, actor.id, item.id, per, quantityOf(item));
    saveCart(cart);
    this.render();
  }

  static #onCart() {
    this.view.cart = true;
    this.render();
  }

  static #onCartBack() {
    this.view.cart = false;
    this.render();
  }

  static #onCartRemove(event, target) {
    const cart = loadCart();
    cart.lines = cart.lines.filter((l) => !(l.shop === target.dataset.shop && l.item === target.dataset.item));
    saveCart(cart);
    this.render();
  }

  static #onCheckout() {
    checkout();
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
  game.modules.get(MOD).api = { open: (marketId, shopId) => MarketApp.open(marketId, shopId), markets: () => store().markets, refresh, gmTabInfo: () => ({ me: CLIENT_ID, others: [...gmTabs.keys()], leader: iAmLeader() }) };
  game.socket.on(SOCKET, onSocket);
  if (game.user.isGM) {
    announceTab(true);
    setInterval(() => announceTab(false), 15000);
    window.addEventListener("beforeunload", () => game.socket.emit(SOCKET, { type: "gmbye", client: CLIENT_ID }));
  }
  const dir = ui.actors ?? ui.sidebar?.tabs?.actors;
  if (dir?.element) addDirectoryButton(dir, dir.element);
});
Hooks.on("renderActorDirectory", addDirectoryButton);

/* Anything that changes what a shop or market shows redraws the window. */
const lootActor = (a) => a?.type === "loot";
for (const hook of ["createActor", "updateActor", "deleteActor"]) Hooks.on(hook, (a) => lootActor(a) && refresh());
// Shops' stock, and the money and goods of anyone this user buys for (the cart shows what they have).
const watched = (a) => lootActor(a) || ((a?.type === "character" || a?.type === "party") && a.isOwner);
for (const hook of ["createItem", "updateItem", "deleteItem"]) Hooks.on(hook, (item) => watched(item.parent) && refresh());
// Players logging in or out changes whether a GM is there to trade with.
Hooks.on("userConnected", () => refresh());
for (const hook of ["createFolder", "updateFolder", "deleteFolder"]) Hooks.on(hook, (f) => f.type === "Actor" && refresh());
