import { MAX_LINES, SHOP_KINDS, STOCK_SORTS, addSale, addToCart, canAccept, canSee, cleanOffer, cleanStock, esc, nextStockKind, sourceKey, takeFromCart, takeSale } from "./helpers.mjs";
import { formulaUuid, hasParts, isMerchant, isTreasure, merchantData, quantityOf, realItem, sellRows, sellable, setLevel } from "./pf2e.mjs";
import { keyboardWindow } from "./kit/keyboard.mjs";
import { rememberWindow } from "./kit/window-memory.mjs";
import { singleWindow } from "./kit/single-window.mjs";
import { L, Lh, MOD, TextEditor, fmt, notice, store } from "./constants.mjs";
import { buyerChoices, syncReputation, fillPurse, formulaMults, isFormulaItem, itemLevel, itemPrice, itemRarity, loadCart, marketById, marketsSorted, mutate, mutateMarket, noteSeen, openToPlayers, salesOf, saveCart, shopsFor, tradeMarketFor } from "./data.mjs";
import { addItemDialog, addMerchantDialog, confirmDialog, drawStockDialog, formulaPriceDialog, marketDialog, newShopDialog, restockDialog, shopSettingsDialog, stapleQtyDialog } from "./dialogs.mjs";
import { startHaggle } from "./haggle.mjs";
import { offers, tradersFor } from "./post.mjs";
import { openApps } from "./refresh.mjs";
import { checkout, postRequest } from "./requests.mjs";
import { formulaPrice, rules } from "./rules.mjs";
import { restockMarket, restockShop } from "./stock.mjs";
import { cartHTML, logHTML, postHTML, readDraft, readVault, vaultHTML } from "./view-pages.mjs";
import { describe, icon, marketHTML, shopHTML } from "./view-shop.mjs";
import { isVault } from "./vault.mjs";

/** Open a shop item's sheet. The GM gets the real item; a player gets a read-only copy of it as the shop sells it
 * (identified), since players can't open a merchant's items. */
function showShopItem(shop, itemId, isGM) {
  const item = shop?.items.get(itemId);
  if (!item) return;
  // PF2e's item sheets are V1 Applications: render(true).
  if (isGM) return void item.sheet.render(true);
  const data = item.toObject();
  delete data._id;
  if (data.system?.identification) data.system.identification.status = "identified";
  data.ownership = { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER };
  const copy = new CONFIG.Item.documentClass(data);
  copy.sheet.render(true, { editable: false });
}

const LOOKS = ["dark", "hybrid", "pf2e"];
const SHEET_COLORS = ["red", "green", "blue", "purple", "brown", "black"];
/** The look this user picked for their window (kept in this browser). */
function getLook() {
  const v = store.get("look", "dark");
  return LOOKS.includes(v) ? v : "dark";
}

/** Use a look in this user's window. */
function setLook(app, look) {
  store.set("look", look);
  app.look = look;
  app.render();
}

/** Pick the Pathfinder sheet look's color (a client setting); the color shows in that look, so it switches to it. */
async function setColor(app, color) {
  await game.settings.set(MOD, "sheetColor", color);
  if ((app.look ?? getLook()) !== "pf2e") setLook(app, "pf2e");
  else app.render();
}

/** A fresh view: the page shown and what's picked on it. */
const freshView = (saved = {}) => ({ market: saved.market ?? null, shop: saved.shop ?? null, cart: false, log: false, post: false, vault: false, tab: "buy", query: "", open: new Set(), sort: "level", desc: false, filters: {} });

const Base = keyboardWindow(rememberWindow(foundry.applications.api.ApplicationV2, { module: MOD, name: "main", from: `${MOD}.size` }), { module: MOD, scope: ".pmk", ownKeys: true });

class MarketApp extends Base {
  static DEFAULT_OPTIONS = {
    id: MOD,
    // The window is drawn dark, so Foundry's own inputs and buttons inside it take the dark theme too.
    classes: ["pmk", "themed", "theme-dark"],
    tag: "div",
    window: {
      title: "PMK.Title",
      icon: "fa-solid fa-store",
      resizable: true,
      // Each user picks a look and a sheet color for their own window.
      controls: [
        { icon: "fa-solid fa-moon", label: "PMK.LookDark", action: "pmkLook-dark" },
        { icon: "fa-solid fa-book-open", label: "PMK.LookHybrid", action: "pmkLook-hybrid" },
        { icon: "fa-solid fa-scroll", label: "PMK.LookPf2e", action: "pmkLook-pf2e" },
        ...SHEET_COLORS.map((c) => ({ icon: "fa-solid fa-palette", label: `PMK.SheetColor.${c}`, action: `pmkColor-${c}` })),
      ],
    },
    position: { width: 1000, height: 720 },
    actions: {
      ...Object.fromEntries(LOOKS.map((l) => [`pmkLook-${l}`, function () { setLook(this, l); }])),
      ...Object.fromEntries(SHEET_COLORS.map((c) => [`pmkColor-${c}`, function () { setColor(this, c); }])),
      pmkMarket: MarketApp.#onMarket,
      pmkShop: MarketApp.#onShop,
      pmkBack: MarketApp.#onBack,
      pmkItem: MarketApp.#onItem,
      pmkItemSheet: MarketApp.#onItemSheet,
      pmkOwnSheet: MarketApp.#onOwnSheet,
      pmkNewMarket: MarketApp.#onNewMarket,
      pmkEditMarket: MarketApp.#onEditMarket,
      pmkDeleteMarket: MarketApp.#onDeleteMarket,
      pmkToggle: MarketApp.#onToggle,
      pmkNewShop: MarketApp.#onNewShop,
      pmkAddMerchant: MarketApp.#onAddMerchant,
      pmkRemoveShop: MarketApp.#onRemoveShop,
      pmkCopyLink: MarketApp.#onCopyLink,
      pmkHideShop: MarketApp.#onHideShop,
      pmkSheet: MarketApp.#onSheet,
      pmkAdd: MarketApp.#onAdd,
      pmkTakeOff: MarketApp.#onTakeOff,
      pmkCart: MarketApp.#onCart,
      pmkCartBack: MarketApp.#onCartBack,
      pmkCartRemove: MarketApp.#onCartRemove,
      pmkCheckout: MarketApp.#onCheckout,
      pmkTab: MarketApp.#onTab,
      pmkSort: MarketApp.#onSort,
      pmkFilter: MarketApp.#onFilter,
      pmkSellAdd: MarketApp.#onSellAdd,
      pmkSellLess: MarketApp.#onSellLess,
      pmkKind: MarketApp.#onKind,
      pmkStapleQty: MarketApp.#onStapleQty,
      pmkFormula: MarketApp.#onFormula,
      pmkFormulaPrice: MarketApp.#onFormulaPrice,
      pmkPost: MarketApp.#onPost,
      pmkNewOffer: MarketApp.#onNewOffer,
      pmkOfferCancel: MarketApp.#onOfferCancel,
      pmkOfferPost: MarketApp.#onOfferPost,
      pmkAccept: MarketApp.#onAccept,
      pmkWithdraw: MarketApp.#onWithdraw,
      pmkStep: MarketApp.#onStep,
      pmkCloseShop: MarketApp.#onCloseShop,
      pmkFill: MarketApp.#onFill,
      pmkDraw: MarketApp.#onDraw,
      pmkAddItem: MarketApp.#onAddItem,
      pmkRestock: MarketApp.#onRestock,
      pmkRestockAll: MarketApp.#onRestockAll,
      pmkShopSettings: MarketApp.#onShopSettings,
      pmkLog: MarketApp.#onLog,
      pmkClearLog: MarketApp.#onClearLog,
      pmkHaggle: MarketApp.#onHaggle,
      pmkVault: MarketApp.#onVault,
      pmkVaultGo: MarketApp.#onVaultGo,
      pmkVaultSheet: MarketApp.#onVaultSheet,
    },
  };

  constructor(options = {}) {
    super(options);
    const saved = store.get("view", {}) ?? {};
    this.view = freshView(saved);
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

  /** Does this window show this actor's items or money now (for redraws on item changes)? */
  showsActor(id) {
    if (!this.rendered) return false;
    const cart = loadCart();
    if (this.view.shop === id || buyerChoices(cart).chosen?.id === id) return true;
    // A shop page's tally and the cart list every shop in the cart; the Trade Post and vaults show other characters.
    if ((this.view.shop || this.view.cart) && (cart.lines.some((l) => l.shop === id) || cart.sales.some((l) => l.shop === id))) return true;
    if (this.view.cart) return cart.lines.some((l) => l.shop === id) || cart.sales.some((l) => l.shop === id);
    if (this.view.post) return true;
    if (this.view.vault) return isVault(game.actors.get(id)) || tradersFor(game.user).some((a) => a.id === id);
    return !this.view.shop && !this.view.log;
  }

  /** An item's description, enriched once per version. */
  description(actor, itemId) {
    return describe(this, actor, itemId);
  }

  /** Show a page: everything else off. */
  #go(page = null, extra = {}) {
    Object.assign(this.view, { cart: false, log: false, post: false, vault: false }, page ? { [page]: true } : {}, extra);
    this.render();
  }

  async _renderHTML() {
    // Prices, purses and haggling need the system's tables: the first draw waits a moment for them (reading never
    // fails); if it takes longer, the window is drawn again once they're read.
    if (!rules.loaded) await Promise.race([rules.ready(), new Promise((r) => setTimeout(r, 3000))]);
    // Keep what's typed into a new offer or the vault page through a redraw.
    if (this.view.draft && !this.#draftSkip) readDraft(this);
    this.#draftSkip = false;
    readVault(this);
    const markets = this.markets();
    let market = markets.find((m) => m.id === this.view.market) ?? null;
    if (!market) {
      market = markets[0] ?? null;
      this.view.shop = null;
    }
    this.view.market = market?.id ?? null;
    const shops = market ? shopsFor(market) : [];
    if (this.view.shop && !shops.some((s) => s.id === this.view.shop)) this.view.shop = null;
    store.set("view", { market: this.view.market, shop: this.view.shop });

    const rail = markets.map((m) => {
      const marks = this.isGM
        ? `<span class="pmk-marks"><i class="fa-solid ${m.visible ? "fa-eye" : "fa-eye-slash pmk-off"}" role="img" aria-label="${Lh(m.visible ? "PlayersSee" : "StatusHidden")}"></i><i class="fa-solid ${m.open ? "fa-store" : "fa-store-slash pmk-off"}" role="img" aria-label="${Lh(m.open ? "StatusOpen" : "NotOpen")}"></i></span>`
        : (m.open ? "" : `<span class="pmk-marks"><i class="fa-solid fa-store-slash pmk-off" role="img" aria-label="${Lh("StatusBrowse")}"></i></span>`);
      const on = m.id === this.view.market && !this.view.cart && !this.view.post && !this.view.log;
      return `<button type="button" class="pmk-a pmk-mk ${m.id === this.view.market ? "active" : ""}" data-action="pmkMarket" data-id="${esc(m.id)}" ${on ? `aria-current="page" data-focus-home` : ""}>
        ${m.img ? `<img src="${esc(m.img)}" alt="">` : icon("fa-landmark pmk-noimg")}
        <span class="pmk-mkn">${esc(m.name)}</span>${marks}</button>`;
    }).join("") || `<p class="pmk-none">${Lh(this.isGM ? "NoMarketsGM" : "NoMarkets")}</p>`;

    const cart = loadCart();
    const inCart = cart.lines.length + salesOf(cart, buyerChoices(cart).chosen).length;
    // Offers one of this user's characters could take.
    const myChars = tradersFor(game.user).map((a) => a.id);
    const postCount = this.isGM ? offers().length : offers().filter((o) => myChars.some((id) => canAccept(o, id)) && !myChars.includes(o.from)).length;
    let main;
    if (this.view.post) main = postHTML(this);
    else if (this.view.log && this.isGM) main = logHTML();
    else if (this.view.cart) main = cartHTML(this, cart);
    else if (!market) main = this.#emptyHTML();
    else if (this.view.vault) main = vaultHTML(this, market);
    else if (this.view.shop) main = await shopHTML(this, market, game.actors.get(this.view.shop));
    else main = await marketHTML(this, market, shops);

    const look = this.look ?? getLook();
    // Parchment pages: everywhere in the Pathfinder sheet look; markets and shops in the hybrid one.
    const paper = look === "pf2e" || (look === "hybrid" && market && !this.view.cart && !this.view.post && !(this.view.log && this.isGM));
    const link = (cls, action, on, fa, key, count = 0) => `<button type="button" class="pmk-a pmk-mk ${cls} ${on ? "active" : ""}" data-action="${action}" ${on ? `aria-current="page"` : ""}>${icon(`${fa} pmk-noimg`)}<span class="pmk-mkn">${Lh(key)}</span>${count ? `<span class="pmk-count">${count}</span>` : ""}</button>`;
    return `<div class="pmk-shell">
      <nav class="pmk-rail" aria-label="${Lh("Markets")}" data-focus-pane="rail" tabindex="-1">
        <div class="pmk-railhead">${Lh("Markets")}</div>
        <div class="pmk-mks">${rail}</div>
        ${this.isGM ? link("pmk-loglink", "pmkLog", this.view.log, "fa-scroll", "TradeLog") : ""}
        ${link("pmk-postlink", "pmkPost", this.view.post, "fa-handshake", "TradePost", postCount)}
        ${link("pmk-cartlink", "pmkCart", this.view.cart, "fa-cart-shopping", "Cart", inCart)}
        ${this.isGM ? `<button type="button" class="pmk-newmk" data-action="pmkNewMarket">${icon("fa-plus")} <span>${Lh("NewMarket")}</span></button>` : ""}
      </nav>
      <section class="pmk-main${paper ? " pmk-paper" : ""}" data-focus-pane="main" data-focus-start tabindex="-1">${main}</section>
    </div>`;
  }

  #emptyHTML() {
    return this.isGM
      ? `<div class="pmk-empty">${icon("fa-store")}<p>${Lh("EmptyGM")}</p>
          <button type="button" data-action="pmkNewMarket">${icon("fa-plus")} ${Lh("NewMarket")}</button></div>`
      : `<div class="pmk-empty">${icon("fa-store")}<p>${Lh("NoMarkets")}</p></div>`;
  }

  /** `#draftSkip` skips reading the new offer's form once, right after the form changed who the offer is for. */
  #draftSkip = false;

  _replaceHTML(result, content, options) {
    const scroller = content.querySelector(".pmk-main");
    const scroll = scroller?.scrollTop ?? 0;
    const where = scroller?.dataset.where;
    // Someone typing (the search box, a quantity) keeps their caret when a change elsewhere redraws the window; the
    // keyboard kit puts focus back on the same control.
    const active = document.activeElement;
    const typing = active?.tagName === "INPUT" && active.name && content.contains(active) ? active : null;
    let caret = null;
    try {
      caret = typing ? [typing.selectionStart, typing.selectionEnd] : null;
    } catch {
      /* number inputs have no selection */
    }
    content.innerHTML = result;
    const main = content.querySelector(".pmk-main");
    if (main) {
      main.dataset.where = `${this.view.market}|${this.view.shop}|${this.view.cart}|${this.view.log}|${this.view.tab}|${this.view.post}|${!!this.view.draft}|${this.view.vault}`;
      if (where === main.dataset.where) main.scrollTop = scroll;
    }
    if (typing && caret && caret[0] !== null) {
      const sel = `input[name="${CSS.escape(typing.name)}"]${typing.dataset.item ? `[data-item="${CSS.escape(typing.dataset.item)}"]` : ""}${typing.dataset.shop ? `[data-shop="${CSS.escape(typing.dataset.shop)}"]` : ""}`;
      requestAnimationFrame(() => {
        const input = content.querySelector(sel);
        try {
          if (input && document.activeElement === input) input.setSelectionRange(...caret);
        } catch {
          /* number inputs have no selection */
        }
      });
    }
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    openApps.add(this);
  }

  async _onClose(options) {
    await super._onClose(options);
    openApps.delete(this);
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const look = this.look ?? getLook();
    for (const l of LOOKS) this.element.classList.toggle(`pmk-look-${l}`, l === look);
    const tint = game.settings.get(MOD, "sheetColor");
    for (const t of SHEET_COLORS) this.element.classList.toggle(`pmk-tint-${t}`, t === tint);
    this.element.classList.toggle("pmk-tinted", tint !== "red" && SHEET_COLORS.includes(tint));
    // Quantities are kept as they're typed and the window redraws a moment later, not on blur: a redraw on blur would
    // replace the Buy or Sell button under the click that caused the blur.
    const later = () => {
      clearTimeout(this.qtyTimer);
      this.qtyTimer = setTimeout(() => this.render(), 400);
    };
    for (const q of this.element.querySelectorAll('input[name="pmk-qty"], input[name="pmk-saleqty"]')) {
      const sale = q.name === "pmk-saleqty";
      const current = () => {
        const cart = loadCart();
        if (!sale) return cart.lines.find((l) => l.shop === q.dataset.shop && l.item === q.dataset.item)?.qty ?? 0;
        const { chosen } = buyerChoices(cart);
        const line = cart.sales.find((l) => l.actor === chosen?.id && l.item === q.dataset.item);
        return line?.shop === q.dataset.shop ? line.qty : 0;
      };
      q.addEventListener("input", () => {
        if (q.value === "") return;
        const lo = q.dataset.cart || !sale ? 1 : 0;
        const n = Math.max(lo, Math.min(Math.floor(Number(q.value)) || lo, Number(q.max) || lo));
        if (n === current()) return;
        this.#setQty(sale ? "sale" : "buy", q.dataset.shop, q.dataset.item, n);
        later();
      });
      q.addEventListener("change", () => {
        if (q.value === "" || Number(q.value) !== current()) later();
      });
    }
    const onChange = (sel, fn) => this.element.querySelector(sel)?.addEventListener("change", fn);
    onChange('select[name="pmk-postas"]', (ev) => {
      this.view.postAs = ev.target.value;
      this.render();
    });
    onChange('select[name="pmk-vaultas"]', (ev) => {
      this.view.vaultAs = ev.target.value;
      this.view.vaultPick = null;
      this.render();
    });
    onChange('select[name="d-to"]', () => {
      readDraft(this);
      this.view.draft.want = {};
      this.#draftSkip = true;
      this.render();
    });
    onChange('select[name="pmk-buyer"]', (ev) => {
      const cart = loadCart();
      cart.buyer = ev.target.value;
      saveCart(cart);
      this.render();
    });
    // A right-click on an item's line still opens its sheet (the sheet button beside the name does the same).
    for (const row of this.element.querySelectorAll(".pmk-row[data-id], .pmk-srow[data-id]")) {
      row.addEventListener("contextmenu", (ev) => {
        if (ev.target.closest("button, input")) return;
        ev.preventDefault();
        if (row.classList.contains("pmk-row")) showShopItem(game.actors.get(this.view.shop), row.dataset.id, this.isGM);
        else buyerChoices(loadCart()).chosen?.items.get(row.dataset.id)?.sheet.render(true);
      });
    }
    // The right-clicks on a mark or an add button do what the button beside it does.
    const rightClick = (sel, fn) => {
      for (const el of this.element.querySelectorAll(sel)) el.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        fn(el.dataset.id);
      });
    };
    rightClick(".pmk-kind-staple", (id) => this.#setStapleQty(id));
    rightClick(".pmk-fmark.on", (id) => this.#setFormulaPrice(id));
    rightClick(".pmk-addbtn:not(.pmk-sellbtn):not(.pmk-minus)", (id) => this.#addToCart(id, -1));
    rightClick(".pmk-sellbtn", (id) => this.#offer(id, -1));
    // GM: drag an NPC onto a shop to make them its shopkeeper, or an item to stock it (Settings and Add item do the same
    // from the keyboard).
    const kd = this.element.querySelector(".pmk-keeperdrop");
    if (kd && this.isGM) {
      kd.addEventListener("dragover", (ev) => ev.preventDefault());
      kd.addEventListener("drop", (ev) => this.#onDropKeeper(ev));
    }
    const input = this.element.querySelector('input[name="pmk-q"]');
    input?.addEventListener("input", () => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        this.view.query = input.value;
        this.render();
      }, 200);
    });
    // A shop card dragged into a journal makes a link to the shop (Copy link does the same from the keyboard).
    for (const card of this.element.querySelectorAll(".pmk-shopcard[data-drag-shop]")) {
      card.addEventListener("dragstart", (ev) => {
        ev.dataTransfer.setData("text/plain", `@Shop[${card.dataset.dragShop}]{${card.dataset.name.replace(/[{}[\]]/g, "")}}`);
      });
    }
    // GM: drag a merchant onto a market page to add it to the market by hand (Add a merchant does it from the keyboard).
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

  /** GM: drop an NPC on a shop for its shopkeeper, or an item (from a compendium, the Items tab or a sheet) to stock it. */
  async #onDropKeeper(event) {
    event.preventDefault();
    const data = TextEditor().getDragEventData(event);
    if (data?.type === "Item" && data.uuid) return this.#stockItem(data.uuid);
    if (data?.type !== "Actor" || !data.uuid) return;
    const npc = await fromUuid(data.uuid);
    const shop = game.actors.get(this.view.shop);
    if (!npc || !shop) return;
    if (npc.pack) return void notice("warn", "KeeperFromTab");
    if (npc.type !== "npc") return void notice("warn", "KeeperIsNPC");
    await shop.update({ [`flags.${MOD}.shop.keeper`]: npc.id });
  }

  /** GM: stock an item. The same item already a staple here (not a formula) gets more of it, and its staple number goes
   * up by as many; anything else comes in as a staple of what was given. */
  async #stockItem(uuid, qty = null) {
    const shop = game.actors.get(this.view.shop);
    const item = await fromUuid(uuid);
    if (!shop || !item || item.parent === shop) return;
    if (!sellable(item)) return void notice("warn", "StocksPhysical");
    const data = game.items.fromCompendium(item, { keepId: false, clearFolder: true });
    delete data.system?.containerId;
    if (data.system?.equipped) data.system.equipped = { carryType: "worn" };
    if (qty) data.system.quantity = qty;
    // Whatever it was in another shop (rotating, sold, a formula), here it comes in as a staple. A world item remembers
    // where it came from, so it can be sold as a formula.
    if (data.flags) delete data.flags[MOD];
    if (!item.pack && !item.parent && !data._stats?.compendiumSource) foundry.utils.setProperty(data, `flags.${MOD}.source`, item.uuid);
    const src = sourceKey(data._stats?.compendiumSource ?? data.flags?.core?.sourceId ?? (item.pack ? item.uuid : null));
    // An item with attached parts comes in as a staple of its own, and a staple with parts takes no more.
    const same = src && !hasParts(data) && shop.items.find((i) => {
      const st = cleanStock(i.flags?.[MOD]?.stock, quantityOf(i));
      return st.kind === "staple" && !st.formula && !hasParts(i) && i.name === data.name && i.type === data.type && !i.system?.containerId
        && sourceKey(i._stats?.compendiumSource ?? i.flags?.core?.sourceId) === src;
    });
    const n = Math.max(1, Number(data.system?.quantity) || 1);
    if (same) {
      const st = cleanStock(same.flags?.[MOD]?.stock, quantityOf(same));
      await same.update({ "system.quantity": quantityOf(same) + n, [`flags.${MOD}.stock.qty`]: st.qty + n });
    } else await shop.createEmbeddedDocuments("Item", [data]);
  }

  async #onDropActor(event) {
    event.preventDefault();
    const data = TextEditor().getDragEventData(event);
    if (data?.type !== "Actor" || !data.uuid) return;
    const actor = await fromUuid(data.uuid);
    if (!actor || actor.pack) return void notice("warn", "MerchantFromTab");
    await this.#addMerchant(actor);
  }

  async #addMerchant(actor) {
    if (!isMerchant(actor)) return void notice("warn", "OnlyMerchants");
    await mutateMarket(this.view.market, (m) => {
      if (m.extra.includes(actor.id)) return false;
      m.extra.push(actor.id);
    });
  }

  /** Point the window at a market (and a shop in it), from open(). */
  show(marketId, shopId = null) {
    if (!marketId) return;
    this.view = Object.assign(freshView({ market: marketId, shop: shopId }), { postAs: this.view.postAs, vaultAs: this.view.vaultAs });
  }

  /* ---------------- Actions ---------------- */

  static #onMarket(event, target) {
    this.#go(null, { market: target.dataset.id, shop: null, query: "" });
  }

  static #onShop(event, target) {
    this.#go(null, { shop: target.dataset.id, tab: "buy", query: "", open: new Set() });
  }

  static #onBack() {
    this.#go(null, { shop: null, query: "" });
  }

  static #onItem(event, target) {
    const id = target.dataset.id;
    if (this.view.open.has(id)) this.view.open.delete(id);
    else this.view.open.add(id);
    this.render();
  }

  static #onItemSheet(event, target) {
    showShopItem(game.actors.get(this.view.shop), target.dataset.id, this.isGM);
  }

  static #onOwnSheet(event, target) {
    buyerChoices(loadCart()).chosen?.items.get(target.dataset.id)?.sheet.render(true);
  }

  static #onAdd(event, target) {
    this.#addToCart(target.dataset.id, 1);
  }

  static #onTakeOff(event, target) {
    this.#addToCart(target.dataset.id, -1);
  }

  /** Put one more (dir 1) or one fewer (dir -1) of a shop item or service in the cart: a batch for things sold in
   * batches. */
  #addToCart(itemId, dir) {
    const actor = game.actors.get(this.view.shop);
    const item = actor?.items.get(itemId);
    const service = !item && actor ? (actor.flags?.[MOD]?.shop?.services ?? []).find((s) => s.id === itemId) : null;
    if (!service && (!item || !sellable(item))) return;
    if (dir > 0 && !tradeMarketFor(actor.id, game.user)) return void notice("warn", "ShopNotOpenNow");
    const cart = loadCart();
    const per = service ? 1 : itemPrice(item).per;
    const most = service ? 999 : isFormulaItem(item) ? 1 : quantityOf(item);
    if (dir > 0) {
      const had = cart.lines.find((l) => l.shop === actor.id && l.item === itemId);
      cart.lines = addToCart(cart.lines, actor.id, itemId, per, most);
      if (!had && !cart.lines.some((l) => l.shop === actor.id && l.item === itemId) && most) notice("warn", "CartFull", { n: MAX_LINES });
    } else cart.lines = takeFromCart(cart.lines, actor.id, itemId, per);
    saveCart(cart);
    this.render();
    const name = service?.name ?? realItem(item).name;
    const now = cart.lines.find((l) => l.shop === actor.id && l.item === itemId)?.qty ?? 0;
    this.announceText(L("InCartNow", { name, n: now }));
  }

  static #onSort(event, target) {
    const key = STOCK_SORTS.includes(target.dataset.key) ? target.dataset.key : "level";
    this.view.desc = this.view.sort === key ? !this.view.desc : false;
    this.view.sort = key;
    this.render();
  }

  static #onFilter(event, target) {
    const key = target.dataset.key;
    if (key !== "afford" && key !== "level") return;
    this.view.filters = { ...this.view.filters, [key]: !this.view.filters?.[key] };
    this.render();
  }

  /** GM: swap an item between staple and rotating (a sold item becomes a staple). */
  static async #onKind(event, target) {
    if (!this.isGM) return;
    const item = game.actors.get(this.view.shop)?.items.get(target.dataset.id);
    if (!item) return;
    const raw = item.flags?.[MOD]?.stock ?? {};
    const st = cleanStock(raw, quantityOf(item));
    const kind = nextStockKind(st.kind);
    // A staple made rotating and back keeps its number; otherwise it's what the item has now (at least 1).
    const qty = Number.isFinite(Number(raw.qty)) && raw.qty !== null ? Math.max(0, Math.round(Number(raw.qty))) : Math.max(1, quantityOf(item));
    await item.update({ [`flags.${MOD}.stock`]: kind === "staple" ? { ...raw, kind, qty } : { ...raw, kind, qty: st.kind === "staple" ? st.qty : raw.qty ?? null } });
  }

  static #onStapleQty(event, target) {
    this.#setStapleQty(target.dataset.id);
  }

  /** GM: sell an item as a formula, or as itself again. */
  static async #onFormula(event, target) {
    if (!this.isGM) return;
    const item = game.actors.get(this.view.shop)?.items.get(target.dataset.id);
    if (!item) return;
    const raw = item.flags?.[MOD]?.stock ?? {};
    const st = cleanStock(raw, quantityOf(item));
    if (!st.formula) {
      if (st.kind === "sold") return void notice("info", "MakeStapleFirst");
      if (isTreasure(item)) return void notice("info", "TreasureNoFormula");
      if (!sellable(item)) return void notice("info", "EmptyFirst");
      if (!formulaUuid(item)) return void notice("warn", "NoFormulaSource");
    }
    // An unmarked item is a staple of what it has (as everywhere else); the mark keeps its kind and number.
    const next = { ...raw, kind: st.kind, qty: st.kind === "staple" ? st.qty : raw.qty ?? null, formula: !st.formula };
    if (!next.formula) next.price = null;
    await item.update({ [`flags.${MOD}.stock`]: next });
  }

  static #onFormulaPrice(event, target) {
    this.#setFormulaPrice(target.dataset.id);
  }

  /** GM: set a formula's price, or clear it back to the price for its level. */
  async #setFormulaPrice(itemId) {
    const item = game.actors.get(this.view.shop)?.items.get(itemId);
    if (!item || !isFormulaItem(item)) return;
    const st = cleanStock(item.flags?.[MOD]?.stock, quantityOf(item));
    const auto = formulaPrice(itemLevel(item), itemRarity(item), formulaMults());
    const gp = await formulaPriceDialog(realItem(item).name, st.price, auto);
    if (gp === null || gp === undefined) return;
    const next = { ...item.flags[MOD].stock };
    const n = Number(gp);
    next.price = String(gp).trim() === "" || !Number.isFinite(n) || n < 0 ? null : Math.round(n * 100);
    await item.update({ [`flags.${MOD}.stock`]: next });
  }

  /** GM: set what a staple restocks to. */
  async #setStapleQty(itemId) {
    const item = game.actors.get(this.view.shop)?.items.get(itemId);
    if (!item) return;
    const st = cleanStock(item.flags?.[MOD]?.stock, quantityOf(item));
    if (st.kind !== "staple") return;
    const n = await stapleQtyDialog(realItem(item).name, st.qty);
    if (n === null) return;
    await item.update({ [`flags.${MOD}.stock`]: cleanStock({ ...item.flags?.[MOD]?.stock, kind: "staple", qty: n }) });
  }

  static #onSellAdd(event, target) {
    this.#offer(target.dataset.id, 1);
  }

  static #onSellLess(event, target) {
    this.#offer(target.dataset.id, -1);
  }

  /** Offer one more (dir 1) or one fewer (dir -1) of the trader's item to this shop: a batch for things sold in batches. */
  #offer(itemId, dir) {
    const shop = game.actors.get(this.view.shop);
    const cart = loadCart();
    const { chosen, list } = buyerChoices(cart);
    const row = sellRows(chosen).find((r) => r.id === itemId);
    if (!shop || !chosen || !row || row.why) return;
    if (dir > 0 && !tradeMarketFor(shop.id, game.user)) return void notice("warn", "ShopNotOpenNow");
    // Sales for characters this user can no longer trade for don't take up room.
    const mine = new Set(list.map((a) => a.id));
    cart.sales = cart.sales.filter((l) => mine.has(l.actor));
    const line = cart.sales.find((l) => l.actor === chosen.id && l.item === itemId);
    if (dir > 0) {
      if (line && line.shop !== shop.id) notice("info", "NowOfferedTo", { name: row.name, shop: shop.name, other: game.actors.get(line.shop)?.name ?? L("TheOtherShop") });
      cart.sales = addSale(cart.sales, chosen.id, shop.id, itemId, row.per, row.qty);
      if (!cart.sales.some((l) => l.actor === chosen.id && l.item === itemId)) notice("warn", "CartFull", { n: MAX_LINES });
    } else if (line?.shop === shop.id) cart.sales = takeSale(cart.sales, chosen.id, itemId, row.per);
    saveCart(cart);
    this.render();
    this.announceText(L("OfferedNow", { name: row.name, n: cart.sales.find((l) => l.actor === chosen.id && l.item === itemId && l.shop === shop.id)?.qty ?? 0 }));
  }

  /** Set a cart line's quantity (a sale of 0 comes out of the cart). */
  #setQty(kind, shopId, itemId, n) {
    const cart = loadCart();
    if (kind === "buy") {
      const line = cart.lines.find((l) => l.shop === shopId && l.item === itemId);
      if (line) line.qty = n;
      else if (n >= 1) cart.lines.push({ shop: shopId, item: itemId, qty: n });
    } else {
      const { chosen } = buyerChoices(cart);
      if (!chosen) return;
      const was = cart.sales.find((l) => l.actor === chosen.id && l.item === itemId);
      if (was && was.shop !== shopId && n >= 1) {
        const name = sellRows(chosen).find((r) => r.id === itemId)?.name ?? L("It");
        notice("info", "NowOfferedTo", { name, shop: game.actors.get(shopId)?.name ?? L("ThisShop"), other: game.actors.get(was.shop)?.name ?? L("TheOtherShop") });
      }
      cart.sales = cart.sales.filter((l) => !(l.actor === chosen.id && l.item === itemId));
      if (n >= 1) cart.sales.push({ actor: chosen.id, shop: shopId, item: itemId, qty: n });
    }
    saveCart(cart);
  }

  /** The cart's minus and plus buttons: one batch at a time, never below one or above what there is. */
  static #onStep(event, target) {
    const { kind, shop, item } = target.dataset;
    const dir = Number(target.dataset.dir) < 0 ? -1 : 1;
    const cart = loadCart();
    if (kind === "buy") {
      const doc = game.actors.get(shop)?.items.get(item);
      const line = cart.lines.find((l) => l.shop === shop && l.item === item);
      if (!line) return;
      const per = doc ? itemPrice(doc).per : 1;
      const max = doc ? (isFormulaItem(doc) ? 1 : quantityOf(doc)) : 999;
      // An item with attached parts is all or nothing: minus takes it out of the cart.
      if (dir < 0 && doc && hasParts(doc)) {
        cart.lines = cart.lines.filter((l) => l !== line);
        saveCart(cart);
      } else this.#setQty("buy", shop, item, Math.max(1, Math.min(max, line.qty + dir * per)));
    } else {
      const { chosen } = buyerChoices(cart);
      const row = sellRows(chosen).find((r) => r.id === item);
      const line = cart.sales.find((l) => l.actor === chosen?.id && l.item === item);
      if (!line) return;
      const per = row?.per ?? 1;
      if (dir < 0 && row?.parts) {
        cart.sales = cart.sales.filter((l) => l !== line);
        saveCart(cart);
      } else this.#setQty("sale", shop, item, Math.max(1, Math.min(row?.qty ?? line.qty, line.qty + dir * per)));
    }
    this.render();
  }

  static #onCart() {
    this.#go("cart");
  }

  static #onPost() {
    this.#go("post");
  }

  static #onNewOffer() {
    this.view.draft = { to: null, give: {}, want: {}, giveCp: 0, wantCp: 0, note: "" };
    this.render();
  }

  static #onOfferCancel() {
    this.view.draft = null;
    this.render();
  }

  static #onOfferPost() {
    readDraft(this);
    const d = this.view.draft;
    const me = tradersFor(game.user).find((a) => a.id === this.view.postAs) ?? tradersFor(game.user)[0];
    if (!me || !d) return;
    const list = (o) => Object.entries(o).map(([item, qty]) => ({ item, qty }));
    const offer = { id: "draft000", from: me.id, to: d.to, give: { items: list(d.give), cp: d.giveCp }, want: { items: d.to ? list(d.want) : [], cp: d.wantCp }, note: d.note };
    if (!cleanOffer(offer)) return void notice("warn", "OfferNeedsSomethingNotice");
    postRequest({ type: "post", offer });
  }

  static #onAccept(event, target) {
    const me = tradersFor(game.user).find((a) => a.id === this.view.postAs) ?? tradersFor(game.user)[0];
    if (me) postRequest({ type: "accept", id: target.dataset.id, actor: me.id });
  }

  static #onWithdraw(event, target) {
    postRequest({ type: "withdraw", id: target.dataset.id });
  }

  static #onCartBack() {
    this.#go(null);
  }

  static #onTab(event, target) {
    this.view.tab = target.dataset.tab === "sell" ? "sell" : "buy";
    this.render();
  }

  static async #onDraw() {
    if (!this.isGM) return;
    const shop = game.actors.get(this.view.shop);
    const market = marketById(this.view.market);
    if (shop) await drawStockDialog(shop, market, () => shopSettingsDialog(shop, market));
  }

  static async #onAddItem() {
    if (!this.isGM) return;
    const r = await addItemDialog();
    if (r) await this.#stockItem(r.uuid, r.qty);
  }

  static async #onFill() {
    if (!this.isGM) return;
    const shop = game.actors.get(this.view.shop);
    if (!shop) return;
    const added = await fillPurse(shop, marketById(this.view.market));
    if (added === null) return void notice("warn", "FillOff");
    notice("info", added ? "PurseAdded" : "PurseFull", { amount: fmt(added), shop: shop.name });
  }

  static async #onShopSettings() {
    if (!this.isGM) return;
    const shop = game.actors.get(this.view.shop);
    if (shop) await shopSettingsDialog(shop, marketById(this.view.market));
  }

  static #onLog() {
    if (this.isGM) this.#go("log");
  }

  static async #onClearLog() {
    if (!this.isGM) return;
    const ok = await confirmDialog(L("ClearLogTitle"), `<p>${Lh("ClearLogText")}</p>`);
    if (ok) await game.settings.set(MOD, "log", []);
  }

  static #onCartRemove(event, target) {
    const cart = loadCart();
    const { shop, item } = target.dataset;
    const { chosen } = buyerChoices(cart);
    if (target.dataset.kind === "sale") cart.sales = cart.sales.filter((l) => !(l.actor === chosen?.id && l.shop === shop && l.item === item));
    else cart.lines = cart.lines.filter((l) => !(l.shop === shop && l.item === item));
    saveCart(cart);
    this.render();
  }

  static #onCheckout(event, target) {
    checkout({ buy: Number(target.dataset.buy), sell: Number(target.dataset.sell) });
  }

  static async #onHaggle() {
    const shop = game.actors.get(this.view.shop);
    const { chosen } = buyerChoices(loadCart());
    if (shop && chosen) await startHaggle(shop, chosen);
  }

  static #onVault() {
    this.#go("vault", { vaultPick: null });
  }

  static #onVaultGo(event, target) {
    readVault(this);
    const market = marketById(this.view.market);
    const me = (tradersFor(game.user).find((a) => a.id === this.view.vaultAs) ?? tradersFor(game.user).find((a) => a.id === game.user.character?.id) ?? tradersFor(game.user)[0]);
    if (!market || !me) return;
    const deposit = target.dataset.op === "deposit";
    const p = this.view.vaultPick ?? {};
    const items = Object.entries((deposit ? p.dep : p.wd) ?? {}).map(([item, qty]) => ({ item, qty }));
    const cp = deposit ? p.depCp : p.wdCp;
    if (!items.length && !cp) return void notice("info", "VaultNothing");
    this.view.vaultPick = null;
    postRequest({ type: "vault", op: deposit ? "deposit" : "withdraw", market: market.id, actor: me.id, items, cp });
  }

  static #onVaultSheet(event, target) {
    if (this.isGM) game.actors.get(target.dataset.id)?.sheet.render(true);
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
      d.markets.push({ ...data, id, folder, extra: [], visible: false, open: false, sort, created: Date.now(), lastRestock: data.restockEvery ? game.time.worldTime : null });
    });
    await syncReputation();
    this.#go(null, { market: id, shop: null });
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
      const { id, extra, visible, open, sort, created, lastRestock, repNow, ...fields } = data;
      Object.assign(m, fields, { folder });
      // A new or changed interval counts from now.
      if (data.restockEvery && (m.lastRestock === null || data.restockEvery !== market.restockEvery)) m.lastRestock = game.time.worldTime;
      // A tracker linked or changed: its tier is read again below.
      if (m.reputation !== market.reputation) m.repNow = null;
    });
    await syncReputation();
  }

  static async #onDeleteMarket() {
    if (!this.isGM) return;
    const market = marketById(this.view.market);
    if (!market) return;
    const ok = await confirmDialog(L("DeleteMarket"), `<p>${Lh("DeleteMarketText", { name: market.name })}</p>`);
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
    const before = marketById(this.view.market);
    // Players saw what's in its shops now; a browse-only view shows that until the next restock.
    if (before?.open) await noteSeen(shopsFor(before).map((s) => game.actors.get(s.id)).filter((a) => a && openToPlayers(a)));
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
    const r = await newShopDialog();
    if (!r) return;
    let folder = market.folder && game.folders.get(market.folder) ? market.folder : null;
    if (!folder) {
      folder = (await Folder.create({ name: market.name, type: "Actor" }))?.id ?? null;
      if (folder) await mutateMarket(market.id, (m) => void (m.folder = folder));
    }
    const data = merchantData(String(r.name).slice(0, 120), folder);
    if (SHOP_KINDS[r.kind]) foundry.utils.setProperty(data, `flags.${MOD}.shop`, { lines: SHOP_KINDS[r.kind] });
    const actor = await Actor.create(data);
    if (!actor) return;
    // A new shop takes its market's level and starts with a full purse.
    if (market.level) await setLevel(actor, market.level);
    if ((await fillPurse(actor, market)) === null) notice("warn", "FillOff");
    this.#go(null, { shop: actor.id });
    actor.sheet.render(true);
  }

  static async #onAddMerchant() {
    if (!this.isGM) return;
    const market = marketById(this.view.market);
    if (!market) return;
    const id = await addMerchantDialog(new Set(shopsFor(market).map((s) => s.id)));
    const actor = id ? game.actors.get(id) : null;
    if (actor) await this.#addMerchant(actor);
  }

  static async #onRemoveShop(event, target) {
    if (!this.isGM) return;
    const id = target.dataset.id;
    await mutateMarket(this.view.market, (m) => {
      if (!m.extra.includes(id)) return false;
      m.extra = m.extra.filter((x) => x !== id);
    });
  }

  /** Copy a link to a shop for a journal (@Shop[id]{name}): the keyboard way to drag a shop's card into one. */
  static async #onCopyLink(event, target) {
    const actor = game.actors.get(target.dataset.id);
    if (!actor) return;
    const text = `@Shop[${actor.id}]{${actor.name.replace(/[{}[\]]/g, "")}}`;
    try {
      await navigator.clipboard.writeText(text);
      notice("info", "LinkCopied", { text });
    } catch {
      notice("info", "LinkToCopy", { text });
    }
  }

  static async #onHideShop() {
    if (!this.isGM) return;
    const actor = game.actors.get(this.view.shop);
    if (!actor) return;
    const showing = !!actor.flags?.[MOD]?.hidden;
    await actor.update({ [`flags.${MOD}.hidden`]: !showing });
    if (showing) await this.#offerMarket("visible");
  }

  static async #onCloseShop() {
    if (!this.isGM) return;
    const actor = game.actors.get(this.view.shop);
    if (!actor) return;
    const opening = !!actor.flags?.[MOD]?.closed;
    if (!opening && openToPlayers(actor)) await noteSeen([actor]);
    await actor.update({ [`flags.${MOD}.closed`]: !opening });
    if (opening) await this.#offerMarket("open");
  }

  /** After a shop is shown or opened: if its market is hidden or closed, players still can't see it or trade there, so
   * offer to show or open the market too. */
  async #offerMarket(what) {
    const market = marketById(this.view.market);
    if (!market || market[what]) return;
    const open = what === "open";
    const ok = await confirmDialog(L(open ? "MarketClosedTitle" : "MarketHiddenTitle"), `<p>${Lh(open ? "MarketClosedText" : "MarketHiddenText", { name: market.name })}</p>`,
      { label: L(open ? "OpenTheMarket" : "ShowTheMarket"), icon: "fa-solid fa-check" }, { label: L("JustTheShop"), icon: "fa-solid fa-xmark" });
    if (!ok) return;
    await mutateMarket(market.id, (m) => {
      m[what] = true;
      // Open for trade means players can see it too.
      if (open) m.visible = true;
    });
  }

  static async #onRestock() {
    if (!this.isGM) return;
    const shop = game.actors.get(this.view.shop);
    if (!shop) return;
    const opts = await restockDialog(L("RestockTitle", { name: shop.name }), [shop]);
    if (!opts || typeof opts !== "object") return;
    try {
      const r = await restockShop(shop, marketById(this.view.market), opts);
      notice("info", "ShopRestocked", { name: shop.name, n: r.drawn });
    } catch (err) {
      console.error(`${MOD} | restocking ${shop.name} failed`, err);
      notice("error", "CouldntRestock", { name: shop.name });
    }
  }

  static async #onRestockAll() {
    if (!this.isGM) return;
    const market = marketById(this.view.market);
    if (!market) return;
    const shops = shopsFor(market).map((s) => game.actors.get(s.id)).filter(isMerchant);
    if (!shops.length) return;
    const opts = await restockDialog(L(shops.length === 1 ? "RestockAllTitleOne" : "RestockAllTitleMany", { name: market.name, n: shops.length }), shops);
    if (!opts || typeof opts !== "object") return;
    const n = await restockMarket(market, opts);
    if (n) notice("info", "MarketRestocked", { name: market.name });
  }

  static #onSheet() {
    game.actors.get(this.view.shop)?.sheet.render(true);
  }
}

/** One Marketplace window per client: open() shows it (at a market and shop, if given) and brings it to the front. */
const windows = singleWindow(() => new MarketApp(), { reuse: (app, marketId, shopId) => app.show(marketId, shopId) });
const openMarket = async (marketId = null, shopId = null) => {
  const fresh = !windows.current();
  const app = await windows.open(marketId, shopId);
  if (fresh && marketId) {
    app.show(marketId, shopId);
    await app.render();
  }
  return app;
};

export { LOOKS, MarketApp, SHEET_COLORS, openMarket, showShopItem };
