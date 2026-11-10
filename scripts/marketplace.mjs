/**
 * PF2e Marketplace
 * A marketplace window over PF2e's own merchants: markets (a name, picture, description and the shops in them),
 * browsed without opening merchant sheets. Shops stay ordinary PF2e merchant loot actors, so they keep working as
 * merchant sheets without the module.
 */

import {
  esc, cleanStore, cleanMarket, byMarketOrder, canSee, canTradeShop, MAX_LINES, shopsOf, formatCp, priceFor, groupStock, cleanLines, addToCart, takeFromCart, listOf,
  purseFor, ATTITUDES, ATTITUDE_LABEL, PRICE_DEFAULTS, cleanShop, attitudePct, pctFor, adjust, planTrade, offerFor, sellRate, cleanSales, addSale, takeSale, settle, cleanStock, nextStockKind, STOCK_FILTERS, filterLabel, cleanStockLines, drawable, drawEntries, drawnQty, scribable, drawSpells, MAX_STOCK_LINES, restockPlan, restockDue, sourceKey, AMOUNTS, AMOUNT_LABEL, AMOUNT_DEFAULTS, LINE_RARITIES, rarityAllowed, parseRange, lineCount, cleanOffer, cleanOffers, canAccept, offerNet, coinsCp, MAX_OFFERS_EACH, MAX_OFFERS, formulaPrice, FORMULA_MULT_DEFAULTS, buyPrice, addLogEntry, cleanLogEntry, handPricedNote,
} from "./helpers.mjs";
import {
  isMerchant, actorLevel, stockRows, descriptionOf, merchantData, realItem, priceOf, sellable, quantityOf, fundsCp, pay, receive,
  boughtCopy, giveItems, takeFromStock, buyersFor, sellRows, canSellToShop, soldCopy, setLevel, keeperFace, isTreasure, handPriced, tradeRows, formulaUuid, knowsFormula, addFormulas, restoreFormulas, parchmentData, equipmentIndex, spellIndex, spellTemplates, itemFromEntry, spellItemData,
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
  id: a.id, name: a.name, folder: a.folder?.id ?? null, merchant: isMerchant(a), hidden: !!a.flags?.[MOD]?.hidden, closed: !!a.flags?.[MOD]?.closed,
}));
const parentOf = (id) => game.folders.get(id)?.folder?.id ?? null;
const shopsFor = (market) => shopsOf(market, actorRows(), parentOf, game.user.isGM);

/** A market where this user may trade with this shop (null if none): the market must be open, and the shop neither
 * hidden from them nor closed. GMs can trade anywhere. */
function tradeMarketFor(shopId, user, rows = actorRows()) {
  return store().markets.find((m) => shopsOf(m, rows, parentOf, user.isGM).some((s) => s.id === shopId && canTradeShop(m, s, user.isGM))) ?? null;
}
/** Formulas (0.4): a shop item marked as a formula sells a copy of the formula at the formula price for its level and
 * rarity (or the GM's own price); the shop keeps it. */
const formulaMults = () => ({ uncommon: Number(game.settings.get(MOD, "formula-uncommon")), rare: Number(game.settings.get(MOD, "formula-rare")) });
const isFormulaItem = (item) => !!cleanStock(item?.flags?.[MOD]?.stock).formula;
const itemLevel = (item) => Number(item?.level ?? item?.system?.level?.value ?? 0) || 0;
const itemRarity = (item) => item?.rarity ?? item?.system?.traits?.rarity ?? "common";
/** What a shop item sells for: { cp, per }. */
function itemPrice(item) {
  const st = cleanStock(item?.flags?.[MOD]?.stock);
  if (!st.formula) return priceOf(item);
  return { cp: st.price ?? formulaPrice(itemLevel(item), itemRarity(item), formulaMults()), per: 1 };
}
/** A shop's stock rows as players see them: formulas priced as formulas, one copy at a time. */
const shopRows = (actor) => stockRows(actor).map((r) => {
  const st = cleanStock(r.stock, r.qty);
  if (!st.formula) return r;
  return { ...r, name: `Formula: ${r.name}`, formula: true, cp: st.price ?? formulaPrice(r.level, r.rarity, formulaMults()), per: 1, qty: 1, uuid: formulaUuid(actor.items.get(r.id)) };
});

/** A shop's own switches, as a row for canTradeShop. */
const shopRow = (actor) => ({ id: actor?.id, hidden: !!actor?.flags?.[MOD]?.hidden, closed: !!actor?.flags?.[MOD]?.closed });

/* ------------------------------------------------------------------ */
/* Shops: settings, attitude, purse, log                              */
/* ------------------------------------------------------------------ */

/** A shop's settings (merchant actor flag `shop`). */
const shopConf = (actor) => cleanShop(actor?.flags?.[MOD]?.shop);
const ATTITUDES_MOD = "pf2e-npc-attitudes";

/**
 * The attitude that sets a buyer's prices. With PF2e NPC Attitudes on and a shopkeeper who has a record there:
 * - the party sees their true attitude ("shown" is "same"): that attitude, or the one toward this character if set;
 * - the party is shown the true attitude picked by hand: that attitude (per-character ones aren't shown then);
 * - the party is shown something else (a disguise, or Unknown): Indifferent, normal prices (design decision, 9 Nov),
 *   so a secretly hostile merchant still trades and a pretended friend gives no discount. (A missing discount is a
 *   soft tell; accepted.)
 * Otherwise the shop's own setting. The record is read straight from the actor, the same way on every client, so a
 * player sees the price the GM's client will charge.
 */
function attitudeInfo(shop, buyer) {
  const conf = shopConf(shop);
  const keeper = conf.keeper ? game.actors.get(conf.keeper) : null;
  const rec = keeper && game.modules.get(ATTITUDES_MOD)?.active ? keeper.flags?.[ATTITUDES_MOD]?.npc : null;
  const own = rec && buyer && buyer.type === "character" ? rec.pcs?.[buyer.id] : null;
  if (rec && (ATTITUDES.includes(rec.attitude) || ATTITUDES.includes(own))) {
    const shown = rec.shown ?? "same";
    // Shown as it is: the attitude toward this character if set (players see those too), else the general one.
    if (shown === "same") return { attitude: ATTITUDES.includes(own) ? own : ATTITUDES.includes(rec.attitude) ? rec.attitude : conf.attitude, real: rec.attitude ?? own, masked: false };
    if (shown === rec.attitude) return { attitude: rec.attitude, real: rec.attitude, masked: false };
    return { attitude: "indifferent", real: rec.attitude, shown, masked: true };
  }
  return { attitude: conf.attitude, real: conf.attitude, masked: false };
}
const attitudeFor = (shop, buyer) => attitudeInfo(shop, buyer).attitude;
const pricePcts = () => Object.fromEntries(ATTITUDES.map((a) => [a, game.settings.get(MOD, `price-${a}`)]));
/** The price change for this buyer at this shop in percent, or null when the shop won't trade with them. */
const pricePct = (shop, buyer) => attitudePct(attitudeFor(shop, buyer), pricePcts(), game.settings.get(MOD, "hostileRefuses"));
/** Who the shop is, for "won't trade" lines: the shopkeeper's name if there is one, as `user` knows it (a player
 * gets the name on the token, never the actor's real name). */
function shopFace(shop, user = game.user) {
  const keeper = shopConf(shop).keeper ? game.actors.get(shopConf(shop).keeper) : null;
  return keeperFace(keeper, user.isGM)?.name ?? shop?.name ?? "The shop";
}
/** "can only pay 12 gp", or "has no money to pay with", for a shop's purse. */
const canPay = (shop) => (fundsCp(shop) ? `can only pay ${formatCp(fundsCp(shop))} right now` : "has no money to pay with right now");

/** A shop's level: the merchant's own, else its market's. */
const shopLevel = (actor, market) => actorLevel(actor) || market?.level || 0;
/** The first market a shop is in (for its level). */
function marketOfShop(shopId) {
  const rows = actorRows();
  return store().markets.find((m) => shopsOf(m, rows, parentOf, true).some((s) => s.id === shopId)) ?? null;
}

/** Top a shop's purse up to its level's amount (never takes coins away). Returns what it added, in copper. */
async function fillPurse(shop, market = marketOfShop(shop.id)) {
  if (shopConf(shop).unlimited) return 0;
  const target = purseFor(shopLevel(shop, market), game.settings.get(MOD, "purseScale"));
  const add = target - fundsCp(shop);
  if (add > 0) await receive(shop, add);
  return Math.max(0, add);
}

/** Add a trade to the log (GM clients only; one write at a time). */
let logWrites = Promise.resolve();
function logTrade(entry) {
  if (!game.user.isGM) return;
  logWrites = logWrites.then(() => game.settings.set(MOD, "log", addLogEntry(game.settings.get(MOD, "log"), { t: Date.now(), ...entry })))
    .catch((err) => console.warn(`${MOD} | couldn't write the trade log`, err));
}

/* ------------------------------------------------------------------ */
/* The cart (per user, in this browser)                               */
/* ------------------------------------------------------------------ */

/* The cart holds what the user is buying (`lines`: { shop, item, qty }) and what they're selling (`sales`: { actor,
 * shop, item, qty }, the trader's own items). Sales belong to one character: only the chosen trader's count. */
let memoryCart = null;
function loadCart() {
  try {
    const v = JSON.parse(localStorage.getItem(storeKey("cart"))) ?? {};
    return { lines: cleanLines(v.lines), sales: cleanSales(v.sales), buyer: typeof v.buyer === "string" ? v.buyer : null };
  } catch {
    return memoryCart ? structuredClone(memoryCart) : { lines: [], sales: [], buyer: null };
  }
}
function saveCart(cart) {
  const v = { lines: cleanLines(cart.lines), sales: cleanSales(cart.sales), buyer: cart.buyer };
  try {
    localStorage.setItem(storeKey("cart"), JSON.stringify(v));
  } catch {
    /* no storage: the cart lasts until reload */
    memoryCart = v;
  }
}

/** The actors this user can buy for, and the one chosen (their own character first). */
function buyerChoices(cart) {
  const list = buyersFor(game.user, game.actors.contents).sort((a, b) => (a.type === "party") - (b.type === "party") || a.name.localeCompare(b.name));
  const chosen = list.find((a) => a.id === cart.buyer) ?? list.find((a) => a.id === game.user.character?.id) ?? list[0] ?? null;
  return { list, chosen };
}

/** What each cart line is now: its shop, item, price for this buyer and anything wrong with it. */
function cartState(lines, buyer, rows = actorRows()) {
  const formulas = new Set();
  return lines.map((l) => {
    const shop = game.actors.get(l.shop);
    const item = isMerchant(shop) ? shop.items.get(l.item) : null;
    let stock = item ? quantityOf(item) : 0;
    let { cp, per } = item ? priceOf(item) : { cp: 0, per: 1 };
    const market = shop ? tradeMarketFor(shop.id, game.user, rows) : null;
    const pct = shop ? pricePct(shop, buyer) : 0;
    const formula = isFormulaItem(item);
    const uuid = formula ? formulaUuid(item) : null;
    if (formula) {
      ({ cp, per } = itemPrice(item));
      stock = 1;
    }
    let problem = null;
    if (!shop || !isMerchant(shop)) problem = "This shop is gone.";
    else if (!item || !sellable(item)) problem = "No longer for sale.";
    else if (formula && !uuid) problem = "No longer for sale.";
    else if (formula && buyer?.type !== "character") problem = "Only characters learn formulas.";
    else if (formula && knowsFormula(buyer, uuid)) problem = `${buyer.name} already knows it.`;
    else if (formula && formulas.has(uuid)) problem = "Already in the cart from another shop.";
    else if (!market) problem = "This shop isn't open for trade right now.";
    else if (pct === null) problem = `${shopFace(shop)} won't trade with ${buyer?.name ?? "you"}.`;
    else if (formula && l.qty > 1) problem = "One copy only.";
    else if (stock < l.qty) problem = stock ? `Only ${stock} left.` : "Sold out.";
    if (uuid) formulas.add(uuid);
    return { ...l, shopDoc: shop, itemDoc: item, formula, stock, cp, per, pct: pct ?? 0, price: buyPrice(cp, per, l.qty, pct ?? 0, isTreasure(item), formula), market, problem };
  });
}

/** The chosen trader's sales in the cart. */
const salesOf = (cart, trader) => (trader ? cart.sales.filter((l) => l.actor === trader.id) : []);

/** What each sale line is now: the shop, the trader's item, the offer, and anything wrong with it. */
function saleState(sales, trader, actors = actorRows()) {
  const rows = new Map(sellRows(trader).map((r) => [r.id, r]));
  return sales.map((l) => {
    const shop = game.actors.get(l.shop);
    const row = rows.get(l.item) ?? null;
    const conf = shopConf(shop);
    const market = shop ? tradeMarketFor(shop.id, game.user, actors) : null;
    const pct = shop ? pricePct(shop, trader) : 0;
    const offer = row ? offerFor(row.cp, row.per, Math.min(l.qty, row.qty), sellRate(conf, row.treasure, pctFor(pct ?? 0, row.treasure))) : 0;
    let problem = null;
    if (!shop || !isMerchant(shop)) problem = "This shop is gone.";
    else if (!row) problem = `${trader?.name ?? "You"} no longer has it.`;
    else if (row.why) problem = row.why;
    else if (!market) problem = "This shop isn't open for trade right now.";
    else if (!conf.buys) problem = `${shop.name} doesn't buy from customers.`;
    else if (pct === null) problem = `${shopFace(shop)} won't trade with ${trader?.name ?? "you"}.`;
    else if (row.qty < l.qty) problem = `${trader.name} has only ${row.qty}.`;
    return { ...l, shopDoc: shop, row, conf, offer, market, problem };
  });
}

/** The whole cart for the chosen trader: buys, sales, how it settles, and per shop any purse that can't cover it. */
function tradeState(cart, trader) {
  const rows = actorRows();
  const buys = cartState(cart.lines, trader, rows);
  const sales = saleState(salesOf(cart, trader), trader, rows);
  const s = settle(buys, sales);
  const plan = planTrade(s, shopInfo(s.shops.keys()));
  const short = new Map(plan.short.map((id) => {
    const shop = game.actors.get(id);
    return [id, `${shop?.name ?? "The shop"} ${canPay(shop)}, and would owe ${formatCp(-s.shops.get(id))}.`];
  }));
  return { buys, sales, ...s, short, empty: !buys.length && !sales.length };
}
/** Each shop's purse, for planTrade. */
const shopInfo = (ids) => new Map([...ids].map((id) => {
  const shop = game.actors.get(id);
  return [id, { unlimited: !!shop && shopConf(shop).unlimited, funds: shop ? fundsCp(shop) : 0 }];
}));

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

/** Requests waiting for the GM's answer (rid: { kind, timer }). While one is out, that button waits: a second click
 * would be a second trade. An answer that comes after the timeout still counts (`late`). */
const pending = new Map();
const late = new Map();
const waitingFor = (kind) => [...pending.values()].some((p) => p.kind === kind);
function askGM(msg) {
  if (!game.users.activeGM) {
    ui.notifications.warn("Marketplace: a GM needs to be logged in to trade.");
    return false;
  }
  const rid = foundry.utils.randomID(16);
  pending.set(rid, { kind: msg.type, timer: setTimeout(() => {
    pending.delete(rid);
    late.set(rid, { kind: msg.type, t: Date.now() });
    setTimeout(() => {
      late.delete(rid);
      refresh();
    }, 600000);
    ui.notifications.warn("Marketplace: the GM's client hasn't answered yet. Check your inventory before trying again.");
    refresh();
  }, 30000) });
  game.socket.emit(SOCKET, { ...msg, rid });
  refresh();
  return rid;
}
function answered(rid) {
  if (!rid) return false;
  if (pending.has(rid)) {
    clearTimeout(pending.get(rid).timer);
    pending.delete(rid);
    return true;
  }
  return late.delete(rid);
}

/* Which GM tab takes a request. The lead tab claims it at once (telling the other tabs) and acts. Any other tab of the
 * primary GM waits a moment for a claim and acts if none came, so a leader that closed without saying goodbye, or a
 * tab that has only just loaded, doesn't leave players unanswered or answered twice. Requests already taken are
 * remembered for ten minutes, so a repeated message isn't a second trade. */
const STARTED = Date.now();
const handled = new Map();
function takeRequest(msg, sender) {
  if (!isPrimaryGM()) return;
  const rid = typeof msg.rid === "string" ? msg.rid.slice(0, 40) : "";
  if (!rid) return;
  const key = `${sender.id}.${rid}`;
  const now = Date.now();
  for (const [k, t] of handled) if (now - t > 600000) handled.delete(k);
  if (handled.has(key)) return;
  const go = () => {
    if (handled.has(key)) return;
    handled.set(key, Date.now());
    game.socket.emit(SOCKET, { type: "claim", key });
    onRequest(msg, sender);
  };
  if (iAmLeader() && now - STARTED > 4000) go();
  else setTimeout(go, 1500 + Math.floor(Math.random() * 700));
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

/** Take each planned quantity out of its actor, checking the live quantity first. Returns what was taken (to put
 * back); on any failure puts back what it took and throws. */
async function takeAll(plan, changed) {
  const taken = [];
  try {
    for (const p of plan) {
      if (!p.item.parent || quantityOf(p.item) < p.qty) throw new Refused(changed);
      const snap = p.item.toObject();
      await takeFromStock(p.item, p.qty);
      taken.push({ actor: p.item.parent, snap, qty: p.qty });
    }
  } catch (err) {
    await putBack(taken);
    throw err;
  }
  return taken;
}
/** Put taken quantities back where they came from (stacked with what's left, or as the item again). */
async function putBack(taken) {
  for (const t of taken.reverse()) {
    const data = foundry.utils.deepClone(t.snap);
    data.system.quantity = t.qty;
    const left = t.actor.items.get(data._id);
    // What's left of the stack takes it back; a stack taken whole comes back with its own id, so carts still find it.
    const put = left ? left.update({ "system.quantity": quantityOf(left) + t.qty }, { pmkInternal: true }) : t.actor.createEmbeddedDocuments("Item", [data], { keepId: true });
    await put.catch((err) => console.error(`${MOD} | couldn't put ${t.qty} ${data.name} back on ${t.actor.name}`, err));
  }
}

/**
 * Make a trade (on the GM's client, or a GM's own): the trader buys `lines` and sells `sales`. Everything is checked
 * before anything moves: the trader is the sender's, each shop is open to them (and buys from customers, for a sale),
 * each item is there in that quantity, the totals match what the trader saw, and the money is there. Sales settle with
 * purchases, so at each shop only the difference changes hands, and the trader pays (or gets) only the difference.
 */
async function processTrade(msg, sender) {
  const lines = cleanLines(msg.lines);
  const trader = game.actors.get(String(msg.trader ?? ""));
  if (!trader || !buyersFor(sender, [trader]).length) throw new Refused("you can't trade for that character.");
  const sales = cleanSales(msg.sales).filter((l) => l.actor === trader.id);
  if (!lines.length && !sales.length) throw new Refused("the cart is empty.");
  const buys = [];
  for (const l of lines) {
    const shop = game.actors.get(l.shop);
    if (!isMerchant(shop)) throw new Refused("a shop in the cart is gone.");
    if (!tradeMarketFor(shop.id, sender)) throw new Refused(`${shop.name} isn't open for trade.`);
    const item = shop.items.get(l.item);
    if (!item || !sellable(item)) throw new Refused(`something in the cart from ${shop.name} isn't for sale any more.`);
    const pct = pricePct(shop, trader);
    if (pct === null) throw new Refused(`${shopFace(shop, sender)} won't trade with ${trader.name}.`);
    if (isFormulaItem(item)) {
      // A formula is a copy: the shop keeps the item, the trader learns it and gets a parchment.
      const uuid = formulaUuid(item);
      const name = `Formula: ${realItem(item).name}`;
      if (!uuid) throw new Refused(`something in the cart from ${shop.name} isn't for sale any more.`);
      if (trader.type !== "character") throw new Refused("only characters learn formulas.");
      if (l.qty !== 1) throw new Refused(`one copy of ${name} is enough.`);
      if (knowsFormula(trader, uuid)) throw new Refused(`${trader.name} already knows ${realItem(item).name}.`);
      if (buys.some((b) => b.uuid === uuid)) throw new Refused(`${name} is in the cart twice.`);
      const { cp, per } = itemPrice(item);
      buys.push({ shop: shop.id, shopDoc: shop, item, qty: 1, price: buyPrice(cp, per, 1, pct, false, true), name, uuid, formula: true });
      continue;
    }
    if (l.qty > quantityOf(item)) throw new Refused(`${shop.name} has only ${quantityOf(item)} of ${realItem(item).name}.`);
    const { cp, per } = priceOf(item);
    buys.push({ shop: shop.id, shopDoc: shop, item, qty: l.qty, price: buyPrice(cp, per, l.qty, pct, isTreasure(item)), name: realItem(item).name });
  }
  const sold = [];
  for (const l of sales) {
    const shop = game.actors.get(l.shop);
    if (!isMerchant(shop)) throw new Refused("a shop in the cart is gone.");
    if (!tradeMarketFor(shop.id, sender)) throw new Refused(`${shop.name} isn't open for trade.`);
    const conf = shopConf(shop);
    if (!conf.buys) throw new Refused(`${shop.name} doesn't buy from customers.`);
    const pct = pricePct(shop, trader);
    if (pct === null) throw new Refused(`${shopFace(shop, sender)} won't trade with ${trader.name}.`);
    const item = trader.items.get(l.item);
    if (!item) throw new Refused("something you offered isn't in your inventory any more.");
    if (item.isIdentified === false) throw new Refused("identify it before you sell it.");
    if (!canSellToShop(item)) throw new Refused(`${shop.name} won't buy ${item.name} as it is.`);
    if (l.qty > quantityOf(item)) throw new Refused(`${trader.name} has only ${quantityOf(item)} of ${item.name}.`);
    const { cp, per } = priceOf(item);
    sold.push({ shop: shop.id, shopDoc: shop, conf, item, qty: l.qty, offer: offerFor(cp, per, l.qty, sellRate(conf, isTreasure(item), pctFor(pct, isTreasure(item)))), name: item.name });
  }
  const s = settle(buys, sold);
  if (Number(msg.buy) !== s.buy || Number(msg.sell) !== s.sell) throw new Refused("prices, offers or stock changed since you looked. Check the cart and try again.");
  if (s.net > 0 && fundsCp(trader) < s.net) throw new Refused(`${trader.name} hasn't enough money: the trade costs ${formatCp(s.net)}.`);
  const shopDoc = (id) => buys.find((b) => b.shop === id)?.shopDoc ?? sold.find((x) => x.shop === id)?.shopDoc;
  const plan = planTrade(s, shopInfo(s.shops.keys()));
  for (const id of plan.short) throw new Refused(`${shopDoc(id).name} ${canPay(shopDoc(id))}.`);
  // A price set by hand on the trader's item (or homebrew with no compendium entry) is flagged for the GM, not refused.
  const notes = new Map();
  for (const x of sold) {
    const h = await handPriced(x.item);
    if (h) notes.set(x.shop, [...(notes.get(x.shop) ?? []), handPricedNote(x.name, h)]);
  }

  // The copies are made before anything changes. Then: the shops' stock and the trader's goods come out (checked again
  // against what's there now), the shops that owe pay, the trader pays, the trader gets what they bought, the shops get
  // what they bought. A step that fails undoes the ones before it, deliveries included. After that the trade stands;
  // the money still to go in is paid, and a payment that fails is noted for the GM rather than undoing the trade.
  const boughtCopies = buys.map((b) => (b.formula ? parchmentData(realItem(b.item).name, b.uuid) : boughtCopy(b.item, b.qty)));
  const learned = buys.filter((b) => b.formula).map((b) => b.uuid);
  const soldCopies = sold.map((x) => ({ shop: x.shopDoc, data: soldCopy(x.item, x.qty, MOD, x.conf.keepSold) }));
  const changed = "the stock or your inventory changed. Check the cart and try again.";
  const taken = await takeAll(buys.filter((b) => !b.formula), changed);
  try {
    taken.push(...(await takeAll(sold, changed)));
  } catch (err) {
    await putBack(taken);
    throw err;
  }
  const paid = [];
  const delivered = [];
  let knew = null;
  const undo = async () => {
    if (knew) await restoreFormulas(trader, knew).catch((e) => console.error(`${MOD} | couldn't take back the formulas given to ${trader.name}`, e));
    for (const d of delivered.reverse()) await undeliver(d);
    for (const [actor, n] of paid.reverse()) await receive(actor, n).catch((e) => console.error(`${MOD} | couldn't give ${actor.name} back ${n} cp`, e));
    await putBack(taken);
  };
  for (const [id, n] of plan.owing) {
    const shop = shopDoc(id);
    if (!(await pay(shop, n).catch(() => false))) {
      await undo();
      throw new Refused(`${shop.name} ${canPay(shop)}.`);
    }
    paid.push([shop, n]);
  }
  if (s.net > 0) {
    if (!(await pay(trader, s.net).catch(() => false))) {
      await undo();
      throw new Refused(`${trader.name} hasn't enough money: the trade costs ${formatCp(s.net)}.`);
    }
    paid.push([trader, s.net]);
  }
  try {
    delivered.push(await deliver(trader, boughtCopies));
    for (const c of soldCopies) delivered.push(await deliver(c.shop, [c.data], giveSold));
    if (learned.length) {
      const before = foundry.utils.deepClone(trader._source?.system?.crafting?.formulas ?? []);
      knew = before;
      await addFormulas(trader, learned);
    }
  } catch (err) {
    await undo();
    throw err;
  }
  const unpaid = [];
  for (const [id, n] of plan.receipts) {
    await receive(shopDoc(id), n).catch((err) => {
      console.error(`${MOD} | ${shopDoc(id).name} wasn't paid ${n} cp`, err);
      unpaid.push(`${shopDoc(id).name} wasn't paid ${formatCp(n)}`);
    });
  }
  if (s.net < 0) {
    await receive(trader, -s.net).catch((err) => {
      console.error(`${MOD} | ${trader.name} wasn't paid ${-s.net} cp`, err);
      unpaid.push(`${trader.name} wasn't paid ${formatCp(-s.net)}`);
    });
  }

  // The log keeps purchases and sales apart, one entry each per shop.
  const market = (id) => tradeMarketFor(id, sender)?.name ?? "";
  const unpaidNote = unpaid.join("; ");
  for (const id of new Set([...buys.map((b) => b.shop), ...sold.map((x) => x.shop)])) {
    const b = buys.filter((x) => x.shop === id), x = sold.filter((y) => y.shop === id);
    const shop = shopDoc(id);
    const note = [...(notes.get(id) ?? []), unpaidNote].filter(Boolean).join("; ");
    if (b.length) logTrade({ kind: "buy", user: sender.name, actor: trader.name, shop: shop.name, market: market(id), items: b.map((p) => ({ name: p.name, qty: p.qty })), cp: b.reduce((n, p) => n + p.price, 0), note: x.length ? "" : unpaidNote });
    if (x.length) logTrade({ kind: "sell", user: sender.name, actor: trader.name, shop: shop.name, market: market(id), items: x.map((p) => ({ name: p.name, qty: p.qty })), cp: x.reduce((n, p) => n + p.offer, 0), note });
  }
  const named = (list) => list.map((p) => (p.qty > 1 ? `${p.name} ×${p.qty}` : p.name));
  return { trader: trader.name, buy: s.buy, sell: s.sell, net: s.net, bought: named(buys), soldNames: named(sold), note: [...notes.values()].flat().join("; "), unpaid: unpaidNote, lines, sales };
}

/** Open a shop item's sheet. The GM gets the real item; a player gets a read-only copy of it as the shop sells it
 * (identified), since players can't open a merchant's items. */
function showShopItem(shop, itemId, isGM) {
  const item = shop?.items.get(itemId);
  if (!item) return;
  if (isGM) return void item.sheet.render(true);
  const data = item.toObject();
  delete data._id;
  if (data.system?.identification) data.system.identification.status = "identified";
  data.ownership = { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER };
  const copy = new CONFIG.Item.documentClass(data);
  copy.sheet.render(true, { editable: false });
}

/** Give an actor items, remembering what was there before, so it can be undone. */
async function deliver(actor, datas, give = giveItems) {
  const before = new Map(actor.items.map((i) => [i.id, quantityOf(i)]));
  const record = { actor, before };
  try {
    await give(actor, datas);
  } catch (err) {
    // Part of it may have landed.
    await undeliver(record);
    throw err;
  }
  return record;
}
/** What a shop bought from a player: stacked only with the same item it bought earlier and still holds for as many
 * restocks, never with its staples or rotating stock (the system's stacking ignores the stock mark). */
async function giveSold(shop, datas) {
  for (const data of datas) {
    const src = sourceKey(data._stats?.compendiumSource ?? data.flags?.core?.sourceId);
    const left = data.flags?.[MOD]?.stock?.left;
    const same = shop.items.find((i) => {
      const st = i.flags?.[MOD]?.stock;
      return st?.kind === "sold" && st.left === left && i.name === data.name && i.type === data.type
        && sourceKey(i._stats?.compendiumSource ?? i.flags?.core?.sourceId) === src && !i.system?.containerId;
    });
    if (same) await same.update({ "system.quantity": quantityOf(same) + (Number(data.system?.quantity) || 1) }, { pmkInternal: true });
    else await shop.createEmbeddedDocuments("Item", [data]);
  }
}

/** Undo a delivery: items it made are deleted, stacks it added to go back to what they were. */
async function undeliver({ actor, before }) {
  try {
    const made = actor.items.filter((i) => !before.has(i.id)).map((i) => i.id);
    if (made.length) await actor.deleteEmbeddedDocuments("Item", made);
    const grown = actor.items.filter((i) => before.has(i.id) && quantityOf(i) > before.get(i.id)).map((i) => ({ _id: i.id, "system.quantity": before.get(i.id) }));
    if (grown.length) await actor.updateEmbeddedDocuments("Item", grown, { pmkInternal: true });
  } catch (err) {
    console.error(`${MOD} | couldn't undo items given to ${actor.name}; check its inventory`, err);
    ui.notifications.error(esc(`Marketplace: a failed trade left items on ${actor.name}. Check its inventory.`), { permanent: true });
  }
}

/** What the trader is told, and what the GM sees when a player traded. */
function tradeText(r) {
  const parts = [];
  if (r.bought.length) parts.push(`bought ${listOf(r.bought)} for ${formatCp(r.buy)}`);
  if (r.soldNames.length) parts.push(`sold ${listOf(r.soldNames)} for ${formatCp(r.sell, "nothing")}`);
  const money = r.bought.length && r.soldNames.length ? (r.net > 0 ? `, paying ${formatCp(r.net)}` : r.net < 0 ? `, getting ${formatCp(-r.net)}` : ", even") : "";
  return `${r.trader} ${parts.join(" and ")}${money}.`;
}
/** The GM's notice for a trade: a warning when a price or a payment needs checking. */
function gmNotice(r, who = "") {
  const text = `Marketplace: ${who}${tradeText(r)}`;
  const check = [r.note && `Check the price: ${r.note}.`, r.unpaid && `Check the money: ${r.unpaid}.`].filter(Boolean).join(" ");
  if (check) ui.notifications.warn(esc(`${text} ${check}`), { permanent: true });
  else ui.notifications.info(esc(text));
}

/** What was traded comes out of the cart (a line raised meanwhile keeps the rest). */
function clearTraded(lines, sales) {
  const cart = loadCart();
  const bought = new Map(cleanLines(lines).map((l) => [`${l.shop}.${l.item}`, l.qty]));
  cart.lines = cart.lines.map((l) => ({ ...l, qty: l.qty - (bought.get(`${l.shop}.${l.item}`) ?? 0) })).filter((l) => l.qty >= 1);
  const sold = new Map(cleanSales(sales).map((l) => [`${l.actor}.${l.item}`, l.qty]));
  cart.sales = cart.sales.map((l) => ({ ...l, qty: l.qty - (sold.get(`${l.actor}.${l.item}`) ?? 0) })).filter((l) => l.qty >= 1);
  saveCart(cart);
  refresh();
}

/* ------------------------------------------------------------------ */
/* The Trade Post (0.3): offers between players' characters           */
/* ------------------------------------------------------------------ */

const offers = () => cleanOffers(game.settings.get(MOD, "offers"));
let offerWrites = Promise.resolve();
/** Change the offers (the GM's client), one write at a time, each on the latest copy. */
function mutateOffers(fn) {
  const run = offerWrites.catch(() => null).then(async () => {
    const list = offers();
    fn(list);
    await game.settings.set(MOD, "offers", cleanOffers(list));
  });
  offerWrites = run.catch(() => null);
  return run;
}
/** Characters a user can trade for at the Trade Post: their characters, never the party stash (a design decision). */
const tradersFor = (user) => buyersFor(user, game.actors.contents).filter((a) => a.type === "character");
/** Characters an offer can be for: any character a player owns. */
const offerTargets = () => game.actors.filter((a) => a.type === "character" && a.hasPlayerOwner);

/** Is every item of an offer's side still there, in that number? */
function sideHas(actor, items) {
  const rows = new Map(tradeRows(actor).map((r) => [r.id, r]));
  for (const l of items) {
    const r = rows.get(l.item);
    // An item renamed or identified since the offer went up isn't what the offer shows.
    if (!r || r.why || r.qty < l.qty || (l.name && r.name !== l.name)) return false;
  }
  return true;
}

/** Can this offer be taken by `taker` now? Null when it can, else why not. */
function offerProblem(offer, taker) {
  const from = game.actors.get(offer.from);
  if (!from) return "The character who posted it is gone.";
  if (!sideHas(from, offer.give.items)) return `${from.name} no longer has everything offered.`;
  const net = offerNet(offer);
  if (net < 0 && fundsCp(from) < -net) return `${from.name} hasn't the money offered.`;
  if (!taker) return null;
  if (!canAccept(offer, taker.id)) return offer.from === taker.id ? "Your own offer." : "It's for someone else.";
  if (!sideHas(taker, offer.want.items)) return `${taker.name} doesn't have everything asked for.`;
  if (net > 0 && fundsCp(taker) < net) return `${taker.name} hasn't enough money.`;
  return null;
}

/** Post an offer (the GM's client): the poster's own character, items that are theirs to trade, a target that's a
 * player's character, at most 10 offers per character. */
async function processPost(msg, sender) {
  const o = cleanOffer({ ...msg.offer, id: foundry.utils.randomID(16), user: sender.id, created: Date.now() });
  if (!o) throw new Refused("an offer needs something offered, and something asked for or offered.");
  const from = game.actors.get(o.from);
  if (!from || !tradersFor(sender).some((a) => a.id === from.id)) throw new Refused("you can't post for that character.");
  if (o.to && !offerTargets().some((a) => a.id === o.to)) throw new Refused("that character can't trade here.");
  const fromRows = new Map(tradeRows(from).map((r) => [r.id, r]));
  for (const l of o.give.items) {
    const r = fromRows.get(l.item);
    if (!r || r.why || r.qty < l.qty) throw new Refused(`${from.name} can't offer ${r?.name ?? "that"} as it is.`);
    Object.assign(l, { name: r.name, img: r.img });
  }
  if (o.want.items.length) {
    const to = game.actors.get(o.to);
    const toRows = new Map(tradeRows(to).map((r) => [r.id, r]));
    for (const l of o.want.items) {
      const r = toRows.get(l.item);
      if (!r || r.why || r.qty < l.qty) throw new Refused(`${to.name} hasn't ${r?.name ?? "that"} to trade.`);
      Object.assign(l, { name: r.name, img: r.img });
    }
  }
  if (offers().filter((x) => x.from === from.id).length >= MAX_OFFERS_EACH) throw new Refused(`${from.name} already has ${MAX_OFFERS_EACH} offers up.`);
  if (offers().length >= MAX_OFFERS) throw new Refused("the Trade Post is full. Ask the GM to clear some offers.");
  const problem = offerProblem(o, null);
  if (problem) throw new Refused(problem);
  await mutateOffers((list) => list.unshift(o));
  return { text: `${from.name}'s offer is up at the Trade Post.`, posted: true };
}

/** Take an offer down: the poster, or a GM. */
async function processWithdraw(msg, sender) {
  const o = offers().find((x) => x.id === msg.id);
  if (!o) throw new Refused("that offer is already gone.");
  if (!sender.isGM && !tradersFor(sender).some((a) => a.id === o.from)) throw new Refused("it isn't your offer.");
  await mutateOffers((list) => {
    const i = list.findIndex((x) => x.id === o.id);
    if (i >= 0) list.splice(i, 1);
  });
  return { text: "The offer is down." };
}

/** An item's data as it moves between characters: the quantity, out of any container, carried, the module's marks
 * dropped. Identification stays as it was. */
function tradeCopy(item, qty) {
  const data = item.toObject();
  delete data._id;
  data.system ??= {};
  data.system.quantity = qty;
  data.system.containerId = null;
  const worn = item.system?.usage?.type === "worn" && item.system?.usage?.where;
  data.system.equipped = worn ? { carryType: "worn", inSlot: false } : { carryType: "worn" };
  if (data.flags?.[MOD]) delete data.flags[MOD];
  return data;
}

/** Take an offer (the GM's client): everything checked again, then both sides' items out, the money settled (only the
 * difference moves), the items in, the offer down. A step that fails undoes the ones before it. */
async function processAccept(msg, sender) {
  const o = offers().find((x) => x.id === msg.id);
  if (!o) throw new Refused("that offer is gone.");
  const taker = game.actors.get(String(msg.actor ?? ""));
  if (!taker || !tradersFor(sender).some((a) => a.id === taker.id)) throw new Refused("you can't trade for that character.");
  const from = game.actors.get(o.from);
  const problem = offerProblem(o, taker);
  if (problem) throw new Refused(problem);
  const plan = [
    ...o.give.items.map((l) => ({ item: from.items.get(l.item), qty: l.qty, to: taker })),
    ...o.want.items.map((l) => ({ item: taker.items.get(l.item), qty: l.qty, to: from })),
  ];
  const copies = plan.map((p) => ({ to: p.to, data: tradeCopy(p.item, p.qty) }));
  const net = offerNet(o);
  const taken = await takeAll(plan, "an inventory changed. Look at the offer again.");
  const delivered = [];
  let paid = null;
  const undo = async () => {
    for (const d of delivered.reverse()) await undeliver(d);
    if (paid) await receive(paid[0], paid[1]).catch((e) => console.error(`${MOD} | couldn't give ${paid[0].name} back ${paid[1]} cp`, e));
    await putBack(taken);
  };
  const [payer, payee, amount] = net > 0 ? [taker, from, net] : [from, taker, -net];
  if (amount > 0) {
    if (!(await pay(payer, amount).catch(() => false))) {
      await undo();
      throw new Refused(`${payer.name} hasn't enough money.`);
    }
    paid = [payer, amount];
  }
  try {
    for (const side of [taker, from]) {
      const datas = copies.filter((c) => c.to === side).map((c) => c.data);
      if (datas.length) delivered.push(await deliver(side, datas));
    }
  } catch (err) {
    await undo();
    throw err;
  }
  let unpaid = "";
  if (amount > 0) await receive(payee, amount).catch((err) => {
    console.error(`${MOD} | ${payee.name} wasn't paid ${amount} cp`, err);
    unpaid = `${payee.name} wasn't paid ${formatCp(amount)}`;
  });
  // The trade stands now: log it before anything else can fail.
  logTrade({ kind: "trade", user: game.users.get(o.user)?.name ?? "", actor: from.name, shop: taker.name, market: "Trade Post", items: o.give.items.map((l) => ({ name: l.name, qty: l.qty })), got: o.want.items.map((l) => ({ name: l.name, qty: l.qty })), net, cp: Math.abs(net), note: unpaid });
  try {
    await mutateOffers((list) => {
      const i = list.findIndex((x) => x.id === o.id);
      if (i >= 0) list.splice(i, 1);
    });
  } catch (err) {
    console.error(`${MOD} | the taken offer couldn't be taken down`, err);
  }
  const text = `${taker.name} took ${from.name}'s offer.`;
  if (o.user && o.user !== sender.id) game.socket.emit(SOCKET, { type: "notice", users: [o.user], text });
  return { text: text + (unpaid ? " Part of the money didn't arrive; the GM has been told." : ""), unpaid };
}

/** A Trade Post request: the primary GM acts at once; anyone else asks the GM's client. */
let posting = false;
async function postRequest(msg) {
  if (posting || waitingFor(msg.type)) return;
  if (isPrimaryGM()) {
    posting = true;
    refresh();
    try {
      const r = await queued(() => runPost(msg, game.user));
      ui.notifications.info(esc(`Marketplace: ${r.text}`));
      if (r.posted) for (const app of openApps) app.view.draft = null;
    } catch (err) {
      if (err instanceof Refused) ui.notifications.warn(esc(`Marketplace: ${err.message}`));
      else {
        console.error(`${MOD} | the Trade Post request failed`, err);
        ui.notifications.error("Marketplace: that didn't work. See the console.");
      }
    } finally {
      posting = false;
      refresh();
    }
    return;
  }
  askGM(msg);
}
const runPost = (msg, sender) => (msg.type === "post" ? processPost(msg, sender) : msg.type === "withdraw" ? processWithdraw(msg, sender) : processAccept(msg, sender));
const POST_TYPES = new Set(["post", "withdraw", "accept"]);

/** The active GM's client acts on a player's request. */
async function onRequest(msg, sender) {
  const reply = (extra) => game.socket.emit(SOCKET, { users: [sender.id], rid: typeof msg.rid === "string" ? msg.rid : null, ...extra });
  try {
    if (POST_TYPES.has(msg.type)) {
      const r = await queued(() => runPost(msg, sender));
      reply({ type: "done", what: msg.type, text: r.text });
      if (msg.type === "accept") ui.notifications[r.unpaid ? "warn" : "info"](esc(`Marketplace: ${sender.name}: ${r.text}${r.unpaid ? ` Check the money: ${r.unpaid}.` : ""}`), r.unpaid ? { permanent: true } : {});
      return;
    }
    if (msg.type !== "trade") return;
    const r = await queued(() => processTrade(msg, sender));
    reply({ type: "done", text: tradeText(r) + (r.unpaid ? " Part of the money didn't arrive; the GM has been told." : ""), lines: r.lines, sales: r.sales });
    gmNotice(r, `${sender.name}: `);
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
    else if (msg.type === "claim" && sender?.isGM && typeof msg.key === "string") handled.set(msg.key, Date.now());
    else if (sender && sender.id !== game.user.id && (msg.type === "trade" || POST_TYPES.has(msg.type))) takeRequest(msg, sender);
    // An assistant GM's own trades go through the primary GM's client too, and come back like a player's.
    if (msg.type !== "done" && msg.type !== "fail" && msg.type !== "notice") return;
  }
  if (!sender?.isGM) return;
  if (Array.isArray(msg.users) && !msg.users.includes(game.user.id)) return;
  if (msg.type === "notice") return void ui.notifications.info(esc(`Marketplace: ${String(msg.text ?? "")}`));
  if (msg.type !== "done" && msg.type !== "fail") return;
  // Only answers to this client's own requests (a GM answers the user, who may have two windows open).
  if (!answered(msg.rid)) return;
  refresh();
  if (msg.type === "fail") {
    ui.notifications.warn(esc(String(msg.text ?? "Marketplace: that didn't work.")));
    return refresh();
  }
  if (msg.what === "post") for (const app of openApps) app.view.draft = null;
  if (!msg.what) clearTraded(msg.lines, msg.sales);
  ui.notifications.info(esc(`Marketplace: ${String(msg.text ?? "Done.")}`));
  refresh();
}

/** Make the trade in the cart: a GM at once; a player asks the GM's client. */
let trading = false;
/** `seen` is { buy, sell } as the Pay button showed them: a cart changed since (a quantity typed a moment ago) isn't
 * traded until the player has seen the new total. */
async function checkout(seen = null) {
  if (busy()) return;
  const cart = loadCart();
  const { chosen } = buyerChoices(cart);
  if (!chosen) return void ui.notifications.warn("Marketplace: you have no character to trade for.");
  const t = tradeState(cart, chosen);
  if (t.empty) return;
  const bad = [...t.buys, ...t.sales].find((l) => l.problem);
  if (bad) return void ui.notifications.warn(esc(`Marketplace: fix the cart first: ${bad.problem}`));
  if (t.short.size) return void ui.notifications.warn(esc(`Marketplace: ${[...t.short.values()][0]}`));
  if (t.net > fundsCp(chosen)) return void ui.notifications.warn(esc(`Marketplace: ${chosen.name} hasn't enough money.`));
  if (seen && (seen.buy !== t.buy || seen.sell !== t.sell)) {
    refresh();
    return void ui.notifications.info("Marketplace: the cart changed. Check the new total and trade again.");
  }
  const msg = { type: "trade", trader: chosen.id, lines: cart.lines, sales: salesOf(cart, chosen), buy: t.buy, sell: t.sell };
  // Only the primary GM trades on their own client; an assistant GM's trade goes through it like a player's, in its queue.
  if (isPrimaryGM()) {
    trading = true;
    refresh();
    try {
      const r = await queued(() => processTrade(msg, game.user));
      clearTraded(r.lines, r.sales);
      gmNotice(r);
    } catch (err) {
      if (err instanceof Refused) ui.notifications.warn(esc(`Marketplace: ${err.message}`));
      else {
        console.error(`${MOD} | the trade failed`, err);
        ui.notifications.error("Marketplace: the trade failed partway. See the console.");
      }
    } finally {
      trading = false;
      refresh();
    }
    return;
  }
  askGM(msg);
}
/** A trade is under way: this client's own, one still waiting for the GM, or one that timed out less than two minutes
 * ago (a second click then could be the same trade twice). */
const busy = () => trading || waitingFor("trade") || [...late.values()].some((l) => l.kind === "trade" && Date.now() - l.t < 120000);

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

const LOOKS = ["dark", "hybrid", "pf2e"];
const SHEET_COLORS = ["red", "green", "blue", "purple", "brown", "black"];
function getLook() {
  try {
    const v = localStorage.getItem(storeKey("look"));
    return LOOKS.includes(v) ? v : "dark";
  } catch {
    return "dark";
  }
}
function setLook(app, look) {
  try {
    localStorage.setItem(storeKey("look"), look);
  } catch {
    /* storage off: the look lasts until the window closes */
  }
  app.look = look;
  app.render();
}

const Base = rememberWindow(foundry.applications.api.ApplicationV2, `${MOD}.size`);

class MarketApp extends Base {
  static DEFAULT_OPTIONS = {
    id: MOD,
    // The window is drawn dark, so Foundry's own inputs and buttons inside it take the dark theme too.
    classes: ["pmk", "themed", "theme-dark"],
    tag: "div",
    window: {
      title: "Marketplace",
      icon: "fa-solid fa-store",
      resizable: true,
      // Each user picks a look for their own window (kept in this browser).
      controls: [
        { icon: "fa-solid fa-moon", label: "Look: Dark", action: "pmkLookDark" },
        { icon: "fa-solid fa-book-open", label: "Look: Dark and parchment", action: "pmkLookHybrid" },
        { icon: "fa-solid fa-scroll", label: "Look: Pathfinder sheet", action: "pmkLookPf2e" },
      ],
    },
    position: { width: 1000, height: 720 },
    actions: {
      pmkLookDark: function () { setLook(this, "dark"); },
      pmkLookPf2e: function () { setLook(this, "pf2e"); },
      pmkLookHybrid: function () { setLook(this, "hybrid"); },
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
      pmkTab: MarketApp.#onTab,
      pmkSellAdd: MarketApp.#onSellAdd,
      pmkKind: MarketApp.#onKind,
      pmkFormula: MarketApp.#onFormula,
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
      pmkRestock: MarketApp.#onRestock,
      pmkRestockAll: MarketApp.#onRestockAll,
      pmkShopSettings: MarketApp.#onShopSettings,
      pmkLog: MarketApp.#onLog,
      pmkClearLog: MarketApp.#onClearLog,
    },
  };

  constructor(options = {}) {
    super(options);
    const saved = loadView();
    this.view = { market: saved.market ?? null, shop: saved.shop ?? null, cart: false, log: false, tab: "buy", query: "", open: new Set() };
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
    // Keep what's typed into a new offer through a redraw (but not right after the form changed who it's for).
    if (this.view.draft && !this.#draftSkip) this.#readDraft();
    this.#draftSkip = false;
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
    const inCart = cart.lines.length + salesOf(cart, buyerChoices(cart).chosen).length;
    // Offers one of this user's characters could take.
    const myChars = tradersFor(game.user).map((a) => a.id);
    const postCount = this.isGM ? offers().length : offers().filter((o) => myChars.some((id) => canAccept(o, id)) && !myChars.includes(o.from)).length;
    let main;
    if (this.view.post) main = this.#postHTML();
    else if (this.view.log && this.isGM) main = this.#logHTML();
    else if (this.view.cart) main = this.#cartHTML(cart);
    else if (!market) main = this.#emptyHTML();
    else if (this.view.shop) main = await this.#shopHTML(market, game.actors.get(this.view.shop));
    else main = await this.#marketHTML(market, shops);

    const look = this.look ?? getLook();
    // Parchment pages: everywhere in the Pathfinder sheet look; markets and shops in the hybrid one.
    const paper = look === "pf2e" || (look === "hybrid" && market && !this.view.cart && !this.view.post && !(this.view.log && this.isGM));
    return `<div class="pmk-shell">
      <nav class="pmk-rail">
        <div class="pmk-railhead">Markets</div>
        <div class="pmk-mks">${rail}</div>
        ${this.isGM ? `<a class="pmk-mk pmk-loglink ${this.view.log ? "active" : ""}" data-action="pmkLog"><i class="fa-solid fa-scroll pmk-noimg"></i><span class="pmk-mkn">Trade log</span></a>` : ""}
        <a class="pmk-mk pmk-postlink ${this.view.post ? "active" : ""}" data-action="pmkPost"><i class="fa-solid fa-handshake pmk-noimg"></i><span class="pmk-mkn">Trade Post</span>${postCount ? `<span class="pmk-count">${postCount}</span>` : ""}</a>
        <a class="pmk-mk pmk-cartlink ${this.view.cart ? "active" : ""}" data-action="pmkCart"><i class="fa-solid fa-cart-shopping pmk-noimg"></i><span class="pmk-mkn">Cart</span>${inCart ? `<span class="pmk-count">${inCart}</span>` : ""}</a>
        ${this.isGM ? `<button type="button" class="pmk-newmk" data-action="pmkNewMarket"><i class="fa-solid fa-plus"></i> <span>New market</span></button>` : ""}
      </nav>
      <section class="pmk-main${paper ? " pmk-paper" : ""}">${main}</section>
    </div>`;
  }

  #emptyHTML() {
    return this.isGM
      ? `<div class="pmk-empty"><i class="fa-solid fa-store"></i><p>Make a market to hold your shops: a town's market district, a bazaar, a trading post.</p>
          <button type="button" data-action="pmkNewMarket"><i class="fa-solid fa-plus"></i> New market</button></div>`
      : `<div class="pmk-empty"><i class="fa-solid fa-store"></i><p>There are no markets to visit yet.</p></div>`;
  }

  /** A line saying what players can do here: for a market, or for a shop in it (its own switches count too). */
  #statusHTML(market, shop = null) {
    const own = shop ? shopRow(shop) : null;
    if (this.isGM) {
      let text, good = false;
      if (!market.visible) text = shop ? "Hidden from players (the market is hidden)." : "Hidden from players.";
      else if (own?.hidden) text = "Hidden from players.";
      else if (!market.open) text = shop ? "Browse only (the market is closed)." : "Browse only.";
      else if (own?.closed) text = "Browse only.";
      else {
        text = "Open for trade.";
        good = true;
      }
      return `<p class="pmk-status ${good ? "pmk-good" : ""}">${text}</p>`;
    }
    const open = shop ? !!tradeMarketFor(shop.id, game.user) : market.open;
    return open ? `<p class="pmk-status pmk-good"><i class="fa-solid fa-store"></i> Open for trade.</p>`
      : `<p class="pmk-status"><i class="fa-solid fa-store-slash"></i> Browse only.</p>`;
  }

  async #marketHTML(market, shops) {
    const desc = market.description ? await TextEditor().enrichHTML(market.description, { secrets: this.isGM }) : "";
    const level = market.level !== null ? `Level ${market.level}` : "";
    const sub = [level, `${shops.length} ${shops.length === 1 ? "shop" : "shops"}`].filter(Boolean).join(" · ");
    const gmBar = this.isGM ? `<div class="pmk-gmbar">
        <button type="button" class="pmk-tog ${market.visible ? "on" : ""}" data-action="pmkToggle" data-what="visible" data-tooltip="Players see and browse this market"><i class="fa-solid ${market.visible ? "fa-eye" : "fa-eye-slash"}"></i> Visible</button>
        <button type="button" class="pmk-tog ${market.open ? "on" : ""}" data-action="pmkToggle" data-what="open" data-tooltip="Players can buy and sell here"><i class="fa-solid ${market.open ? "fa-store" : "fa-store-slash"}"></i> Open</button>
        <span class="pmk-gap"></span>
        <button type="button" data-action="pmkRestockAll" data-tooltip="${market.restockEvery ? `Every ${market.restockEvery} ${market.restockEvery === 1 ? "day" : "days"} of game time; ` : ""}restock every shop now"><i class="fa-solid fa-rotate"></i> Restock all</button>
        <button type="button" data-action="pmkNewShop"><i class="fa-solid fa-plus"></i> New shop</button>
        <button type="button" data-action="pmkEditMarket"><i class="fa-solid fa-pen"></i> Edit</button>
        <button type="button" data-action="pmkDeleteMarket" data-tooltip="Delete this market (its shops stay)"><i class="fa-solid fa-trash"></i></button>
      </div>` : "";
    const folder = market.folder ? game.folders.get(market.folder) : null;
    const cards = shops.map((s) => {
      const actor = game.actors.get(s.id);
      // As the shop page shows it: a browse-only shop players haven't seen since its last restock counts its staples.
      const staplesOnly = !this.isGM && !tradeMarketFor(s.id, game.user) && !remembered(actor);
      const count = stockRows(actor).filter((r) => !staplesOnly || cleanStock(r.stock, r.qty).kind === "staple").length;
      const marks = [
        this.isGM && s.hidden ? `<i class="fa-solid fa-eye-slash" data-tooltip="Hidden from players"></i>` : "",
        s.closed && (this.isGM || market.open) ? `<i class="fa-solid fa-store-slash" data-tooltip="${this.isGM ? "Closed: players can browse but not trade" : "Browse only for now"}"></i>` : "",
        this.isGM && s.byHand ? `<a class="pmk-x" data-action="pmkRemoveShop" data-id="${esc(s.id)}" data-tooltip="Take it out of this market (the merchant stays)"><i class="fa-solid fa-xmark"></i></a>` : "",
      ].join("");
      return `<a class="pmk-shop ${s.closed ? "pmk-closed" : ""}" data-action="pmkShop" data-id="${esc(s.id)}">
        <img src="${esc(actor?.img ?? "")}" alt="">
        <span class="pmk-shopn">${esc(s.name)}</span>
        <span class="pmk-shops">${count} ${count === 1 ? "item" : "items"}${actorLevel(actor) ? ` · level ${actorLevel(actor)}` : ""}</span>
        ${marks ? `<span class="pmk-shopm">${marks}</span>` : ""}
      </a>`;
    }).join("");
    const none = this.isGM
      ? `<p class="pmk-none">No shops yet. Use New shop, put merchants in ${folder ? `<strong>${esc(folder.name)}</strong>` : "the market's folder"}, or drag them here.</p>`
      : `<p class="pmk-none">No shops here yet.</p>`;
    const hint = this.isGM && shops.length ? `<p class="pmk-hint">Drag a merchant here to add it.</p>` : "";
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

  /** The running tally of the cart for the trader, with a way to the cart. */
  #tallyHTML(cart, trader) {
    if (!trader) return "";
    const t = tradeState(cart, trader);
    if (t.empty) return "";
    const n = (list) => list.reduce((k, l) => k + l.qty, 0);
    const bits = [];
    if (t.buys.length) bits.push(`<span>Buying ${n(t.buys)}: <strong>${esc(formatCp(t.buy))}</strong></span>`);
    if (t.sales.length) bits.push(`<span>Selling ${n(t.sales)}: <strong>${esc(formatCp(t.sell, "nothing"))}</strong></span>`);
    const net = t.net > 0 ? `${esc(trader.name)} pays <strong>${esc(formatCp(t.net))}</strong>` : t.net < 0 ? `${esc(trader.name)} gets <strong>${esc(formatCp(-t.net))}</strong>` : "Even";
    const short = t.net > fundsCp(trader);
    const bad = [...t.buys, ...t.sales].some((l) => l.problem) || t.short.size;
    return `<div class="pmk-tally ${short || bad ? "pmk-tally-bad" : ""}">
      ${bits.join(`<span class="pmk-sep">·</span>`)}<span class="pmk-sep">=</span><span class="pmk-net">${net}</span>
      ${short ? `<span class="pmk-warn">(has ${esc(formatCp(fundsCp(trader), "no money"))})</span>` : bad ? `<span class="pmk-warn"><i class="fa-solid fa-triangle-exclamation"></i> check the cart</span>` : ""}
      <span class="pmk-gap"></span>
      <button type="button" data-action="pmkCart"><i class="fa-solid fa-cash-register"></i> Checkout</button>
    </div>`;
  }

  async #shopHTML(market, actor) {
    if (!actor) return this.#marketHTML(market, shopsFor(market));
    const own = shopRow(actor);
    // Open to this user in any market that holds it (a shop can be in two), as the cart and the GM's client see it.
    const trade = !!tradeMarketFor(actor.id, game.user);
    // Browse only: players see the staples, and the rest only if they saw the shop open since its last restock.
    const staplesOnly = !trade && !this.isGM && !remembered(actor);
    const rows = shopRows(actor).filter((r) => !staplesOnly || cleanStock(r.stock, r.qty).kind === "staple");
    const conf = shopConf(actor);
    const cart = loadCart();
    const { list: buyers, chosen } = buyerChoices(cart);
    const pct = pricePct(actor, chosen);
    const keeper = conf.keeper ? game.actors.get(conf.keeper) : null;
    const face = keeperFace(keeper, this.isGM);
    const tab = this.view.tab === "sell" && trade && conf.buys && pct !== null ? "sell" : "buy";
    const purse = conf.unlimited ? "unlimited" : formatCp(fundsCp(actor), "empty");
    const gmBar = this.isGM ? `<div class="pmk-gmbar">
        <button type="button" class="pmk-tog ${own.hidden ? "" : "on"}" data-action="pmkHideShop" data-tooltip="${own.hidden ? "Hidden from players, even in a visible market" : "Players see this shop when its market is visible"}"><i class="fa-solid ${own.hidden ? "fa-eye-slash" : "fa-eye"}"></i> ${own.hidden ? "Hidden" : "Shown"}</button>
        <button type="button" class="pmk-tog ${own.closed ? "" : "on"}" data-action="pmkCloseShop" data-tooltip="${own.closed ? "Closed: players can browse it but not trade, even in an open market" : "Players can trade here when its market is open"}"><i class="fa-solid ${own.closed ? "fa-store-slash" : "fa-store"}"></i> ${own.closed ? "Closed" : "Open"}</button>
        ${conf.unlimited ? "" : `<button type="button" data-action="pmkFill" data-tooltip="Top the purse up to ${esc(formatCp(purseFor(shopLevel(actor, market), game.settings.get(MOD, "purseScale"))))} (level ${shopLevel(actor, market)})"><i class="fa-solid fa-coins"></i> Fill purse</button>`}
        <span class="pmk-gap"></span>
        <button type="button" data-action="pmkRestock" data-tooltip="Staples back, rotating stock drawn again, purse filled"><i class="fa-solid fa-rotate"></i> Restock</button>
        <button type="button" data-action="pmkDraw" data-tooltip="Draw more rotating stock now"><i class="fa-solid fa-dice"></i> Draw</button>
        <button type="button" data-action="pmkShopSettings"><i class="fa-solid fa-sliders"></i> Settings</button>
        <button type="button" data-action="pmkSheet"><i class="fa-solid fa-file-invoice"></i> Merchant sheet</button>
      </div>` : "";
    const info = attitudeInfo(actor, null);
    const gmAtt = !info.masked ? `${ATTITUDE_LABEL[info.attitude]} in general`
      : `${ATTITUDE_LABEL[info.real] ?? "No attitude"}, shown as ${ATTITUDE_LABEL[info.shown] ?? "Unknown"}: normal prices`;
    const keeperHTML = face ? `<div class="pmk-keeper"><img src="${esc(face.img)}" alt=""><div><strong>${esc(face.name)}</strong>
        ${this.isGM ? `<span class="pmk-dim">${esc(gmAtt)}</span>` : ""}</div></div>`
      : this.isGM ? `<p class="pmk-hint">Drop an NPC here for a shopkeeper, or items to stock.</p>` : "";
    const tradingAs = buyers.length ? `<label class="pmk-buyer">Trading as <select name="pmk-buyer">${buyers.map((a) => `<option value="${esc(a.id)}" ${a.id === chosen?.id ? "selected" : ""}>${esc(a.name)}${a.type === "party" ? " (party stash)" : ""}: ${esc(formatCp(fundsCp(a), "no money"))}</option>`).join("")}</select></label>` : "";
    const priceLine = !chosen ? "" : pct === null ? `<p class="pmk-status pmk-warnbox">${esc(shopFace(actor))} won't trade with ${esc(chosen.name)}.</p>`
      : pct ? `<p class="pmk-status ${pct < 0 ? "pmk-good" : ""}">Prices for ${esc(chosen.name)}: ${pct < 0 ? `${-pct}% off` : `${pct}% more`}${attitudeInfo(actor, chosen).masked ? "" : ` (${esc(ATTITUDE_LABEL[attitudeFor(actor, chosen)])})`}.</p>` : "";
    const tabs = trade && conf.buys && pct !== null ? `<nav class="pmk-tabs"><a class="${tab === "buy" ? "active" : ""}" data-action="pmkTab" data-tab="buy"><i class="fa-solid fa-cart-shopping"></i> Buy</a><a class="${tab === "sell" ? "active" : ""}" data-action="pmkTab" data-tab="sell"><i class="fa-solid fa-hand-holding-dollar"></i> Sell</a></nav>` : "";
    const body = tab === "sell" ? this.#sellHTML(actor, chosen, conf, cart) : await this.#stockHTML(actor, rows, trade && pct !== null, pct ?? 0, cart, chosen);
    return `<div class="pmk-shopview pmk-keeperdrop">
      ${chosen ? this.#tallyHTML(cart, chosen) : ""}
      <header class="pmk-shead">
        <a class="pmk-back" data-action="pmkBack"><i class="fa-solid fa-arrow-left"></i> ${esc(market.name)}</a>
        <div class="pmk-stitle"><img src="${esc(actor.img)}" alt=""><div><h2>${esc(actor.name)}</h2>
          <div class="pmk-sub">${rows.length} ${rows.length === 1 ? "item" : "items"}${shopLevel(actor, market) ? ` · level ${shopLevel(actor, market)}` : ""}${conf.buys || this.isGM ? ` · <span class="pmk-purse" data-tooltip="What the shop can pay"><i class="fa-solid fa-sack-dollar"></i> ${esc(purse)}</span>` : ""}</div></div>
          ${keeperHTML}</div>
      </header>
      ${gmBar}
      ${this.#statusHTML(market, actor)}
      ${staplesOnly ? `<p class="pmk-hint">Staples only: the stock has changed since your last visit.</p>` : ""}
      ${trade ? tradingAs : ""}
      ${trade ? priceLine : ""}
      ${tabs}
      ${body}
    </div>`;
  }

  /** The Buy tab: the shop's stock, priced for the chosen buyer. */
  async #stockHTML(actor, rows, trade, pct, cart, buyer) {
    const inCart = new Map(cart.lines.filter((l) => l.shop === actor.id).map((l) => [l.item, l.qty]));
    const groups = groupStock(rows, this.view.query);
    const list = [];
    for (const [, label, items] of groups) {
      list.push(`<div class="pmk-gh">${esc(label)} <span class="pmk-count">${items.length}</span></div>`);
      for (const r of items) {
        const open = this.view.open.has(r.id);
        const rar = RARITY[r.rarity] ? `<span class="pmk-rar pmk-${esc(r.rarity)}">${RARITY[r.rarity]}</span>` : "";
        // A formula: not for a character who knows it, nor for the party stash.
        const knows = r.formula && buyer && (buyer.type !== "character" || knowsFormula(buyer, r.uuid));
        const note = r.holds ? `<span class="pmk-note">holds ${r.holds} ${r.holds === 1 ? "item" : "items"}; not for sale as it is</span>`
          : knows ? `<span class="pmk-note">${buyer.type === "character" ? `${esc(buyer.name)} knows it` : "characters only"}</span>` : "";
        const kind = this.isGM ? this.#kindHTML(r) + this.#formulaHTML(r) : "";
        const shown = buyPrice(r.cp, r.per, r.per, pct, r.type === "treasure", r.formula);
        const was = pct && shown !== r.cp ? ` <s class="pmk-per">${esc(formatCp(r.cp))}</s>` : "";
        const price = `${esc(formatCp(shown))}${was}${r.per > 1 ? ` <span class="pmk-per">for ${r.per}</span>` : ""}`;
        list.push(`<div class="pmk-row ${open ? "open" : ""} ${r.qty ? "" : "pmk-out"}" data-action="pmkItem" data-id="${esc(r.id)}">
          <img src="${esc(r.img)}" alt="">
          <span class="pmk-rn">${esc(r.name)} ${rar}${kind}${note}</span>
          <span class="pmk-lvl">${r.level}</span>
          <span class="pmk-qty">${r.formula ? "copy" : r.qty ? `×${r.qty}` : "sold out"}</span>
          <span class="pmk-price">${price}</span>
          ${this.#addHTML(r, trade && !knows && (!r.formula || !!r.uuid), inCart.get(r.id) ?? 0)}
        </div>`);
        if (open) list.push(`<div class="pmk-rdesc">${await this.#description(actor, r.id) || `<p class="pmk-none">No description.</p>`}</div>`);
      }
    }
    const body = rows.length ? (list.length ? list.join("") : `<p class="pmk-none">Nothing here matches "${esc(this.view.query)}".</p>`)
      : `<p class="pmk-none">Nothing in stock.</p>`;
    return `<label class="pmk-search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" name="pmk-q" value="${esc(this.view.query)}" placeholder="Search this shop" autocomplete="off"></label>
      <div class="pmk-stock">
        <div class="pmk-rowhead"><span></span><span>Item</span><span>Level</span><span>Stock</span><span>Price</span><span></span></div>
        ${body}
      </div>`;
  }

  /** The GM's stock mark on a row: staple (and what it restocks to), rotating, or sold (restocks left). A click swaps
   * staple and rotating; a right-click on a staple sets what it restocks to. */
  #kindHTML(r) {
    const st = cleanStock(r.stock, r.qty);
    const label = st.kind === "staple" ? `Staple ${st.qty}` : st.kind === "rotating" ? "Rotating" : `Sold · ${st.left} left`;
    const tip = st.kind === "staple" ? `Comes back to ${st.qty} on a restock. Click: rotating. Right-click: set the number.`
      : st.kind === "rotating" ? "Cleared on a restock. Click: staple."
      : `Sold by a player; gone after ${st.left} more ${st.left === 1 ? "restock" : "restocks"}. Click: staple.`;
    return `<a class="pmk-kind pmk-kind-${st.kind}" data-action="pmkKind" data-id="${esc(r.id)}" data-tooltip="${esc(tip)}">${esc(label)}</a>`;
  }

  /** The GM's formula mark: a click sells the item as a formula (or not); a right-click on a formula sets its price. */
  #formulaHTML(r) {
    const tip = r.formula ? `Sold as a formula at ${formatCp(r.cp)}. Click: sell the item. Right-click: set the price.` : "Click: sell as a formula.";
    return `<a class="pmk-fmark ${r.formula ? "on" : ""}" data-action="pmkFormula" data-id="${esc(r.id)}" data-tooltip="${esc(tip)}"><i class="fa-solid fa-scroll"></i></a>`;
  }

  /** The Sell tab: what the chosen character carries, with the shop's offer for each. Choices go into the cart. */
  #sellHTML(shop, seller, conf, cart) {
    if (!seller) return `<p class="pmk-none">You have no character to sell for.</p>`;
    if (pricePct(shop, seller) === null) return "";
    const rows = sellRows(seller);
    const pct = pricePct(shop, seller) ?? 0;
    const offer = (r, qty) => offerFor(r.cp, r.per, qty, sellRate(conf, r.treasure, pctFor(pct, r.treasure)));
    const offered = new Map(salesOf(cart, seller).map((l) => [l.item, l]));
    let total = 0;
    const list = rows.map((r) => {
      const line = offered.get(r.id);
      const here = line?.shop === shop.id ? Math.min(line.qty, r.qty) : 0;
      const elsewhere = line && line.shop !== shop.id ? game.actors.get(line.shop) : null;
      if (!r.why) total += offer(r, here);
      const each = offer(r, r.per);
      const note = r.why ? esc(r.why) : `${!r.cp ? "worth nothing" : `${each ? esc(formatCp(each)) : "under 1 cp"}${r.per > 1 ? ` for ${r.per}` : " each"}`}${elsewhere ? `; offered to ${esc(elsewhere.name)}` : ""}`;
      return `<div class="pmk-srow ${r.why ? "pmk-no" : ""}" data-id="${esc(r.id)}">
        <img src="${esc(r.img)}" alt="">
        <span class="pmk-rn">${esc(r.name)}<span class="pmk-note">${note}</span></span>
        <span class="pmk-qty">×${r.qty}</span>
        ${r.why ? "<span></span>" : `<input type="number" class="pmk-qtyin" name="pmk-saleqty" data-shop="${esc(shop.id)}" data-item="${esc(r.id)}" value="${here}" min="0" max="${r.qty}" step="1">`}
        <span class="pmk-price">${r.why || !here ? "" : esc(formatCp(offer(r, here), "nothing"))}</span>
        ${r.why ? `<span class="pmk-add"></span>` : this.#sellBtnHTML(r, here)}
      </div>`;
    }).join("");
    const short = !conf.unlimited && total > fundsCp(shop) ? `<p class="pmk-status pmk-warnbox">${esc(shop.name)} ${esc(canPay(shop))}.</p>` : "";
    return `${short}<div class="pmk-stock">
        <div class="pmk-srowhead"><span></span><span>Item</span><span>Have</span><span>Sell</span><span>Offer</span><span></span></div>
        ${list || `<p class="pmk-none">${esc(seller.name)} has nothing to sell.</p>`}
      </div>`;
  }

  /** The Trade Post: offers between players' characters. */
  #postHTML() {
    // A GM watches the Trade Post: no character of their own, so they remove offers but never accept or post for one.
    const traders = this.isGM ? [] : tradersFor(game.user);
    const me = traders.find((a) => a.id === this.view.postAs) ?? traders[0] ?? null;
    if (this.view.draft && me) return this.#draftHTML(me, traders);
    const list = offers();
    const mine = new Set(traders.map((a) => a.id));
    const chip = (l) => `<span class="pmk-chip"><img src="${esc(l.img)}" alt="">${esc(l.name)}${l.qty > 1 ? ` ×${l.qty}` : ""}</span>`;
    // Offers for the character trading, open to them, theirs or another of the user's (a GM sees them all below).
    const side = (s) => [...s.items.map(chip), s.cp ? `<span class="pmk-chip pmk-coins"><i class="fa-solid fa-coins"></i>${esc(formatCp(s.cp))}</span>` : ""].join("") || `<span class="pmk-dim">nothing</span>`;
    const card = (o) => {
      const from = game.actors.get(o.from);
      const to = o.to ? game.actors.get(o.to) : null;
      const own = mine.has(o.from);
      const canTake = !!me && canAccept(o, me.id);
      const problem = canTake ? offerProblem(o, me) : offerProblem(o, null);
      const act = own || this.isGM
        ? `<button type="button" data-action="pmkWithdraw" data-id="${esc(o.id)}"><i class="fa-solid fa-xmark"></i> ${own ? "Take down" : "Remove"}</button>` : "";
      const take = canTake ? (posting || waitingFor("accept") ? `<button type="button" disabled><i class="fa-solid fa-hourglass-half"></i> Waiting...</button>`
        : `<button type="button" data-action="pmkAccept" data-id="${esc(o.id)}" ${problem ? "disabled" : ""}><i class="fa-solid fa-handshake"></i> Accept</button>`) : "";
      return `<div class="pmk-offer ${problem ? "pmk-stale" : ""}">
        <div class="pmk-ohead"><img src="${esc(from?.img ?? "")}" alt=""><strong>${esc(from?.name ?? "Gone")}</strong>
          <span class="pmk-dim">${o.to ? `for ${esc(to?.name ?? "a character who's gone")}` : "for anyone"}</span><span class="pmk-gap"></span>${take}${act}</div>
        <div class="pmk-oside"><span class="pmk-olabel">Gives</span>${side(o.give)}</div>
        <div class="pmk-oside"><span class="pmk-olabel">Wants</span>${side(o.want)}</div>
        ${o.note ? `<p class="pmk-onote">${esc(o.note)}</p>` : ""}
        ${problem && (canTake || own) ? `<p class="pmk-note pmk-warn">${esc(problem)}</p>` : ""}
      </div>`;
    };
    // Each offer once: for the character trading, open to them, theirs or another of the user's, or (for the GM) others.
    const forMe = list.filter((o) => me && o.to === me.id);
    const open = list.filter((o) => !o.to && o.from !== me?.id && !mine.has(o.from));
    const own = list.filter((o) => mine.has(o.from) && !forMe.includes(o));
    const others = this.isGM ? list.filter((o) => !forMe.includes(o) && !open.includes(o) && !own.includes(o)) : [];
    const section = (title, items) => (items.length ? `<h3 class="pmk-h">${title}</h3><div class="pmk-offers">${items.map(card).join("")}</div>` : "");
    const as = traders.length ? `<label class="pmk-buyer">Trading as <select name="pmk-postas">${traders.map((a) => `<option value="${esc(a.id)}" ${a.id === me?.id ? "selected" : ""}>${esc(a.name)}: ${esc(formatCp(fundsCp(a), "no money"))}</option>`).join("")}</select></label>` : "";
    const body = section("For you", forMe) + section("Open offers", open) + section("Between other characters", others) + section("Your offers", own);
    return `<div class="pmk-postview">
      <header class="pmk-shead"><a class="pmk-back" data-action="pmkCartBack"><i class="fa-solid fa-arrow-left"></i> Back to the market</a><h2>Trade Post</h2></header>
      <div class="pmk-gmbar">${as}<span class="pmk-gap"></span>${me ? `<button type="button" data-action="pmkNewOffer"><i class="fa-solid fa-plus"></i> New offer</button>` : ""}</div>
      ${body || `<p class="pmk-none">No offers yet.</p>`}
    </div>`;
  }

  /** A new offer: what the character gives, who it's for, and what they want. */
  #draftHTML(me, traders) {
    if (!me) return `<p class="pmk-none">You have no character to trade for.</p>`;
    const d = this.view.draft;
    const targets = offerTargets().filter((a) => a.id !== me.id);
    const to = targets.find((a) => a.id === d.to) ?? null;
    const rows = (actor, key, picked) => tradeRows(actor).map((r) => `<div class="pmk-srow ${r.why ? "pmk-no" : ""}">
        <img src="${esc(r.img)}" alt=""><span class="pmk-rn">${esc(r.name)}${r.why ? `<span class="pmk-note">${esc(r.why)}</span>` : ""}</span>
        <span class="pmk-qty">×${r.qty}</span>
        ${r.why ? "<span></span>" : `<input type="number" class="pmk-qtyin" name="${key}" data-item="${esc(r.id)}" value="${picked[r.id] ?? 0}" min="0" max="${r.qty}" step="1">`}
        <span></span><span></span></div>`).join("") || `<p class="pmk-none">Nothing to trade.</p>`;
    const coins = (key, cp) => {
      const c = { gp: Math.floor(cp / 100), sp: Math.floor((cp % 100) / 10), cp: cp % 10 };
      return `<span class="pmk-coinsin">${["gp", "sp", "cp"].map((k) => `<label><input type="number" name="${key}-${k}" value="${c[k] || ""}" min="0" step="1" placeholder="0"> ${k}</label>`).join("")}</span>`;
    };
    return `<div class="pmk-postview">
      <header class="pmk-shead"><a class="pmk-back" data-action="pmkOfferCancel"><i class="fa-solid fa-arrow-left"></i> Trade Post</a><h2>New offer from ${esc(me.name)}</h2></header>
      <label class="pmk-buyer">For <select name="d-to"><option value="">Anyone</option>${targets.map((a) => `<option value="${esc(a.id)}" ${a.id === to?.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label>
      <h3 class="pmk-h">${esc(me.name)} gives</h3>
      <div class="pmk-stock">${rows(me, "d-give", d.give)}</div>
      <div class="pmk-buyer">Coins ${coins("d-gcp", d.giveCp)}</div>
      <h3 class="pmk-h">${to ? `${esc(to.name)} gives` : "Asking for"}</h3>
      ${to ? `<div class="pmk-stock">${rows(to, "d-want", d.want)}</div>` : `<p class="pmk-hint">An offer for anyone can only ask for coins.</p>`}
      <div class="pmk-buyer">Coins ${coins("d-wcp", d.wantCp)}</div>
      <label class="pmk-buyer pmk-wide">Note <input type="text" name="d-note" value="${esc(d.note)}" maxlength="300" placeholder="Optional"></label>
      <div class="pmk-checkout"><button type="button" data-action="pmkOfferCancel">Cancel</button>
        ${posting || waitingFor("post") ? `<button type="button" disabled><i class="fa-solid fa-hourglass-half"></i> Waiting...</button>` : `<button type="button" data-action="pmkOfferPost"><i class="fa-solid fa-thumbtack"></i> Post the offer</button>`}</div>
    </div>`;
  }

  /** Read the new offer's form into the view. */
  #draftSkip = false;
  #readDraft() {
    const d = this.view.draft;
    // Only while the form is on screen: a redraw from elsewhere in the window mustn't wipe it.
    if (!d || !this.element?.querySelector('[name="d-note"]')) return;
    const el = this.element;
    const v = (name) => el.querySelector(`[name="${name}"]`)?.value ?? "";
    const qtys = (key) => Object.fromEntries([...el.querySelectorAll(`input[name="${key}"]`)].map((i) => [i.dataset.item, Math.max(0, Math.floor(Number(i.value)) || 0)]).filter(([, n]) => n > 0));
    if (el.querySelector('[name="d-to"]')) d.to = v("d-to") || null;
    d.give = qtys("d-give");
    d.want = qtys("d-want");
    d.giveCp = coinsCp({ gp: v("d-gcp-gp"), sp: v("d-gcp-sp"), cp: v("d-gcp-cp") });
    d.wantCp = coinsCp({ gp: v("d-wcp-gp"), sp: v("d-wcp-sp"), cp: v("d-wcp-cp") });
    d.note = v("d-note").slice(0, 300);
  }

  /** The GM's trade log, newest first. */
  #logHTML() {
    const log = (game.settings.get(MOD, "log") ?? []).map(cleanLogEntry).filter(Boolean);
    const rows = log.map((e) => {
      const what = listOf(e.items.map((i) => (i.qty > 1 ? `${i.name} ×${i.qty}` : i.name)));
      const got = listOf((e.got ?? []).map((i) => (i.qty > 1 ? `${i.name} ×${i.qty}` : i.name)));
      const verb = e.kind === "buy" ? `bought ${esc(what)} from` : e.kind === "sell" ? `sold ${esc(what)} to`
        : !got && e.net <= 0 ? `gave ${esc(what || "coins")} to`
        : `traded ${esc(what || "coins")} for ${esc(got || "coins")}${e.net && what && got ? ` (${e.net > 0 ? "and got" : "and paid"} ${esc(formatCp(Math.abs(e.net)))})` : ""} with`;
      const who = e.user && e.user !== e.actor ? ` <span class="pmk-dim">(${esc(e.user)})</span>` : "";
      return `<div class="pmk-logrow"><span class="pmk-dim">${esc(new Date(e.t).toLocaleString())}</span>
        <span><strong>${esc(e.actor)}</strong>${who} ${verb} <strong>${esc(e.shop)}</strong>${e.market ? ` <span class="pmk-dim">${esc(e.market)}</span>` : ""}</span>
        <span class="pmk-price ${e.kind === "buy" ? "pmk-in" : "pmk-outc"}">${e.kind === "trade" && !e.cp ? "even" : esc(formatCp(e.cp))}</span>
        ${e.note ? `<span class="pmk-lognote"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(e.note)}</span>` : ""}</div>`;
    }).join("");
    return `<div class="pmk-logview"><header class="pmk-shead"><a class="pmk-back" data-action="pmkCartBack"><i class="fa-solid fa-arrow-left"></i> Back to the market</a><h2>Trade log</h2></header>
      <div class="pmk-gmbar"><span class="pmk-dim">${log.length} ${log.length === 1 ? "trade" : "trades"}</span><span class="pmk-gap"></span>
      ${log.length ? `<button type="button" data-action="pmkClearLog"><i class="fa-solid fa-trash"></i> Clear the log</button>` : ""}</div>
      ${rows || `<p class="pmk-none">No trades yet.</p>`}</div>`;
  }

  /** The add-to-cart button for a stock row: only where this user can trade, for something in stock and for sale.
   * A click adds one (a batch for things sold in batches), a right-click takes one off. */
  #addHTML(r, trade, have) {
    if (!trade || !r.qty || r.holds) return `<span class="pmk-add"></span>`;
    const full = have >= r.qty;
    const one = r.per > 1 ? `${Math.min(r.per, Math.max(1, r.qty - have))}` : "one";
    const tip = `${full ? "All of it is in your cart" : `Click to add ${one}`}${have ? `; right-click to take ${r.per > 1 ? `${r.per}` : "one"} off` : ""}`;
    return `<span class="pmk-add"><a class="pmk-addbtn ${full ? "pmk-full" : ""}" data-action="pmkAdd" data-id="${esc(r.id)}" data-tooltip="${esc(tip)}"><i class="fa-solid fa-cart-plus"></i>${have ? `<span class="pmk-have">${have}</span>` : ""}</a></span>`;
  }

  /** The offer button for a sell row: a click offers one more (a batch), a right-click one fewer. */
  #sellBtnHTML(r, here) {
    const full = here >= r.qty;
    const step = r.per > 1 ? `${r.per}` : "one";
    const tip = `${full ? "All of it is offered" : `Click to offer ${step} more`}${here ? `; right-click for ${step} fewer` : ""}`;
    return `<span class="pmk-add"><a class="pmk-addbtn pmk-sellbtn ${full ? "pmk-full" : ""}" data-action="pmkSellAdd" data-id="${esc(r.id)}" data-tooltip="${esc(tip)}"><i class="fa-solid fa-hand-holding-dollar"></i>${here ? `<span class="pmk-have">${here}</span>` : ""}</a></span>`;
  }

  /** A quantity with minus and plus buttons, for a cart line. */
  #stepperHTML(kind, l, max) {
    const keys = `data-kind="${kind}" data-shop="${esc(l.shop)}" data-item="${esc(l.item)}"`;
    return `<span class="pmk-step">
      <a class="pmk-stepbtn" data-action="pmkStep" data-dir="-1" ${keys} data-tooltip="One fewer"><i class="fa-solid fa-minus"></i></a>
      <input type="number" class="pmk-qtyin" name="${kind === "buy" ? "pmk-qty" : "pmk-saleqty"}" ${kind === "buy" ? "" : `data-cart="1"`} data-shop="${esc(l.shop)}" data-item="${esc(l.item)}" value="${l.qty}" min="1" max="${Math.max(1, max)}" step="1">
      <a class="pmk-stepbtn" data-action="pmkStep" data-dir="1" ${keys} data-tooltip="One more"><i class="fa-solid fa-plus"></i></a>
    </span>`;
  }

  /** The cart: who's trading, what they buy and sell by shop, how it settles, and what's left after. */
  #cartHTML(cart) {
    const { list, chosen } = buyerChoices(cart);
    const back = `<a class="pmk-back" data-action="pmkCartBack"><i class="fa-solid fa-arrow-left"></i> Back to the market</a>`;
    const t = chosen ? tradeState(cart, chosen) : { empty: !cart.lines.length, buys: cartState(cart.lines, null), sales: [], buy: 0, sell: 0, net: 0, short: new Map() };
    if (t.empty) {
      return `<div class="pmk-cartview"><header class="pmk-shead">${back}<h2>Cart</h2></header>
        <p class="pmk-none">The cart is empty.</p></div>`;
    }
    const byShop = (lines) => {
      const groups = new Map();
      for (const l of lines) groups.set(l.shop, [...(groups.get(l.shop) ?? []), l]);
      return [...groups.values()];
    };
    const head = (lines) => {
      const shop = lines[0].shopDoc;
      const where = lines[0].market ? ` <span class="pmk-dim">${esc(lines[0].market.name)}</span>` : "";
      const short = t.short.get(lines[0].shop);
      return `<div class="pmk-gh">${esc(shop?.name ?? "A shop that's gone")}${where}</div>${short ? `<p class="pmk-status pmk-warnbox">${esc(short)}</p>` : ""}`;
    };
    const remove = (kind, l) => `<a class="pmk-x" data-action="pmkCartRemove" data-kind="${kind}" data-shop="${esc(l.shop)}" data-item="${esc(l.item)}" data-tooltip="Take it out of the cart"><i class="fa-solid fa-xmark"></i></a>`;
    const buying = byShop(t.buys).map((lines) => head(lines) + lines.map((l) => {
      const real = l.itemDoc ? realItem(l.itemDoc) : { name: "Gone", img: "" };
      return `<div class="pmk-crow ${l.problem ? "pmk-bad" : ""}">
        <img src="${esc(real.img)}" alt="">
        <span class="pmk-rn">${l.formula ? "Formula: " : ""}${esc(real.name)}${l.problem ? `<span class="pmk-note pmk-warn">${esc(l.problem)}</span>` : ""}</span>
        ${this.#stepperHTML("buy", l, l.stock)}
        <span class="pmk-price">${esc(formatCp(l.price))}</span>
        ${remove("buy", l)}
      </div>`;
    }).join("")).join("");
    const selling = byShop(t.sales).map((lines) => head(lines) + lines.map((l) => `<div class="pmk-crow ${l.problem ? "pmk-bad" : ""}">
        <img src="${esc(l.row?.img ?? "")}" alt="">
        <span class="pmk-rn">${esc(l.row?.name ?? "Gone")}${l.problem ? `<span class="pmk-note pmk-warn">${esc(l.problem)}</span>` : ""}</span>
        ${this.#stepperHTML("sale", l, l.row?.qty ?? 1)}
        <span class="pmk-price">${esc(formatCp(l.offer, "nothing"))}</span>
        ${remove("sale", l)}
      </div>`).join("")).join("");
    const have = chosen ? fundsCp(chosen) : 0;
    const traders = list.map((a) => `<option value="${esc(a.id)}" ${a.id === chosen?.id ? "selected" : ""}>${esc(a.name)}${a.type === "party" ? " (party stash)" : ""}: ${esc(formatCp(fundsCp(a), "no money"))}</option>`).join("");
    const short = chosen && t.net > have;
    const bad = [...t.buys, ...t.sales].some((l) => l.problem) || t.short.size;
    const noGM = !this.isGM && !game.users.activeGM;
    const why = !chosen ? "You have no character to trade for." : noGM ? "A GM needs to be logged in to trade." : bad ? "Fix the lines marked above first." : short ? `${esc(chosen.name)} is ${esc(formatCp(t.net - have))} short.` : "";
    const label = t.net > 0 ? `Pay ${formatCp(t.net)}` : t.net < 0 ? `Trade and get ${formatCp(-t.net)}` : "Trade";
    const name = chosen ? esc(chosen.name) : "";
    return `<div class="pmk-cartview">
      <header class="pmk-shead">${back}<h2>Cart</h2></header>
      <label class="pmk-buyer">Trading as ${list.length ? `<select name="pmk-buyer">${traders}</select>` : `<em>no character</em>`}</label>
      ${t.buys.length ? `<h3 class="pmk-h"><i class="fa-solid fa-cart-shopping"></i> Buying</h3><div class="pmk-stock">${buying}</div>` : ""}
      ${t.sales.length ? `<h3 class="pmk-h"><i class="fa-solid fa-hand-holding-dollar"></i> Selling</h3><div class="pmk-stock">${selling}</div>` : ""}
      <div class="pmk-total">
        ${t.buys.length ? `<div><span>Buying</span><span>${esc(formatCp(t.buy))}</span></div>` : ""}
        ${t.sales.length ? `<div><span>Selling</span><span>${t.buys.length ? "− " : ""}${esc(formatCp(t.sell, "nothing"))}</span></div>` : ""}
        <div><span>${t.net > 0 ? `${name} pays` : t.net < 0 ? `${name} gets` : "Even"}</span><strong>${t.net ? esc(formatCp(Math.abs(t.net))) : ""}</strong></div>
        ${chosen ? `<div class="pmk-dim"><span>${name} has</span><span>${esc(formatCp(have, "no money"))}</span></div>
        <div class="${short ? "pmk-warn" : "pmk-dim"}"><span>After</span><span>${short ? "not enough" : esc(formatCp(have - t.net, "nothing"))}</span></div>` : ""}
      </div>
      ${why ? `<p class="pmk-status">${why}</p>` : ""}
      <div class="pmk-checkout">${busy() ? `<button type="button" disabled><i class="fa-solid fa-hourglass-half"></i> ${trading ? "Trading..." : "Waiting for the GM..."}</button>`
        : `<button type="button" data-action="pmkCheckout" data-buy="${t.buy}" data-sell="${t.sell}" ${why ? "disabled" : ""}><i class="fa-solid fa-coins"></i> ${esc(label)}</button>`}</div>
    </div>`;
  }

  /** An item's description, enriched once per version of the item. */
  async #description(actor, itemId) {
    const item = actor.items.get(itemId);
    if (!item) return "";
    const key = `${item.uuid}|${item._stats?.modifiedTime ?? 0}`;
    if (!this.descs.has(key)) {
      const html = await TextEditor().enrichHTML(descriptionOf(item), { secrets: this.isGM, rollData: item.getRollData?.(), relativeTo: item });
      if (this.descs.size > 200) this.descs.clear();
      this.descs.set(key, html);
    }
    return this.descs.get(key);
  }

  _replaceHTML(result, content) {
    const scroller = content.querySelector(".pmk-main");
    const scroll = scroller?.scrollTop ?? 0;
    const where = scroller?.dataset.where;
    // Someone typing (the search box, a quantity) keeps their place when a change elsewhere redraws the window.
    const active = document.activeElement;
    const typing = active?.tagName === "INPUT" && active.name && content.contains(active) ? active : null;
    const sel = typing ? `input[name="${typing.name}"]${typing.dataset.item ? `[data-item="${CSS.escape(typing.dataset.item)}"]` : ""}${typing.dataset.shop ? `[data-shop="${CSS.escape(typing.dataset.shop)}"]` : ""}` : null;
    let caret = null;
    try {
      caret = typing ? [typing.selectionStart, typing.selectionEnd] : null;
    } catch {
      /* number inputs have no selection */
    }
    content.innerHTML = result;
    const main = content.querySelector(".pmk-main");
    if (main) {
      main.dataset.where = `${this.view.market}|${this.view.shop}|${this.view.cart}|${this.view.log}|${this.view.tab}|${this.view.post}|${!!this.view.draft}`;
      if (where === main.dataset.where) main.scrollTop = scroll;
    }
    if (sel) {
      const input = content.querySelector(sel);
      input?.focus();
      try {
        if (caret && caret[0] !== null) input?.setSelectionRange(...caret);
      } catch {
        /* number inputs have no selection */
      }
    }
  }

  _onFirstRender() {
    openApps.add(this);
  }

  _onClose() {
    openApps.delete(this);
  }

  _onRender() {
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
    // Quantities typed into the cart (or the Sell tab) are saved as they're typed.
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
    this.element.querySelector('select[name="pmk-postas"]')?.addEventListener("change", (ev) => {
      this.view.postAs = ev.target.value;
      this.render();
    });
    this.element.querySelector('select[name="d-to"]')?.addEventListener("change", () => {
      this.#readDraft();
      this.view.draft.want = {};
      this.#draftSkip = true;
      this.render();
    });
    this.element.querySelector('select[name="pmk-buyer"]')?.addEventListener("change", (ev) => {
      const cart = loadCart();
      cart.buyer = ev.target.value;
      saveCart(cart);
      this.render();
    });
    // A right-click on an item's line opens its sheet: a shop's item (read-only for players, as the shop sells it) or
    // the trader's own item on the Sell tab.
    for (const row of this.element.querySelectorAll(".pmk-row[data-id], .pmk-srow[data-id]")) {
      row.addEventListener("contextmenu", (ev) => {
        if (ev.target.closest(".pmk-addbtn, .pmk-kind, .pmk-fmark, input")) return;
        ev.preventDefault();
        if (row.classList.contains("pmk-row")) showShopItem(game.actors.get(this.view.shop), row.dataset.id, this.isGM);
        else buyerChoices(loadCart()).chosen?.items.get(row.dataset.id)?.sheet.render(true);
      });
    }
    // GM: a right-click on a staple's mark sets what it restocks to.
    for (const chip of this.element.querySelectorAll(".pmk-kind-staple")) {
      chip.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.#setStapleQty(chip.dataset.id);
      });
    }
    // GM: a right-click on a formula's mark sets its price.
    for (const chip of this.element.querySelectorAll(".pmk-fmark.on")) {
      chip.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.#setFormulaPrice(chip.dataset.id);
      });
    }
    // A right-click on an add or offer button takes one off.
    for (const btn of this.element.querySelectorAll(".pmk-addbtn")) {
      btn.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (btn.classList.contains("pmk-sellbtn")) this.#offer(btn.dataset.id, -1);
        else this.#addToCart(btn.dataset.id, -1);
      });
    }
    // GM: drag an NPC onto a shop to make them its shopkeeper, or an item to stock it.
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

  /** GM: drop an NPC on a shop for its shopkeeper, or an item (from a compendium, the Items tab or a sheet) to stock it. */
  async #onDropKeeper(event) {
    event.preventDefault();
    const data = TextEditor().getDragEventData(event);
    if (data?.type === "Item" && data.uuid) return this.#onDropItem(data.uuid);
    if (data?.type !== "Actor" || !data.uuid) return;
    const npc = await fromUuid(data.uuid);
    const shop = game.actors.get(this.view.shop);
    if (!npc || !shop) return;
    if (npc.pack) return void ui.notifications.warn("Marketplace: drag an NPC from the Actors tab (import a compendium actor first).");
    if (npc.type !== "npc") return void ui.notifications.warn("Marketplace: a shopkeeper is an NPC actor.");
    await shop.update({ [`flags.${MOD}.shop.keeper`]: npc.id });
  }

  /** GM: stock a dropped item. The same item already a staple here (not a formula) gets more of it, and its staple
   * number goes up by as many; anything else comes in as a staple of what was dropped. */
  async #onDropItem(uuid) {
    const shop = game.actors.get(this.view.shop);
    const item = await fromUuid(uuid);
    if (!shop || !item || item.parent === shop) return;
    if (!sellable(item)) return void ui.notifications.warn("Marketplace: a shop stocks physical items (not coins, nor a container with things in it).");
    const data = game.items.fromCompendium(item, { keepId: false, clearFolder: true });
    delete data.system?.containerId;
    if (data.system?.equipped) data.system.equipped = { carryType: "worn" };
    // Whatever it was in another shop (rotating, sold, a formula), here it comes in as a staple. A world item remembers
    // where it came from, so it can be sold as a formula.
    if (data.flags) delete data.flags[MOD];
    if (!item.pack && !item.parent && !data._stats?.compendiumSource) foundry.utils.setProperty(data, `flags.${MOD}.source`, item.uuid);
    const src = sourceKey(data._stats?.compendiumSource ?? data.flags?.core?.sourceId ?? (item.pack ? item.uuid : null));
    const same = src && shop.items.find((i) => {
      const st = cleanStock(i.flags?.[MOD]?.stock, quantityOf(i));
      return st.kind === "staple" && !st.formula && i.name === data.name && i.type === data.type && !i.system?.containerId
        && sourceKey(i._stats?.compendiumSource ?? i.flags?.core?.sourceId) === src;
    });
    const qty = Math.max(1, Number(data.system?.quantity) || 1);
    if (same) {
      const st = cleanStock(same.flags?.[MOD]?.stock, quantityOf(same));
      await same.update({ "system.quantity": quantityOf(same) + qty, [`flags.${MOD}.stock.qty`]: st.qty + qty }, { pmkInternal: true });
    } else await shop.createEmbeddedDocuments("Item", [data]);
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
      app.view.log = false;
      app.view.tab = "buy";
      app.view.open = new Set();
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
    this.view.log = false;
    this.view.post = false;
    this.view.market = target.dataset.id;
    this.view.shop = null;
    this.view.query = "";
    this.render();
  }

  static #onShop(event, target) {
    // The remove button on a card isn't a click on the card.
    if (event.target.closest(".pmk-x")) return;
    this.view.shop = target.dataset.id;
    this.view.tab = "buy";
    this.view.query = "";
    this.view.open = new Set();
    this.render();
  }

  static #onBack() {
    this.view.cart = false;
    this.view.log = false;
    this.view.post = false;
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
    this.#addToCart(target.dataset.id, 1);
  }

  /** Put one more (dir 1) or one fewer (dir -1) of a shop item in the cart: a batch for things sold in batches. */
  #addToCart(itemId, dir) {
    const actor = game.actors.get(this.view.shop);
    const item = actor?.items.get(itemId);
    if (!item || !sellable(item)) return;
    if (dir > 0 && !tradeMarketFor(actor.id, game.user)) return void ui.notifications.warn("Marketplace: this shop isn't open for trade right now.");
    const cart = loadCart();
    const { per } = itemPrice(item);
    const most = isFormulaItem(item) ? 1 : quantityOf(item);
    if (dir > 0) {
      const had = cart.lines.find((l) => l.shop === actor.id && l.item === item.id);
      cart.lines = addToCart(cart.lines, actor.id, item.id, per, most);
      if (!had && !cart.lines.some((l) => l.shop === actor.id && l.item === item.id) && most) ui.notifications.warn(`Marketplace: the cart is full (${MAX_LINES} lines). Trade or take something out first.`);
    } else cart.lines = takeFromCart(cart.lines, actor.id, item.id, per);
    saveCart(cart);
    this.render();
  }

  /** GM: swap an item between staple and rotating (a staple restocks to what it has now, or 1). */
  static async #onKind(event, target) {
    if (!this.isGM) return;
    const item = game.actors.get(this.view.shop)?.items.get(target.dataset.id);
    if (!item) return;
    const raw = item.flags?.[MOD]?.stock ?? {};
    const st = cleanStock(raw, quantityOf(item));
    const kind = nextStockKind(st.kind);
    // A staple made rotating and back keeps its number; otherwise it's what the item has now (at least 1).
    const qty = Number.isFinite(Number(raw.qty)) && raw.qty !== null ? Math.max(0, Math.round(Number(raw.qty))) : Math.max(1, quantityOf(item));
    await item.update({ [`flags.${MOD}.stock`]: kind === "staple" ? { kind, qty } : { kind, qty: st.kind === "staple" ? st.qty : raw.qty ?? null } });
  }

  /** GM: sell an item as a formula, or as itself again. */
  static async #onFormula(event, target) {
    if (!this.isGM) return;
    const item = game.actors.get(this.view.shop)?.items.get(target.dataset.id);
    if (!item) return;
    const raw = item.flags?.[MOD]?.stock ?? {};
    const st = cleanStock(raw, quantityOf(item));
    if (!st.formula) {
      if (st.kind === "sold") return void ui.notifications.info("Marketplace: make it a staple or rotating first.");
      if (isTreasure(item)) return void ui.notifications.info("Marketplace: treasure has no formula.");
      if (!sellable(item)) return void ui.notifications.info("Marketplace: empty it first.");
      if (!formulaUuid(item)) return void ui.notifications.warn("Marketplace: this item has no compendium or Items-tab entry, so a formula of it would have nothing to point to. Drag it in from the compendium or the Items tab.");
    }
    // An unmarked item is a staple of what it has (as everywhere else); the mark keeps its kind and number.
    const next = { ...raw, kind: st.kind, qty: st.kind === "staple" ? st.qty : raw.qty ?? null, formula: !st.formula };
    if (!next.formula) next.price = null;
    await item.update({ [`flags.${MOD}.stock`]: next }, { pmkInternal: true });
  }

  /** GM: set a formula's price, or clear it back to the price for its level. */
  async #setFormulaPrice(itemId) {
    const item = game.actors.get(this.view.shop)?.items.get(itemId);
    if (!item || !isFormulaItem(item)) return;
    const st = cleanStock(item.flags?.[MOD]?.stock, quantityOf(item));
    const auto = formulaPrice(itemLevel(item), itemRarity(item), formulaMults());
    const gp = await DialogV2().prompt({
      window: { title: `Formula: ${realItem(item).name}`, icon: "fa-solid fa-scroll" },
      classes: ["pmk-dialog"],
      position: { width: 340 },
      content: `<div class="pmk-form"><label>Price in gp <input type="number" name="gp" value="${st.price != null ? st.price / 100 : ""}" placeholder="${auto / 100}" min="0" step="0.01" autofocus></label>
        <p class="pmk-hint">Blank: ${esc(formatCp(auto))}, the price for its level.</p></div>`,
      ok: { label: "Save", icon: "fa-solid fa-check", callback: (event, button) => button.form.elements.gp.value },
      rejectClose: false,
    });
    if (gp === null || gp === undefined) return;
    const next = { ...item.flags[MOD].stock };
    const n = Number(gp);
    if (String(gp).trim() === "" || !Number.isFinite(n) || n < 0) next.price = null;
    else next.price = Math.round(n * 100);
    await item.update({ [`flags.${MOD}.stock`]: next }, { pmkInternal: true });
  }

  /** GM: set what a staple restocks to. */
  async #setStapleQty(itemId) {
    const item = game.actors.get(this.view.shop)?.items.get(itemId);
    if (!item) return;
    const st = cleanStock(item.flags?.[MOD]?.stock, quantityOf(item));
    if (st.kind !== "staple") return;
    const n = await DialogV2().prompt({
      window: { title: `${realItem(item).name}: restocks to`, icon: "fa-solid fa-boxes-stacked" },
      classes: ["pmk-dialog"],
      position: { width: 320 },
      content: `<div class="pmk-form"><label>Number <input type="number" name="qty" value="${st.qty}" min="0" max="9999" step="1" autofocus></label></div>`,
      ok: { label: "Save", icon: "fa-solid fa-check", callback: (event, button) => Number(button.form.elements.qty.value) },
      rejectClose: false,
    });
    if (n === null || n === undefined || !Number.isFinite(n)) return;
    await item.update({ [`flags.${MOD}.stock`]: cleanStock({ kind: "staple", qty: n }) });
  }

  static #onSellAdd(event, target) {
    this.#offer(target.dataset.id, 1);
  }

  /** Offer one more (dir 1) or one fewer (dir -1) of the trader's item to this shop: a batch for things sold in batches. */
  #offer(itemId, dir) {
    const shop = game.actors.get(this.view.shop);
    const cart = loadCart();
    const { chosen } = buyerChoices(cart);
    const row = sellRows(chosen).find((r) => r.id === itemId);
    if (!shop || !chosen || !row || row.why) return;
    if (dir > 0 && !tradeMarketFor(shop.id, game.user)) return void ui.notifications.warn("Marketplace: this shop isn't open for trade right now.");
    // Sales for characters this user can no longer trade for don't take up room.
    const mine = new Set(buyerChoices(cart).list.map((a) => a.id));
    cart.sales = cart.sales.filter((l) => mine.has(l.actor));
    const line = cart.sales.find((l) => l.actor === chosen.id && l.item === itemId);
    if (dir > 0) {
      if (line && line.shop !== shop.id) ui.notifications.info(esc(`Marketplace: ${row.name} is now offered to ${shop.name} instead of ${game.actors.get(line.shop)?.name ?? "the other shop"}.`));
      cart.sales = addSale(cart.sales, chosen.id, shop.id, itemId, row.per, row.qty);
      if (!cart.sales.some((l) => l.actor === chosen.id && l.item === itemId)) ui.notifications.warn(`Marketplace: the cart is full (${MAX_LINES} lines). Trade or take something out first.`);
    } else if (line?.shop === shop.id) cart.sales = takeSale(cart.sales, chosen.id, itemId, row.per);
    saveCart(cart);
    this.render();
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
        const name = sellRows(chosen).find((r) => r.id === itemId)?.name ?? "It";
        ui.notifications.info(esc(`Marketplace: ${name} is now offered to ${game.actors.get(shopId)?.name ?? "this shop"} instead of ${game.actors.get(was.shop)?.name ?? "the other shop"}.`));
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
      const max = doc ? (isFormulaItem(doc) ? 1 : quantityOf(doc)) : line.qty;
      this.#setQty("buy", shop, item, Math.max(1, Math.min(max, line.qty + dir * per)));
    } else {
      const { chosen } = buyerChoices(cart);
      const row = sellRows(chosen).find((r) => r.id === item);
      const line = cart.sales.find((l) => l.actor === chosen?.id && l.item === item);
      if (!line) return;
      const per = row?.per ?? 1;
      this.#setQty("sale", shop, item, Math.max(1, Math.min(row?.qty ?? line.qty, line.qty + dir * per)));
    }
    this.render();
  }

  static #onCart() {
    this.view.cart = true;
    this.view.log = false;
    this.view.post = false;
    this.render();
  }

  static #onPost() {
    this.view.post = true;
    this.view.cart = false;
    this.view.log = false;
    this.render();
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
    this.#readDraft();
    const d = this.view.draft;
    const me = tradersFor(game.user).find((a) => a.id === this.view.postAs) ?? tradersFor(game.user)[0];
    if (!me || !d) return;
    const list = (o) => Object.entries(o).map(([item, qty]) => ({ item, qty }));
    const offer = { id: "draft000", from: me.id, to: d.to, give: { items: list(d.give), cp: d.giveCp }, want: { items: d.to ? list(d.want) : [], cp: d.wantCp }, note: d.note };
    if (!cleanOffer(offer)) return void ui.notifications.warn("Marketplace: offer something (items or coins), and ask for something unless you're giving items away.");
    postRequest({ type: "post", offer });
  }

  static #onAccept(event, target) {
    const me = tradersFor(game.user).find((a) => a.id === this.view.postAs) ?? tradersFor(game.user)[0];
    if (me) postRequest({ type: "accept", id: target.dataset.id, actor: me.id });
  }

  static async #onWithdraw(event, target) {
    postRequest({ type: "withdraw", id: target.dataset.id });
  }

  static #onCartBack() {
    this.view.cart = false;
    this.view.log = false;
    this.view.post = false;
    this.render();
  }

  static #onTab(event, target) {
    this.view.tab = target.dataset.tab === "sell" ? "sell" : "buy";
    this.render();
  }

  static async #onDraw() {
    if (!this.isGM) return;
    const shop = game.actors.get(this.view.shop);
    if (shop) await drawStockDialog(shop, marketById(this.view.market));
  }

  static async #onFill() {
    if (!this.isGM) return;
    const shop = game.actors.get(this.view.shop);
    if (!shop) return;
    const added = await fillPurse(shop, marketById(this.view.market));
    ui.notifications.info(added ? esc(`Marketplace: added ${formatCp(added)} to ${shop.name}'s purse.`) : esc(`Marketplace: ${shop.name}'s purse is already full.`));
  }

  static async #onShopSettings() {
    if (!this.isGM) return;
    const shop = game.actors.get(this.view.shop);
    if (!shop) return;
    await shopSettingsDialog(shop, marketById(this.view.market));
  }

  static #onLog() {
    if (!this.isGM) return;
    this.view.log = true;
    this.view.post = false;
    this.view.cart = false;
    this.render();
  }

  static async #onClearLog() {
    if (!this.isGM) return;
    const ok = await DialogV2().confirm({ window: { title: "Clear the trade log" }, classes: ["pmk-dialog"], content: "<p>Clear every entry in the trade log? This can't be undone.</p>", rejectClose: false });
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

  static async #onNewMarket() {
    if (!this.isGM) return;
    const data = await marketDialog(null);
    if (!data) return;
    const id = foundry.utils.randomID(16);
    let folder = data.folder;
    if (folder === "_new") folder = (await Folder.create({ name: data.name, type: "Actor" }))?.id ?? null;
    await mutate((d) => {
      const sort = Math.max(0, ...d.markets.map((m) => m.sort)) + 1;
      d.markets.push({ id, name: data.name, img: data.img, description: data.description, level: data.level, folder, extra: [], visible: false, open: false, sort, created: Date.now(), restockEvery: data.restockEvery, lastRestock: data.restockEvery ? game.time.worldTime : null });
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
      Object.assign(m, { name: data.name, img: data.img, description: data.description, level: data.level, folder, restockEvery: data.restockEvery });
      // A new or changed interval counts from now.
      if (data.restockEvery && (m.lastRestock === null || data.restockEvery !== market.restockEvery)) m.lastRestock = game.time.worldTime;
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
    const before = marketById(this.view.market);
    // Players saw what's in its shops now; a browse-only view shows that until the next restock.
    const closing = before?.open && (what === "open" || what === "visible");
    if (closing) await noteSeen(shopsFor(before).map((s) => game.actors.get(s.id)).filter((a) => a && openToPlayers(a)));
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
    // A new shop takes its market's level and starts with a full purse.
    if (market.level) await setLevel(actor, market.level);
    await fillPurse(actor, market);
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

  static async #onCloseShop() {
    if (!this.isGM) return;
    const actor = game.actors.get(this.view.shop);
    if (!actor) return;
    if (!actor.flags?.[MOD]?.closed && openToPlayers(actor)) await noteSeen([actor]);
    await actor.update({ [`flags.${MOD}.closed`]: !actor.flags?.[MOD]?.closed });
  }

  static async #onRestock() {
    if (!this.isGM) return;
    const shop = game.actors.get(this.view.shop);
    if (!shop) return;
    const opts = await restockDialog(`Restock ${shop.name}`, [shop]);
    if (!opts || typeof opts !== "object") return;
    try {
      const r = await restockShop(shop, marketById(this.view.market), opts);
      ui.notifications.info(esc(`Marketplace: ${shop.name} restocked (${r.drawn} new).`));
    } catch (err) {
      console.error(`${MOD} | restocking ${shop.name} failed`, err);
      ui.notifications.error(esc(`Marketplace: couldn't restock ${shop.name}. See the console.`));
    }
  }

  static async #onRestockAll() {
    if (!this.isGM) return;
    const market = marketById(this.view.market);
    if (!market) return;
    const shops = shopsFor(market).map((s) => game.actors.get(s.id)).filter(isMerchant);
    if (!shops.length) return;
    const opts = await restockDialog(`Restock ${market.name} (${shops.length} ${shops.length === 1 ? "shop" : "shops"})`, shops);
    if (!opts || typeof opts !== "object") return;
    const n = await restockMarket(market, opts);
    if (n) ui.notifications.info(esc(`Marketplace: ${market.name} restocked.`));
  }

  static #onSheet() {
    game.actors.get(this.view.shop)?.sheet.render(true);
  }
}

/** The GM's form for a shop's settings. */
/**
 * Draw a shop's rotating stock from its lines: item data ready to create, marked rotating. Levels lean to the shop's
 * level; nothing the shop already stocks (by compendium source) or already drawn; scrolls and some wands are made from
 * the spell list. Returns [{ data, filter }].
 */
async function drawStock(shop, market, lines = shopConf(shop).lines, ignore = new Set()) {
  const maxLevel = Math.max(0, shopLevel(shop, market));
  const index = await equipmentIndex();
  const templates = await spellTemplates();
  const templateIds = new Set([...templates.scroll.values(), ...templates.wand.values()].map((t) => t.uuid));
  // What the shop has: items by compendium source, scrolls and wands by kind and spell (old and new source forms match).
  const seen = new Set();
  for (const i of shop.items) {
    if (ignore.has(i.id)) continue;
    const key = sourceKey(i._stats?.compendiumSource ?? i.flags?.core?.sourceId);
    const spell = i.system?.spell;
    if (spell) seen.add(`${i.system?.category}:${sourceKey(spell._stats?.compendiumSource ?? spell.flags?.core?.sourceId)}`);
    else if (key) seen.add(isFormulaItem(i) ? `formula:${key}` : key);
  }
  const out = [];
  // Formulas are kept apart: a shop can sell a sword and the formula for it.
  const pick = (pool, n, pre = "") => drawEntries(pool.filter((e) => !seen.has(pre + sourceKey(e.uuid))), n, maxLevel);
  const ranges = Object.fromEntries(AMOUNTS.map((a) => [a, game.settings.get(MOD, `amount-${a}`)]));
  const stack = parseRange(game.settings.get(MOD, "stackRange"), [1, 4], 1, 100);
  const spells = async (kind, n, rarity) => {
    const list = (await spellIndex()).filter((e) => scribable(e, rarity) && !seen.has(`${kind}:${sourceKey(e.uuid)}`));
    const ranks = new Map([...templates[kind]].map(([r, t]) => [r, t.level]));
    const picks = drawSpells(list, ranks, n, maxLevel);
    for (const { spell } of picks) seen.add(`${kind}:${sourceKey(spell.uuid)}`);
    return (await Promise.all(picks.map(({ spell, rank }) => spellItemData(kind, templates[kind].get(rank).uuid, spell.uuid, rank)))).filter(Boolean);
  };
  for (const line of cleanStockLines(lines)) {
    const f = STOCK_FILTERS.find((x) => x.id === line.filter);
    const pool = index.filter((e) => f.test(e) && drawable(e, templateIds) && rarityAllowed(e.system?.traits?.rarity, line.rarity));
    const count = lineCount(line, ranges);
    let datas = [];
    if (line.filter === "scrolls") datas = await spells("scroll", count, line.rarity);
    else if (f.formula) {
      const picks = pick(pool, count, "formula:");
      for (const e of picks) seen.add(`formula:${sourceKey(e.uuid)}`);
      datas = (await Promise.all(picks.map((e) => itemFromEntry(e.uuid)))).filter(Boolean);
    } else {
      // Wands: about half named wands, half magic wands of a spell.
      const made = line.filter === "wands" ? await spells("wand", Math.floor(count / 2), line.rarity) : [];
      const picks = pick(pool, count - made.length);
      for (const e of picks) seen.add(sourceKey(e.uuid));
      datas.push(...(await Promise.all(picks.map((e) => itemFromEntry(e.uuid)))).filter(Boolean));
      datas.push(...made);
    }
    for (const data of datas) {
      // A formula is one copy that never runs out.
      data.system.quantity = f.formula ? 1 : Math.max(1, Number(data.system.quantity) || 1) * drawnQty(data, Math.random, stack);
      // Shops sell identified goods.
      if (data.system.identification) data.system.identification.status = "identified";
      data.flags ??= {};
      data.flags[MOD] = { ...(data.flags[MOD] ?? {}), stock: f.formula ? { kind: "rotating", formula: true } : { kind: "rotating" } };
      out.push({ data, filter: line.filter, formula: !!f.formula });
    }
  }
  return out;
}

/** GM: draw rotating stock from the shop's lines, look it over, and add it (or draw again). */
async function drawStockDialog(shop, market) {
  if (!cleanStockLines(shopConf(shop).lines).length) {
    ui.notifications.info("Marketplace: add rotating stock lines in the shop's Settings first.");
    return shopSettingsDialog(shop, market);
  }
  for (;;) {
    const drawn = await drawStock(shop, market);
    if (!drawn.length) return void ui.notifications.warn("Marketplace: nothing to draw at this shop's level.");
    const rows = drawn.map(({ data, filter, formula }) => {
      const level = Number(data.system.level?.value) || 0;
      const cp = formula ? formulaPrice(level, data.system.traits?.rarity, formulaMults()) : priceOf({ system: data.system }).cp;
      return `<tr><td>${formula ? "Formula: " : ""}${esc(data.name)}</td><td>${esc(filterLabel(filter))}</td><td class="pmk-r">${level}</td><td class="pmk-r">${formula ? "copy" : `×${data.system.quantity}`}</td><td class="pmk-r">${esc(formatCp(cp))}</td></tr>`;
    }).join("");
    const choice = await DialogV2().wait({
      window: { title: `${shop.name}: draw stock`, icon: "fa-solid fa-dice" },
      classes: ["pmk-dialog"],
      position: { width: 560 },
      content: `<table class="pmk-drawn"><thead><tr><th>Item</th><th>Line</th><th class="pmk-r">Level</th><th class="pmk-r">Qty</th><th class="pmk-r">Price</th></tr></thead><tbody>${rows}</tbody></table>`,
      buttons: [
        { action: "add", label: "Add as rotating", icon: "fa-solid fa-check", default: true },
        { action: "again", label: "Draw again", icon: "fa-solid fa-dice" },
        { action: "cancel", label: "Cancel" },
      ],
      rejectClose: false,
    });
    if (choice === "again") continue;
    if (choice === "add") await shop.createEmbeddedDocuments("Item", drawn.map((d) => d.data));
    return;
  }
}

/* ------------------------------------------------------------------ */
/* Restocking                                                         */
/* ------------------------------------------------------------------ */

const flagOf = (shop, key) => shop?.flags?.[MOD]?.[key];
/** Can players trade at this shop right now (in any market that holds it)? */
const openToPlayers = (shop) => store().markets.some((m) => m.visible && m.open && shopsOf(m, actorRows(), parentOf, false).some((s) => s.id === shop.id && !s.closed));
/** What players last saw: a shop that stops trading notes its rotation count, so a browse-only view knows whether the
 * stock has changed since (design decision 13). */
async function noteSeen(shops) {
  for (const shop of shops) {
    const n = Number(flagOf(shop, "rotations")) || 0;
    if (flagOf(shop, "seenRotation") !== n) await shop.update({ [`flags.${MOD}.seenRotation`]: n });
  }
}
/** Do players see a shop's whole stock while it's browse only? Only when they saw it open since its last restock. */
const remembered = (shop) => flagOf(shop, "seenRotation") === (Number(flagOf(shop, "rotations")) || 0);

/** A shop's stock items for a restock plan. */
const planItems = (shop) => stockRows(shop).map((r) => ({ id: r.id, qty: r.qty, stock: r.stock }));

/**
 * Restock a shop (GM): staples back to their number, rotating stock cleared and drawn again from the shop's lines, sold
 * items counted down, the purse filled. A restock is a rotation; a shop open to players right then is one they've seen.
 * Returns what changed.
 */
function restockShop(shop, market, opts = {}) {
  // In the trade queue, so a restock never runs in the middle of a trade with this shop.
  return queued(() => restockNow(shop, market, opts));
}
async function restockNow(shop, market, { keepSold = false, draw = true } = {}) {
  await markStaples([shop]);
  const plan = restockPlan(planItems(shop), { keepSold });
  // Drawn first: if the draw fails, nothing has changed yet. What's about to go may be drawn again.
  const removing = new Set(plan.remove);
  const drawn = draw && cleanStockLines(shopConf(shop).lines).length ? await drawStock(shop, market, undefined, removing) : [];
  if (plan.remove.length) await shop.deleteEmbeddedDocuments("Item", plan.remove);
  const updates = [
    ...plan.refill.map((r) => ({ _id: r.id, "system.quantity": r.qty })),
    ...plan.age.map((a) => ({ _id: a.id, [`flags.${MOD}.stock.left`]: a.left })),
  ];
  if (updates.length) await shop.updateEmbeddedDocuments("Item", updates, { pmkInternal: true });
  if (drawn.length) await shop.createEmbeddedDocuments("Item", drawn.map((d) => d.data));
  const filled = await fillPurse(shop, market);
  const rotations = (Number(flagOf(shop, "rotations")) || 0) + 1;
  await shop.update({ [`flags.${MOD}.rotations`]: rotations, ...(openToPlayers(shop) ? { [`flags.${MOD}.seenRotation`]: rotations } : {}) });
  return { refilled: plan.refill.length, cleared: plan.remove.length, aged: plan.age.length, drawn: drawn.length, filled };
}

/** The confirm dialog for a restock: what will happen, with the two choices. Resolves to the options or null. */
async function restockDialog(title, shops) {
  let staples = 0, rotating = 0, soldGo = 0, soldStay = 0, lines = 0;
  for (const shop of shops) {
    const plan = restockPlan(planItems(shop));
    staples += plan.refill.length;
    for (const id of plan.remove) (cleanStock(flagOf(shop.items.get(id), "stock")).kind === "sold" ? soldGo++ : rotating++);
    soldStay += plan.age.length;
    lines += cleanStockLines(shopConf(shop).lines).reduce((n, l) => n + lineCount(l, Object.fromEntries(AMOUNTS.map((a) => [a, game.settings.get(MOD, `amount-${a}`)])), () => 0.5), 0);
  }
  const bits = [`${staples} staples refilled`, `${rotating} rotating cleared`, `sold items: ${soldGo} go, ${soldStay} stay`, `about ${lines} new drawn`];
  return DialogV2().wait({
    window: { title, icon: "fa-solid fa-rotate" },
    classes: ["pmk-dialog"],
    position: { width: 420 },
    content: `<div class="pmk-form"><p>${esc(bits.join(" · "))}; purses filled.</p>
      <label class="pmk-check"><input type="checkbox" name="draw" ${lines ? "checked" : "disabled"}> Draw new stock</label>
      <label class="pmk-check"><input type="checkbox" name="keepSold"> Keep sold items this time</label></div>`,
    buttons: [
      { action: "ok", label: "Restock", icon: "fa-solid fa-rotate", default: true, callback: (event, button) => ({ draw: button.form.elements.draw.checked, keepSold: button.form.elements.keepSold.checked }) },
      { action: "cancel", label: "Cancel" },
    ],
    rejectClose: false,
  });
}

/** Restock every shop of a market (GM), noting the game time for its schedule. */
async function restockMarket(market, opts) {
  // The clock first: a shop that fails mustn't make the schedule restock the others again on the next tick.
  await mutateMarket(market.id, (m) => {
    m.lastRestock = game.time.worldTime;
  });
  const shops = shopsFor(market).map((s) => game.actors.get(s.id)).filter(isMerchant);
  const failed = [];
  for (const shop of shops) {
    try {
      await restockShop(shop, market, opts);
    } catch (err) {
      console.error(`${MOD} | restocking ${shop.name} failed`, err);
      failed.push(shop.name);
    }
  }
  if (failed.length) ui.notifications.error(esc(`Marketplace: couldn't restock ${listOf(failed)}. See the console.`));
  return shops.length - failed.length;
}

/** Give each shop item with no stock mark its staple mark, of what it has now (0.1.0 stock, duplicated or imported
 * merchants, items made before this module saw them), and identify anything unidentified. */
async function markStaples(shops) {
  for (const shop of shops) {
    const updates = [];
    for (const i of shop.items) {
      const u = {};
      if (sellable(i) && !i.flags?.[MOD]?.stock) u[`flags.${MOD}.stock`] = { kind: "staple", qty: quantityOf(i) };
      // Shops sell identified goods.
      if (i.system?.identification?.status && i.system.identification.status !== "identified") u["system.identification.status"] = "identified";
      if (Object.keys(u).length) updates.push({ _id: i.id, ...u });
    }
    if (updates.length) await shop.updateEmbeddedDocuments("Item", updates, { pmkInternal: true });
  }
}

/** Timed restocks: on the primary GM's lead tab, a market whose interval has passed in game time restocks all its shops
 * once (however much time passed). A market that has never restocked starts its clock at the first check. */
let restocking = false;
async function checkSchedules() {
  if (restocking || !iAmLeader()) return;
  restocking = true;
  try {
    const now = game.time.worldTime;
    for (const m of store().markets) {
      if (!(m.restockEvery > 0)) continue;
      // Never restocked, or the clock was turned back: the interval counts from now.
      if (m.lastRestock === null || now < m.lastRestock) await mutateMarket(m.id, (x) => (x.lastRestock = now));
      else if (restockDue(m.restockEvery, m.lastRestock, now)) {
        const n = await restockMarket(m, { draw: true, keepSold: false });
        ui.notifications.info(esc(`Marketplace: ${m.name} restocked (${n} ${n === 1 ? "shop" : "shops"}).`));
      }
    }
  } catch (err) {
    console.error(`${MOD} | a timed restock failed`, err);
  } finally {
    restocking = false;
  }
}

/** The rows of the rotating stock lines in the settings dialog. */
const filterOptions = (sel) => STOCK_FILTERS.map((f) => `<option value="${f.id}" ${f.id === sel ? "selected" : ""}>${esc(f.label)}</option>`).join("");
const amountOptions = (sel) => {
  const sizes = AMOUNTS.map((a) => `<option value="${a}" ${a === sel ? "selected" : ""}>${AMOUNT_LABEL[a]} (${esc(game.settings.get(MOD, `amount-${a}`))})</option>`);
  const nums = [...new Set([...Array.from({ length: 20 }, (_, i) => i + 1), ...(typeof sel === "number" ? [sel] : [])])].sort((a, b) => a - b)
    .map((n) => `<option value="${n}" ${n === sel ? "selected" : ""}>${n}</option>`);
  return sizes.join("") + nums.join("");
};
const RARITY_LINE = { common: "Common", uncommon: "Up to uncommon", rare: "Up to rare" };
const rarityOptions = (sel) => LINE_RARITIES.map((r) => `<option value="${r}" ${r === sel ? "selected" : ""}>${RARITY_LINE[r]}</option>`).join("");
const stockLineHTML = (l = { filter: "weapons", amount: "some", rarity: "common" }) => `<div class="pmk-sline">
  <select name="amount">${amountOptions(l.amount)}</select>
  <select name="filter">${filterOptions(l.filter)}</select>
  <select name="rarity">${rarityOptions(l.rarity)}</select>
  <button type="button" class="pmk-sline-x" data-tooltip="Remove"><i class="fa-solid fa-xmark"></i></button>
</div>`;

async function shopSettingsDialog(shop, market) {
  const c = shopConf(shop);
  const keeper = c.keeper ? game.actors.get(c.keeper) : null;
  const att = game.modules.get(ATTITUDES_MOD)?.active;
  const opts = ATTITUDES.map((a) => `<option value="${a}" ${a === c.attitude ? "selected" : ""}>${ATTITUDE_LABEL[a]}</option>`).join("");
  const data = await DialogV2().wait({
    window: { title: `${shop.name}: settings`, icon: "fa-solid fa-sliders" },
    classes: ["pmk-dialog"],
    position: { width: 460 },
    content: `<div class="pmk-form">
      <label>Level <input type="number" name="level" value="${actorLevel(shop)}" min="-1" max="30" step="1"></label>
      <p class="pmk-hint">At 0 the shop takes its market's level${market?.level ? ` (${market.level})` : ""}. The level sets how full Fill purse makes it.</p>
      <label class="pmk-check"><input type="checkbox" name="buys" ${c.buys ? "checked" : ""}> Buys from players</label>
      <label>Pays for items (% of their price) <input type="number" name="itemRate" value="${c.itemRate}" min="0" max="1000" step="5"></label>
      <label>Pays for treasure (% of its value) <input type="number" name="treasureRate" value="${c.treasureRate}" min="0" max="1000" step="5"></label>
      <label class="pmk-check"><input type="checkbox" name="unlimited" ${c.unlimited ? "checked" : ""}> Unlimited purse (never runs out of money)</label>
      <label>Keeps what players sold for (restocks) <input type="number" name="keepSold" value="${c.keepSold}" min="1" max="9" step="1"></label>
      <label>Shopkeeper's attitude <select name="attitude">${opts}</select></label>
      <p class="pmk-hint">${keeper ? `Shopkeeper: <strong>${esc(keeper.name)}</strong>. ` : "No shopkeeper: drag an NPC onto the shop to set one. "}${att && keeper ? "Their attitude in NPC Attitudes counts first (toward each character, if set). If the party is shown a different attitude than the real one, prices are normal. This one is used when they have no attitude there." : "Attitude changes what players pay (the module settings say by how much)."}</p>
      ${keeper ? `<label class="pmk-check"><input type="checkbox" name="clearKeeper"> No shopkeeper</label>` : ""}
      <div class="pmk-field">Rotating stock (drawn up to the shop's level)
        <div class="pmk-slines">${c.lines.map(stockLineHTML).join("")}</div>
        <button type="button" class="pmk-sline-add"><i class="fa-solid fa-plus"></i> Line</button>
      </div>
    </div>`,
    render: (event, dialog) => {
      const root = dialog.element ?? event?.target?.element;
      const list = root?.querySelector(".pmk-slines");
      root?.querySelector(".pmk-sline-add")?.addEventListener("click", () => {
        if (list.children.length >= MAX_STOCK_LINES) return;
        list.insertAdjacentHTML("beforeend", stockLineHTML());
      });
      list?.addEventListener("click", (ev) => ev.target.closest(".pmk-sline-x")?.closest(".pmk-sline")?.remove());
    },
    buttons: [
      { action: "ok", label: "Save", icon: "fa-solid fa-check", default: true, callback: (event, button) => {
        const e = button.form.elements;
        return { level: Number(e.level.value) || 0, buys: e.buys.checked, itemRate: Number(e.itemRate.value), treasureRate: Number(e.treasureRate.value), unlimited: e.unlimited.checked, keepSold: Number(e.keepSold.value), attitude: e.attitude.value, clearKeeper: !!e.clearKeeper?.checked,
          lines: [...button.form.querySelectorAll(".pmk-sline")].map((row) => {
            const a = row.querySelector('[name="amount"]').value;
            return { amount: AMOUNTS.includes(a) ? a : Number(a), filter: row.querySelector('[name="filter"]').value, rarity: row.querySelector('[name="rarity"]').value };
          }) };
      } },
      { action: "cancel", label: "Cancel" },
    ],
    rejectClose: false,
  });
  if (!data || typeof data !== "object") return;
  const conf = cleanShop({ ...c, ...data, keeper: data.clearKeeper ? null : c.keeper });
  await shop.update({ [`flags.${MOD}.shop`]: conf, "system.details.level.value": Math.max(-1, Math.min(30, Math.round(data.level))) });
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
      <label>Restock every (days of game time) <input type="number" name="restockEvery" value="${m.restockEvery || ""}" min="0" max="365" step="1" placeholder="never"></label>
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
        return { name: e.name.value.trim().slice(0, 120) || "Market", img: e.img.value.trim(), level, folder: e.folder.value || null, description: e.description.value ?? "", restockEvery: Number(e.restockEvery.value) || 0 };
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
  game.settings.register(MOD, "log", { scope: "world", config: false, type: Array, default: [], onChange: () => refresh() });
  game.settings.register(MOD, "offers", { scope: "world", config: false, type: Array, default: [], onChange: () => refresh() });
  game.settings.register(MOD, "sheetColor", {
    name: "Pathfinder sheet look: color",
    hint: "The color of the Marketplace's Pathfinder sheet look (chosen in the window's menu).",
    scope: "client", config: true, type: String, default: "red",
    choices: { red: "Red", green: "Green", blue: "Blue", purple: "Purple", brown: "Brown", black: "Black" },
    onChange: () => refresh(),
  });
  for (const a of AMOUNTS) {
    game.settings.register(MOD, `amount-${a}`, {
      name: `Stock line size: ${AMOUNT_LABEL[a]}`,
      hint: a === "few" ? "How many items a rotating stock line of this size draws, as a range (\"1-3\") or one number." : "",
      scope: "world", config: true, type: String, default: AMOUNT_DEFAULTS[a], onChange: () => refresh(),
    });
  }
  game.settings.register(MOD, "stackRange", {
    name: "Drawn consumables per stack",
    hint: "How many of each consumable, bomb or ammunition a draw gives a shop, as a range (\"1-4\"), in batches (10 arrows).",
    scope: "world", config: true, type: String, default: "1-4", onChange: () => refresh(),
  });
  game.settings.register(MOD, "purseScale", {
    name: "Shop purse size (%)",
    hint: "How full Fill purse (and a new shop) makes a shop's purse: 100% is one level's party treasure for the shop's level (GM Core), 100 gp below level 1. Lower it for a poor region, raise it for a rich one.",
    scope: "world", config: true, type: Number, default: 100, range: { min: 10, max: 500, step: 10 },
  });
  for (const r of ["uncommon", "rare"]) {
    game.settings.register(MOD, `formula-${r}`, {
      name: `Formula price: ${r} (×)`,
      hint: r === "uncommon" ? "Multiplies the price of an uncommon formula (the Formula Price table by item level is for common formulas)." : "Multiplies the price of a rare formula.",
      scope: "world", config: true, type: Number, default: FORMULA_MULT_DEFAULTS[r], range: { min: 1, max: 20, step: 1 }, onChange: () => refresh(),
    });
  }
  game.settings.register(MOD, "hostileRefuses", {
    name: "Hostile shopkeepers won't trade",
    hint: "On: a hostile shopkeeper won't buy or sell at all. Off: they trade at the Hostile price change below.",
    scope: "world", config: true, type: Boolean, default: true, onChange: () => refresh(),
  });
  for (const a of ATTITUDES) {
    game.settings.register(MOD, `price-${a}`, {
      name: `Price change: ${ATTITUDE_LABEL[a]} (%)`,
      hint: a === "indifferent" ? "What players pay when buying from a shopkeeper with this attitude, in percent: positive costs more, negative is a discount. Treasure is never discounted. What a shop pays doesn't change, except that it never pays more than it would charge."
        : "Positive costs more, negative is a discount (buying only).",
      scope: "world", config: true, type: Number, default: PRICE_DEFAULTS[a], range: { min: -90, max: 200, step: 5 }, onChange: () => refresh(),
    });
  }
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
// Anything put in a merchant without a stock mark (the GM dragging it in, or PF2e's own sheet) is a staple that comes back
// to its quantity on a restock, a design decision. Set on the creating client, before the item exists.
Hooks.on("preCreateItem", (item, data) => {
  if (!isMerchant(item.parent)) return;
  // Shops sell identified goods: an unidentified item put in a shop is identified there.
  if (data?.system?.identification?.status && data.system.identification.status !== "identified") item.updateSource({ "system.identification.status": "identified" });
  if (data?.flags?.[MOD]?.stock || !sellable(item)) return;
  item.updateSource({ [`flags.${MOD}.stock`]: { kind: "staple", qty: Math.max(0, Number(data?.system?.quantity ?? item.quantity ?? 1) || 0) } });
});
// A shopkeeper's attitude changing (PF2e NPC Attitudes) changes prices.
Hooks.on("updateActor", (a, change) => a?.type === "npc" && change?.flags?.["pf2e-npc-attitudes"] && refresh());
// Players logging in or out changes whether a GM is there to trade with.
Hooks.on("userConnected", () => refresh());
Hooks.on("updateWorldTime", () => checkSchedules());
Hooks.once("ready", () => setTimeout(async () => {
  // 0.1.0 stock and merchants made elsewhere: every unmarked shop item becomes a staple of what it has.
  if (iAmLeader()) {
    const shops = [...new Set(store().markets.flatMap((m) => shopsFor(m).map((s) => s.id)))].map((id) => game.actors.get(id)).filter(isMerchant);
    await markStaples(shops).catch((err) => console.error(`${MOD} | marking staples failed`, err));
  }
  checkSchedules();
}, 5000));
// More of a staple put in by hand (the system stacks it) raises what it restocks to; the module's own changes say so.
Hooks.on("preUpdateItem", (item, change, options) => {
  if (options?.pmkInternal || !game.user.isGM || !isMerchant(item.parent)) return;
  const q = foundry.utils.getProperty(change, "system.quantity");
  const st = item.flags?.[MOD]?.stock;
  if (q === undefined || st?.kind !== "staple" || foundry.utils.hasProperty(change, `flags.${MOD}.stock`)) return;
  if (Number(q) > (Number(st.qty) || 0)) foundry.utils.setProperty(change, `flags.${MOD}.stock.qty`, Number(q));
});
for (const hook of ["createFolder", "updateFolder", "deleteFolder"]) Hooks.on(hook, (f) => f.type === "Actor" && refresh());
