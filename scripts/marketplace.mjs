/**
 * PF2e Marketplace
 * A marketplace window over PF2e's own merchants: markets (a name, picture, description and the shops in them),
 * browsed without opening merchant sheets. Shops stay ordinary PF2e merchant loot actors, so they keep working as
 * merchant sheets without the module.
 */

import {
  esc, cleanStore, cleanMarket, byMarketOrder, canSee, canTradeShop, MAX_LINES, shopsOf, formatCp, priceFor, groupStock, cleanLines, addToCart, takeFromCart, listOf,
  purseFor, ATTITUDES, ATTITUDE_LABEL, PRICE_DEFAULTS, cleanShop, attitudePct, pctFor, adjust, planTrade, offerFor, sellRate, cleanSales, addSale, takeSale, settle, addLogEntry, cleanLogEntry, handPricedNote,
} from "./helpers.mjs";
import {
  isMerchant, actorLevel, stockRows, descriptionOf, merchantData, realItem, priceOf, sellable, quantityOf, fundsCp, pay, receive,
  boughtCopy, giveItems, takeFromStock, buyersFor, sellRows, canSellToShop, soldCopy, setLevel, keeperFace, isTreasure, handPriced,
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
  return lines.map((l) => {
    const shop = game.actors.get(l.shop);
    const item = isMerchant(shop) ? shop.items.get(l.item) : null;
    const stock = item ? quantityOf(item) : 0;
    const { cp, per } = item ? priceOf(item) : { cp: 0, per: 1 };
    const market = shop ? tradeMarketFor(shop.id, game.user, rows) : null;
    const raw = shop ? pricePct(shop, buyer) : 0;
    const pct = raw === null ? null : pctFor(raw, isTreasure(item));
    let problem = null;
    if (!shop || !isMerchant(shop)) problem = "This shop is gone.";
    else if (!item || !sellable(item)) problem = "No longer for sale.";
    else if (!market) problem = "This shop isn't open for trade right now.";
    else if (pct === null) problem = `${shopFace(shop)} won't trade with ${buyer?.name ?? "you"}.`;
    else if (stock < l.qty) problem = stock ? `Only ${stock} left.` : "Sold out.";
    return { ...l, shopDoc: shop, itemDoc: item, stock, cp, per, pct: pct ?? 0, price: adjust(priceFor(cp, per, l.qty), pct ?? 0), market, problem };
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
    const put = left ? left.update({ "system.quantity": quantityOf(left) + t.qty }) : t.actor.createEmbeddedDocuments("Item", [data], { keepId: true });
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
    if (l.qty > quantityOf(item)) throw new Refused(`${shop.name} has only ${quantityOf(item)} of ${realItem(item).name}.`);
    const pct = pricePct(shop, trader);
    if (pct === null) throw new Refused(`${shopFace(shop, sender)} won't trade with ${trader.name}.`);
    const { cp, per } = priceOf(item);
    buys.push({ shop: shop.id, shopDoc: shop, item, qty: l.qty, price: adjust(priceFor(cp, per, l.qty), pctFor(pct, isTreasure(item))), name: realItem(item).name });
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
  const boughtCopies = buys.map((b) => boughtCopy(b.item, b.qty));
  const soldCopies = sold.map((x) => ({ shop: x.shopDoc, data: soldCopy(x.item, x.qty, MOD) }));
  const changed = "the stock or your inventory changed. Check the cart and try again.";
  const taken = await takeAll(buys, changed);
  try {
    taken.push(...(await takeAll(sold, changed)));
  } catch (err) {
    await putBack(taken);
    throw err;
  }
  const paid = [];
  const delivered = [];
  const undo = async () => {
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
    for (const c of soldCopies) delivered.push(await deliver(c.shop, [c.data]));
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

/** Give an actor items, remembering what was there before, so it can be undone. */
async function deliver(actor, datas) {
  const before = new Map(actor.items.map((i) => [i.id, quantityOf(i)]));
  const record = { actor, before };
  try {
    await giveItems(actor, datas);
  } catch (err) {
    // Part of it may have landed.
    await undeliver(record);
    throw err;
  }
  return record;
}
/** Undo a delivery: items it made are deleted, stacks it added to go back to what they were. */
async function undeliver({ actor, before }) {
  try {
    const made = actor.items.filter((i) => !before.has(i.id)).map((i) => i.id);
    if (made.length) await actor.deleteEmbeddedDocuments("Item", made);
    const grown = actor.items.filter((i) => before.has(i.id) && quantityOf(i) > before.get(i.id)).map((i) => ({ _id: i.id, "system.quantity": before.get(i.id) }));
    if (grown.length) await actor.updateEmbeddedDocuments("Item", grown);
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

/** The active GM's client acts on a player's request. */
async function onRequest(msg, sender) {
  const reply = (extra) => game.socket.emit(SOCKET, { users: [sender.id], rid: typeof msg.rid === "string" ? msg.rid : null, ...extra });
  try {
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
    else if (sender && sender.id !== game.user.id && msg.type === "trade") takeRequest(msg, sender);
    // An assistant GM's own trades go through the primary GM's client too, and come back like a player's.
    if (msg.type !== "done" && msg.type !== "fail") return;
  }
  if (!sender?.isGM) return;
  if (Array.isArray(msg.users) && !msg.users.includes(game.user.id)) return;
  if (msg.type !== "done" && msg.type !== "fail") return;
  // Only answers to this client's own requests (a GM answers the user, who may have two windows open).
  if (!answered(msg.rid)) return;
  refresh();
  if (msg.type === "fail") {
    ui.notifications.warn(esc(String(msg.text ?? "Marketplace: that didn't work.")));
    return refresh();
  }
  clearTraded(msg.lines, msg.sales);
  ui.notifications.info(esc(`Marketplace: ${String(msg.text ?? "Done.")}`));
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
      pmkStep: MarketApp.#onStep,
      pmkCloseShop: MarketApp.#onCloseShop,
      pmkFill: MarketApp.#onFill,
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
    let main;
    if (this.view.log && this.isGM) main = this.#logHTML();
    else if (this.view.cart) main = this.#cartHTML(cart);
    else if (!market) main = this.#emptyHTML();
    else if (this.view.shop) main = await this.#shopHTML(market, game.actors.get(this.view.shop));
    else main = await this.#marketHTML(market, shops);

    const look = this.look ?? getLook();
    // Parchment pages: everywhere in the Pathfinder sheet look; markets and shops in the hybrid one.
    const paper = look === "pf2e" || (look === "hybrid" && market && !this.view.cart && !(this.view.log && this.isGM));
    return `<div class="pmk-shell">
      <nav class="pmk-rail">
        <div class="pmk-railhead">Markets</div>
        <div class="pmk-mks">${rail}</div>
        ${this.isGM ? `<a class="pmk-mk pmk-loglink ${this.view.log ? "active" : ""}" data-action="pmkLog"><i class="fa-solid fa-scroll pmk-noimg"></i><span class="pmk-mkn">Trade log</span></a>` : ""}
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
        <button type="button" data-action="pmkNewShop"><i class="fa-solid fa-plus"></i> New shop</button>
        <button type="button" data-action="pmkEditMarket"><i class="fa-solid fa-pen"></i> Edit</button>
        <button type="button" data-action="pmkDeleteMarket" data-tooltip="Delete this market (its shops stay)"><i class="fa-solid fa-trash"></i></button>
      </div>` : "";
    const folder = market.folder ? game.folders.get(market.folder) : null;
    const cards = shops.map((s) => {
      const actor = game.actors.get(s.id);
      const count = stockRows(actor).length;
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
    const rows = stockRows(actor);
    const own = shopRow(actor);
    // Open to this user in any market that holds it (a shop can be in two), as the cart and the GM's client see it.
    const trade = !!tradeMarketFor(actor.id, game.user);
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
        <button type="button" data-action="pmkShopSettings"><i class="fa-solid fa-sliders"></i> Settings</button>
        <button type="button" data-action="pmkSheet"><i class="fa-solid fa-file-invoice"></i> Merchant sheet</button>
      </div>` : "";
    const info = attitudeInfo(actor, null);
    const gmAtt = !info.masked ? `${ATTITUDE_LABEL[info.attitude]} in general`
      : `${ATTITUDE_LABEL[info.real] ?? "No attitude"}, shown as ${ATTITUDE_LABEL[info.shown] ?? "Unknown"}: normal prices`;
    const keeperHTML = face ? `<div class="pmk-keeper"><img src="${esc(face.img)}" alt=""><div><strong>${esc(face.name)}</strong>
        ${this.isGM ? `<span class="pmk-dim">${esc(gmAtt)}</span>` : ""}</div></div>`
      : this.isGM ? `<p class="pmk-hint">Drop an NPC here for a shopkeeper.</p>` : "";
    const tradingAs = buyers.length ? `<label class="pmk-buyer">Trading as <select name="pmk-buyer">${buyers.map((a) => `<option value="${esc(a.id)}" ${a.id === chosen?.id ? "selected" : ""}>${esc(a.name)}${a.type === "party" ? " (party stash)" : ""}: ${esc(formatCp(fundsCp(a), "no money"))}</option>`).join("")}</select></label>` : "";
    const priceLine = !chosen ? "" : pct === null ? `<p class="pmk-status pmk-warnbox">${esc(shopFace(actor))} won't trade with ${esc(chosen.name)}.</p>`
      : pct ? `<p class="pmk-status ${pct < 0 ? "pmk-good" : ""}">Prices for ${esc(chosen.name)}: ${pct < 0 ? `${-pct}% off` : `${pct}% more`}${attitudeInfo(actor, chosen).masked ? "" : ` (${esc(ATTITUDE_LABEL[attitudeFor(actor, chosen)])})`}.</p>` : "";
    const tabs = trade && conf.buys && pct !== null ? `<nav class="pmk-tabs"><a class="${tab === "buy" ? "active" : ""}" data-action="pmkTab" data-tab="buy"><i class="fa-solid fa-cart-shopping"></i> Buy</a><a class="${tab === "sell" ? "active" : ""}" data-action="pmkTab" data-tab="sell"><i class="fa-solid fa-hand-holding-dollar"></i> Sell</a></nav>` : "";
    const body = tab === "sell" ? this.#sellHTML(actor, chosen, conf, cart) : await this.#stockHTML(actor, rows, trade && pct !== null, pct ?? 0, cart);
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
      ${trade ? tradingAs : ""}
      ${trade ? priceLine : ""}
      ${tabs}
      ${body}
    </div>`;
  }

  /** The Buy tab: the shop's stock, priced for the chosen buyer. */
  async #stockHTML(actor, rows, trade, pct, cart) {
    const inCart = new Map(cart.lines.filter((l) => l.shop === actor.id).map((l) => [l.item, l.qty]));
    const groups = groupStock(rows, this.view.query);
    const list = [];
    for (const [, label, items] of groups) {
      list.push(`<div class="pmk-gh">${esc(label)} <span class="pmk-count">${items.length}</span></div>`);
      for (const r of items) {
        const open = this.view.open.has(r.id);
        const rar = RARITY[r.rarity] ? `<span class="pmk-rar pmk-${esc(r.rarity)}">${RARITY[r.rarity]}</span>` : "";
        const note = r.holds ? `<span class="pmk-note">holds ${r.holds} ${r.holds === 1 ? "item" : "items"}; not for sale as it is</span>`
          : !r.identified && this.isGM ? `<span class="pmk-note">unidentified on the sheet; players see it, and buy it, identified</span>` : "";
        const shown = adjust(r.cp, pctFor(pct, r.type === "treasure"));
        const was = pct && shown !== r.cp ? ` <s class="pmk-per">${esc(formatCp(r.cp))}</s>` : "";
        const price = `${esc(formatCp(shown))}${was}${r.per > 1 ? ` <span class="pmk-per">for ${r.per}</span>` : ""}`;
        list.push(`<div class="pmk-row ${open ? "open" : ""} ${r.qty ? "" : "pmk-out"}" data-action="pmkItem" data-id="${esc(r.id)}">
          <img src="${esc(r.img)}" alt="">
          <span class="pmk-rn">${esc(r.name)} ${rar}${note}</span>
          <span class="pmk-lvl">${r.level}</span>
          <span class="pmk-qty">${r.qty ? `×${r.qty}` : "sold out"}</span>
          <span class="pmk-price">${price}</span>
          ${this.#addHTML(r, trade, inCart.get(r.id) ?? 0)}
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
      const note = r.why ? esc(r.why) : `${each ? esc(formatCp(each)) : "under 1 cp"}${r.per > 1 ? ` for ${r.per}` : " each"}${elsewhere ? `; offered to ${esc(elsewhere.name)}` : ""}`;
      return `<div class="pmk-srow ${r.why ? "pmk-no" : ""}">
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

  /** The GM's trade log, newest first. */
  #logHTML() {
    const log = (game.settings.get(MOD, "log") ?? []).map(cleanLogEntry).filter(Boolean);
    const rows = log.map((e) => {
      const what = listOf(e.items.map((i) => (i.qty > 1 ? `${i.name} ×${i.qty}` : i.name)));
      const verb = e.kind === "buy" ? `bought ${esc(what)} from` : `sold ${esc(what)} to`;
      const who = e.user && e.user !== e.actor ? ` <span class="pmk-dim">(${esc(e.user)})</span>` : "";
      return `<div class="pmk-logrow"><span class="pmk-dim">${esc(new Date(e.t).toLocaleString())}</span>
        <span><strong>${esc(e.actor)}</strong>${who} ${verb} <strong>${esc(e.shop)}</strong>${e.market ? ` <span class="pmk-dim">${esc(e.market)}</span>` : ""}</span>
        <span class="pmk-price ${e.kind === "buy" ? "pmk-in" : "pmk-outc"}">${esc(formatCp(e.cp))}</span>
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
        <span class="pmk-rn">${esc(real.name)}${l.problem ? `<span class="pmk-note pmk-warn">${esc(l.problem)}</span>` : ""}</span>
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
      main.dataset.where = `${this.view.market}|${this.view.shop}|${this.view.cart}|${this.view.log}|${this.view.tab}`;
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
    this.element.querySelector('select[name="pmk-buyer"]')?.addEventListener("change", (ev) => {
      const cart = loadCart();
      cart.buyer = ev.target.value;
      saveCart(cart);
      this.render();
    });
    // A right-click on an add or offer button takes one off.
    for (const btn of this.element.querySelectorAll(".pmk-addbtn")) {
      btn.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (btn.classList.contains("pmk-sellbtn")) this.#offer(btn.dataset.id, -1);
        else this.#addToCart(btn.dataset.id, -1);
      });
    }
    // GM: drag an NPC onto a shop to make them its shopkeeper.
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

  async #onDropKeeper(event) {
    event.preventDefault();
    const data = TextEditor().getDragEventData(event);
    if (data?.type !== "Actor" || !data.uuid) return;
    const npc = await fromUuid(data.uuid);
    const shop = game.actors.get(this.view.shop);
    if (!npc || !shop) return;
    if (npc.pack) return void ui.notifications.warn("Marketplace: drag an NPC from the Actors tab (import a compendium actor first).");
    if (npc.type !== "npc") return void ui.notifications.warn("Marketplace: a shopkeeper is an NPC actor.");
    await shop.update({ [`flags.${MOD}.shop.keeper`]: npc.id });
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
    const { per } = priceOf(item);
    if (dir > 0) {
      const had = cart.lines.find((l) => l.shop === actor.id && l.item === item.id);
      cart.lines = addToCart(cart.lines, actor.id, item.id, per, quantityOf(item));
      if (!had && !cart.lines.some((l) => l.shop === actor.id && l.item === item.id) && quantityOf(item)) ui.notifications.warn(`Marketplace: the cart is full (${MAX_LINES} lines). Trade or take something out first.`);
    } else cart.lines = takeFromCart(cart.lines, actor.id, item.id, per);
    saveCart(cart);
    this.render();
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
      const per = doc ? priceOf(doc).per : 1;
      const max = doc ? quantityOf(doc) : line.qty;
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
    this.render();
  }

  static #onCartBack() {
    this.view.cart = false;
    this.view.log = false;
    this.render();
  }

  static #onTab(event, target) {
    this.view.tab = target.dataset.tab === "sell" ? "sell" : "buy";
    this.render();
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
    await actor.update({ [`flags.${MOD}.closed`]: !actor.flags?.[MOD]?.closed });
  }

  static #onSheet() {
    game.actors.get(this.view.shop)?.sheet.render(true);
  }
}

/** The GM's form for a shop's settings. */
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
      <label>Shopkeeper's attitude <select name="attitude">${opts}</select></label>
      <p class="pmk-hint">${keeper ? `Shopkeeper: <strong>${esc(keeper.name)}</strong>. ` : "No shopkeeper: drag an NPC onto the shop to set one. "}${att && keeper ? "Their attitude in NPC Attitudes counts first (toward each character, if set). If the party is shown a different attitude than the real one, prices are normal. This one is used when they have no attitude there." : "Attitude changes what players pay (the module settings say by how much)."}</p>
      ${keeper ? `<label class="pmk-check"><input type="checkbox" name="clearKeeper"> No shopkeeper</label>` : ""}
    </div>`,
    buttons: [
      { action: "ok", label: "Save", icon: "fa-solid fa-check", default: true, callback: (event, button) => {
        const e = button.form.elements;
        return { level: Number(e.level.value) || 0, buys: e.buys.checked, itemRate: Number(e.itemRate.value), treasureRate: Number(e.treasureRate.value), unlimited: e.unlimited.checked, attitude: e.attitude.value, clearKeeper: !!e.clearKeeper?.checked };
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
  game.settings.register(MOD, "log", { scope: "world", config: false, type: Array, default: [], onChange: () => refresh() });
  game.settings.register(MOD, "sheetColor", {
    name: "Pathfinder sheet look: color",
    hint: "The color of the Marketplace's Pathfinder sheet look (chosen in the window's menu).",
    scope: "client", config: true, type: String, default: "red",
    choices: { red: "Red", green: "Green", blue: "Blue", purple: "Purple", brown: "Brown", black: "Black" },
    onChange: () => refresh(),
  });
  game.settings.register(MOD, "purseScale", {
    name: "Shop purse size (%)",
    hint: "How full Fill purse (and a new shop) makes a shop's purse: 100% is one level's party treasure for the shop's level (GM Core), 100 gp below level 1. Lower it for a poor region, raise it for a rich one.",
    scope: "world", config: true, type: Number, default: 100, range: { min: 10, max: 500, step: 10 },
  });
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
// A shopkeeper's attitude changing (PF2e NPC Attitudes) changes prices.
Hooks.on("updateActor", (a, change) => a?.type === "npc" && change?.flags?.["pf2e-npc-attitudes"] && refresh());
// Players logging in or out changes whether a GM is there to trade with.
Hooks.on("userConnected", () => refresh());
for (const hook of ["createFolder", "updateFolder", "deleteFolder"]) Hooks.on(hook, (f) => f.type === "Actor" && refresh());
