/**
 * PF2e Marketplace
 * A marketplace window over PF2e's own merchants: markets (a name, picture, description and the shops in them),
 * browsed without opening merchant sheets. Shops stay ordinary PF2e merchant loot actors, so they keep working as
 * merchant sheets without the module.
 */

import {
  esc, cleanStore, cleanMarket, byMarketOrder, canSee, canTrade, shopsOf, formatCp, priceFor, groupStock, cleanLines, addToCart, listOf,
  purseFor, ATTITUDES, ATTITUDE_LABEL, PRICE_DEFAULTS, cleanShop, attitudePct, adjust, offerFor, sellRate, cleanSellLines, addLogEntry, cleanLogEntry, handPricedNote,
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

/** What each cart line is now: its shop, item, price for this buyer and anything wrong with it. */
function cartState(lines, buyer) {
  return lines.map((l) => {
    const shop = game.actors.get(l.shop);
    const item = isMerchant(shop) ? shop.items.get(l.item) : null;
    const stock = item ? quantityOf(item) : 0;
    const { cp, per } = item ? priceOf(item) : { cp: 0, per: 1 };
    const market = shop ? tradeMarketFor(shop.id, game.user) : null;
    const pct = shop ? pricePct(shop, buyer) : 0;
    let problem = null;
    if (!shop || !isMerchant(shop)) problem = "This shop is gone.";
    else if (!item || !sellable(item)) problem = "No longer for sale.";
    else if (!market) problem = "This shop isn't open for trade right now.";
    else if (pct === null) problem = `${shopFace(shop)} won't trade with ${buyer?.name ?? "you"}.`;
    else if (stock < l.qty) problem = stock ? `Only ${stock} left.` : "Sold out.";
    return { ...l, shopDoc: shop, itemDoc: item, stock, cp, per, pct: pct ?? 0, price: adjust(priceFor(cp, per, l.qty), pct ?? 0), market, problem };
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
    late.set(rid, msg.type);
    setTimeout(() => late.delete(rid), 600000);
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
    delete data._id;
    data.system.quantity = t.qty;
    await giveItems(t.actor, [data]).catch((err) => console.error(`${MOD} | couldn't put ${t.qty} ${data.name} back on ${t.actor.name}`, err));
  }
}

/**
 * Buy a cart (on the GM's client, or a GM's own). Everything is checked before anything moves: the buyer is the
 * sender's to buy for, each shop is open to them, each item is for sale in that quantity, the total matches what the
 * buyer saw, and the buyer can pay. Then the stock comes out, the buyer pays, gets the items, and each shop is paid.
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
    const pct = pricePct(shop, buyer);
    if (pct === null) throw new Refused(`${shopFace(shop, sender)} won't trade with ${buyer.name}.`);
    const { cp, per } = priceOf(item);
    const price = adjust(priceFor(cp, per, l.qty), pct);
    plan.push({ shop, item, qty: l.qty, price, name: realItem(item).name });
    total += price;
  }
  if (Number(msg.total) !== total) throw new Refused("prices or stock changed since you looked. Check the cart and try again.");
  if (fundsCp(buyer) < total) throw new Refused(`${buyer.name} hasn't enough money: it costs ${formatCp(total)}.`);
  // The copies are made before the stock changes. Then: stock first (GM-owned, easy to put back), then the money,
  // then the goods; a step that fails undoes the ones before it.
  const copies = plan.map((p) => boughtCopy(p.item, p.qty));
  const taken = await takeAll(plan, "the shop's stock changed. Check the cart and try again.");
  if (!(await pay(buyer, total).catch(() => false))) {
    await putBack(taken);
    throw new Refused(`${buyer.name} hasn't enough money: it costs ${formatCp(total)}.`);
  }
  try {
    await giveItems(buyer, copies);
  } catch (err) {
    await receive(buyer, total).catch(() => null);
    await putBack(taken);
    throw err;
  }
  const byShop = new Map();
  for (const p of plan) byShop.set(p.shop.id, [...(byShop.get(p.shop.id) ?? []), p]);
  for (const group of byShop.values()) {
    const shop = group[0].shop;
    const paid = group.reduce((n, p) => n + p.price, 0);
    await receive(shop, paid).catch((err) => console.error(`${MOD} | ${shop.name} wasn't paid ${paid} cp`, err));
    logTrade({ kind: "buy", user: sender.name, actor: buyer.name, shop: shop.name, market: tradeMarketFor(shop.id, sender)?.name ?? "", items: group.map((p) => ({ name: p.name, qty: p.qty })), cp: paid });
  }
  return { buyer: buyer.name, total, names: plan.map((p) => (p.qty > 1 ? `${p.name} ×${p.qty}` : p.name)), lines };
}

/**
 * Sell to a shop (on the GM's client, or a GM's own). Checked first: the seller is the sender's, the shop is open to
 * them and buys from players, each item is the seller's, identified and in that quantity, the total matches what the
 * seller saw, and the shop can pay. Then the shop pays (unless its purse is unlimited), the seller gets the coins,
 * the items go into the shop's stock as sold items, and come out of the seller's inventory.
 */
async function processSell(msg, sender) {
  const lines = cleanSellLines(msg.lines);
  if (!lines.length) throw new Refused("nothing to sell.");
  const seller = game.actors.get(String(msg.seller ?? ""));
  if (!seller || !buyersFor(sender, [seller]).length) throw new Refused("you can't sell for that character.");
  const shop = game.actors.get(String(msg.shop ?? ""));
  if (!isMerchant(shop)) throw new Refused("that shop is gone.");
  const market = tradeMarketFor(shop.id, sender);
  if (!market) throw new Refused(`${shop.name} isn't open for trade.`);
  const conf = shopConf(shop);
  if (!conf.buys) throw new Refused(`${shop.name} doesn't buy from customers.`);
  const pct = pricePct(shop, seller);
  if (pct === null) throw new Refused(`${shopFace(shop, sender)} won't trade with ${seller.name}.`);
  const plan = [];
  let total = 0;
  for (const l of lines) {
    const item = seller.items.get(l.item);
    if (!item) throw new Refused("something you offered isn't in your inventory any more.");
    if (item.isIdentified === false) throw new Refused("identify it before you sell it.");
    if (!canSellToShop(item)) throw new Refused(`${shop.name} won't buy ${item.name} as it is.`);
    if (l.qty > quantityOf(item)) throw new Refused(`${seller.name} has only ${quantityOf(item)} of ${item.name}.`);
    const { cp, per } = priceOf(item);
    const offer = offerFor(cp, per, l.qty, sellRate(conf, isTreasure(item), pct));
    plan.push({ item, qty: l.qty, offer, name: item.name });
    total += offer;
  }
  if (Number(msg.total) !== total) throw new Refused("the offer changed since you looked. Check it and try again.");
  if (!conf.unlimited && fundsCp(shop) < total) throw new Refused(`${shop.name} ${canPay(shop)}.`);
  // A price set by hand on the seller's item (or homebrew with no compendium entry) is flagged for the GM, not refused.
  const notes = [];
  for (const p of plan) {
    const h = await handPriced(p.item);
    if (h) notes.push(handPricedNote(p.name, h));
  }
  const note = notes.join("; ");
  // The items leave the seller first (checked again against what they have now), then the shop pays, then takes them,
  // then the seller is paid; a step that fails undoes the ones before it.
  const copies = plan.map((p) => soldCopy(p.item, p.qty, MOD));
  const taken = await takeAll(plan, "what you offered changed. Check it and try again.");
  if (!conf.unlimited && !(await pay(shop, total).catch(() => false))) {
    await putBack(taken);
    throw new Refused(`${shop.name} ${canPay(shop)}.`);
  }
  try {
    await giveItems(shop, copies);
  } catch (err) {
    if (!conf.unlimited) await receive(shop, total).catch(() => null);
    await putBack(taken);
    throw err;
  }
  await receive(seller, total);
  logTrade({ kind: "sell", user: sender.name, actor: seller.name, shop: shop.name, market: market.name, items: plan.map((p) => ({ name: p.name, qty: p.qty })), cp: total, note });
  return { seller: seller.name, shop: shop.name, total, names: plan.map((p) => (p.qty > 1 ? `${p.name} ×${p.qty}` : p.name)), note };
}
const soldText = (r) => `${r.seller} sold ${listOf(r.names)} to ${r.shop} for ${formatCp(r.total)}.`;

/** What a trade's buyer is told, and what the GM sees when a player bought. */
const boughtText = (r) => `${r.buyer} bought ${listOf(r.names)} for ${formatCp(r.total)}.`;

/** What was bought comes out of the cart (a line raised meanwhile keeps the rest). */
function clearBought(lines) {
  const cart = loadCart();
  const bought = new Map(lines.map((l) => [`${l.shop}.${l.item}`, l.qty]));
  cart.lines = cart.lines.map((l) => ({ ...l, qty: l.qty - (bought.get(`${l.shop}.${l.item}`) ?? 0) })).filter((l) => l.qty >= 1);
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
    } else if (msg.type === "sell") {
      const r = await queued(() => processSell(msg, sender));
      reply({ type: "done", what: "sell", text: soldText(r) });
      if (r.note) ui.notifications.warn(esc(`Marketplace: ${sender.name}: ${soldText(r)} Check the price: ${r.note}.`), { permanent: true });
      else ui.notifications.info(esc(`Marketplace: ${sender.name}: ${soldText(r)}`));
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
    else if (msg.type === "claim" && sender?.isGM && typeof msg.key === "string") handled.set(msg.key, Date.now());
    else if (sender && !sender.isGM && (msg.type === "buy" || msg.type === "sell")) takeRequest(msg, sender);
    return;
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
  if (msg.what === "buy") {
    clearBought(cleanLines(msg.lines));
    ui.notifications.info(esc(`Marketplace: ${String(msg.text ?? "Bought.")}`));
  } else if (msg.what === "sell") {
    for (const app of openApps) app.view.sell = new Map();
    ui.notifications.info(esc(`Marketplace: ${String(msg.text ?? "Sold.")}`));
    refresh();
  }
}

/** Check out: a GM buys at once; a player asks the GM's client. */
let buying = false;
async function checkout() {
  if (buying || waitingFor("buy")) return;
  const cart = loadCart();
  const { chosen } = buyerChoices(cart);
  const state = cartState(cart.lines, chosen);
  if (!chosen) return void ui.notifications.warn("Marketplace: you have no character to buy for.");
  if (!state.length) return;
  const bad = state.find((l) => l.problem);
  if (bad) return void ui.notifications.warn(esc(`Marketplace: fix the cart first: ${bad.problem}`));
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
  askGM(msg);
}

/** Sell what's chosen in a shop's sell list: a GM at once, a player through the GM's client. */
let selling = false;
async function sellNow(app, shop, seller) {
  if (selling || waitingFor("sell") || !shop || !seller) return;
  const rows = new Map(sellRows(seller).map((r) => [r.id, r]));
  const conf = shopConf(shop);
  const pct = pricePct(shop, seller) ?? 0;
  // The same quantities the tab shows: never more than the seller has now.
  const lines = cleanSellLines([...app.view.sell].map(([item, qty]) => ({ item, qty: Math.min(qty, rows.get(item)?.qty ?? 0) })))
    .filter((l) => rows.get(l.item) && !rows.get(l.item).why);
  if (!lines.length) return void ui.notifications.info("Marketplace: choose how many of something to sell first.");
  const total = lines.reduce((n, l) => {
    const r = rows.get(l.item);
    return n + offerFor(r.cp, r.per, l.qty, sellRate(conf, r.treasure, pct));
  }, 0);
  const msg = { type: "sell", seller: seller.id, shop: shop.id, lines, total };
  if (game.user.isGM) {
    selling = true;
    try {
      const r = await queued(() => processSell(msg, game.user));
      app.view.sell = new Map();
      ui.notifications.info(esc(`Marketplace: ${soldText(r)}${r.note ? ` Check the price: ${r.note}.` : ""}`));
    } catch (err) {
      if (err instanceof Refused) ui.notifications.warn(esc(`Marketplace: ${err.message}`));
      else {
        console.error(`${MOD} | selling failed`, err);
        ui.notifications.error("Marketplace: selling failed partway. See the console.");
      }
    } finally {
      selling = false;
      refresh();
    }
    return;
  }
  askGM(msg);
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
    // The window is drawn dark, so Foundry's own inputs and buttons inside it take the dark theme too.
    classes: ["pmk", "themed", "theme-dark"],
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
      pmkTab: MarketApp.#onTab,
      pmkSell: MarketApp.#onSell,
      pmkFill: MarketApp.#onFill,
      pmkShopSettings: MarketApp.#onShopSettings,
      pmkLog: MarketApp.#onLog,
      pmkClearLog: MarketApp.#onClearLog,
    },
  };

  constructor(options = {}) {
    super(options);
    const saved = loadView();
    this.view = { market: saved.market ?? null, shop: saved.shop ?? null, cart: false, log: false, tab: "buy", query: "", open: new Set(), sell: new Map() };
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
    if (this.view.log && this.isGM) main = this.#logHTML();
    else if (this.view.cart) main = this.#cartHTML(cart);
    else if (!market) main = this.#emptyHTML();
    else if (this.view.shop) main = await this.#shopHTML(market, game.actors.get(this.view.shop));
    else main = await this.#marketHTML(market, shops);

    return `<div class="pmk-shell">
      <nav class="pmk-rail">
        <div class="pmk-railhead">Markets</div>
        <div class="pmk-mks">${rail}</div>
        ${this.isGM ? `<a class="pmk-mk pmk-loglink ${this.view.log ? "active" : ""}" data-action="pmkLog"><i class="fa-solid fa-scroll pmk-noimg"></i><span class="pmk-mkn">Trade log</span></a>` : ""}
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
    const conf = shopConf(actor);
    const cart = loadCart();
    const { list: buyers, chosen } = buyerChoices(cart);
    const pct = pricePct(actor, chosen);
    const keeper = conf.keeper ? game.actors.get(conf.keeper) : null;
    const face = keeperFace(keeper, this.isGM);
    const tab = this.view.tab === "sell" && trade && conf.buys ? "sell" : "buy";
    const hidden = !!actor.flags?.[MOD]?.hidden;
    const purse = conf.unlimited ? "unlimited" : formatCp(fundsCp(actor), "empty");
    const gmBar = this.isGM ? `<div class="pmk-gmbar">
        <button type="button" class="pmk-tog ${hidden ? "" : "on"}" data-action="pmkHideShop" data-tooltip="${hidden ? "Hidden from players, even in a visible market" : "Players see this shop when its market is visible"}"><i class="fa-solid ${hidden ? "fa-eye-slash" : "fa-eye"}"></i> ${hidden ? "Hidden" : "Shown"}</button>
        <span class="pmk-purse" data-tooltip="The merchant's coins: what it can pay for things players sell"><i class="fa-solid fa-sack-dollar"></i> ${esc(purse)}</span>
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
      : this.isGM ? `<p class="pmk-hint">Drag an NPC onto this shop to make them its shopkeeper.</p>` : "";
    const tradingAs = buyers.length ? `<label class="pmk-buyer">Trading as <select name="pmk-buyer">${buyers.map((a) => `<option value="${esc(a.id)}" ${a.id === chosen?.id ? "selected" : ""}>${esc(a.name)}${a.type === "party" ? " (party stash)" : ""}</option>`).join("")}</select></label>` : "";
    const priceLine = !chosen ? "" : pct === null ? `<p class="pmk-status pmk-warnbox">${esc(shopFace(actor))} won't trade with ${esc(chosen.name)}.</p>`
      : pct ? `<p class="pmk-status ${pct < 0 ? "pmk-good" : ""}">Prices for ${esc(chosen.name)}: ${pct < 0 ? `${-pct}% off` : `${pct}% more`} ${attitudeInfo(actor, chosen).masked ? "" : ` (${esc(ATTITUDE_LABEL[attitudeFor(actor, chosen)])})`}.</p>` : "";
    const tabs = trade && conf.buys && pct !== null ? `<nav class="pmk-tabs"><a class="${tab === "buy" ? "active" : ""}" data-action="pmkTab" data-tab="buy"><i class="fa-solid fa-cart-shopping"></i> Buy</a><a class="${tab === "sell" ? "active" : ""}" data-action="pmkTab" data-tab="sell"><i class="fa-solid fa-hand-holding-dollar"></i> Sell</a></nav>` : "";
    const body = tab === "sell" ? this.#sellHTML(actor, chosen, conf) : await this.#stockHTML(actor, rows, trade && pct !== null, pct ?? 0, cart);
    return `<div class="pmk-shopview pmk-keeperdrop">
      <header class="pmk-shead">
        <a class="pmk-back" data-action="pmkBack"><i class="fa-solid fa-arrow-left"></i> ${esc(market.name)}</a>
        <div class="pmk-stitle"><img src="${esc(actor.img)}" alt=""><div><h2>${esc(actor.name)}</h2>
          <div class="pmk-sub">${rows.length} ${rows.length === 1 ? "item" : "items"}${shopLevel(actor, market) ? ` · level ${shopLevel(actor, market)}` : ""}</div></div>
          ${keeperHTML}</div>
      </header>
      ${gmBar}
      ${this.#statusHTML(market)}
      ${trade ? tradingAs : ""}
      ${trade && (tab === "buy" || pct === null) ? priceLine : ""}
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
        const shown = adjust(r.cp, pct);
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
      : `<p class="pmk-none">${this.isGM ? "Nothing in stock. Open the merchant sheet and drag items in from the compendium." : "Nothing in stock."}</p>`;
    return `<label class="pmk-search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" name="pmk-q" value="${esc(this.view.query)}" placeholder="Search this shop" autocomplete="off"></label>
      <div class="pmk-stock">
        <div class="pmk-rowhead"><span></span><span>Item</span><span>Level</span><span>Stock</span><span>Price</span><span></span></div>
        ${body}
      </div>`;
  }

  /** The Sell tab: what the chosen character carries, with the shop's offer for each. */
  #sellHTML(shop, seller, conf) {
    if (!seller) return `<p class="pmk-none">You have no character to sell for.</p>`;
    if (pricePct(shop, seller) === null) return "";
    const rows = sellRows(seller);
    const pct = pricePct(shop, seller) ?? 0;
    const offer = (r, qty) => offerFor(r.cp, r.per, qty, sellRate(conf, r.treasure, pct));
    let total = 0;
    const list = rows.map((r) => {
      const qty = Math.min(this.view.sell.get(r.id) ?? 0, r.qty);
      if (!r.why) total += offer(r, qty);
      const each = offer(r, r.per);
      return `<div class="pmk-srow ${r.why ? "pmk-no" : ""}">
        <img src="${esc(r.img)}" alt="">
        <span class="pmk-rn">${esc(r.name)}${r.why ? `<span class="pmk-note">${esc(r.why)}</span>` : `<span class="pmk-note">${each ? esc(formatCp(each)) : "under 1 cp"}${r.per > 1 ? ` for ${r.per}` : " each"}</span>`}</span>
        <span class="pmk-qty">×${r.qty}</span>
        ${r.why ? "<span></span>" : `<input type="number" class="pmk-qtyin" name="pmk-sellqty" data-item="${esc(r.id)}" value="${qty}" min="0" max="${r.qty}" step="1">`}
        <span class="pmk-price">${r.why || !qty ? "" : esc(formatCp(offer(r, qty), "nothing"))}</span>
      </div>`;
    }).join("");
    const can = conf.unlimited ? Infinity : fundsCp(shop);
    const short = total > can;
    const capped = Math.max(conf.itemRate, conf.treasureRate) > 100 + pct;
    const rates = `Pays ${conf.itemRate}% of an item's price${conf.treasureRate !== conf.itemRate ? `, ${conf.treasureRate}% for treasure` : ""}${capped ? `, never more than it would charge ${seller.name}` : ""}.`;
    const why = !total ? "Choose how many to sell." : short ? `${esc(shop.name)} ${esc(canPay(shop))}.` : !this.isGM && !game.users.activeGM ? "A GM needs to be logged in to trade." : "";
    return `<p class="pmk-hint">${esc(rates)} ${conf.unlimited ? "" : `The shop has ${esc(formatCp(can, "no money"))} to spend.`}</p>
      <div class="pmk-stock">
        <div class="pmk-srowhead"><span></span><span>Item</span><span>Have</span><span>Sell</span><span>Offer</span></div>
        ${list || `<p class="pmk-none">${esc(seller.name)} has nothing to sell.</p>`}
      </div>
      <div class="pmk-total"><div><span>${esc(seller.name)} gets</span><strong>${esc(formatCp(total, "nothing"))}</strong></div></div>
      ${why && total ? `<p class="pmk-status">${why}</p>` : ""}
      <div class="pmk-checkout">${waitingFor("sell") ? `<button type="button" disabled><i class="fa-solid fa-hourglass-half"></i> Waiting for the GM...</button>`
        : `<button type="button" data-action="pmkSell" ${why ? "disabled" : ""}><i class="fa-solid fa-hand-holding-dollar"></i> Sell for ${esc(formatCp(total, "nothing"))}</button>`}</div>`;
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
      <div class="pmk-gmbar"><span class="pmk-dim">${log.length} ${log.length === 1 ? "trade" : "trades"}, newest first (the last ${300} are kept).</span><span class="pmk-gap"></span>
      ${log.length ? `<button type="button" data-action="pmkClearLog"><i class="fa-solid fa-trash"></i> Clear the log</button>` : ""}</div>
      ${rows || `<p class="pmk-none">No trades yet.</p>`}</div>`;
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
    const state = cartState(cart.lines, chosen);
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
      <div class="pmk-checkout">${waitingFor("buy") ? `<button type="button" disabled><i class="fa-solid fa-hourglass-half"></i> Waiting for the GM...</button>`
        : `<button type="button" data-action="pmkCheckout" ${why ? "disabled" : ""}><i class="fa-solid fa-coins"></i> Buy for ${esc(formatCp(total))}</button>`}</div>
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
    // Quantities are kept as they're typed and the window redraws a moment later, not on blur: a redraw on blur would
    // replace the Buy or Sell button under the click that caused the blur.
    const later = () => {
      clearTimeout(this.qtyTimer);
      this.qtyTimer = setTimeout(() => this.render(), 400);
    };
    for (const q of this.element.querySelectorAll('input[name="pmk-qty"]')) {
      q.addEventListener("input", () => {
        if (q.value === "") return;
        const cart = loadCart();
        const line = cart.lines.find((l) => l.shop === q.dataset.shop && l.item === q.dataset.item);
        if (!line) return;
        const n = Math.max(1, Math.min(Math.floor(Number(q.value)) || 1, Number(q.max) || 1));
        if (n === line.qty) return;
        line.qty = n;
        saveCart(cart);
        later();
      });
      q.addEventListener("change", () => {
        if (q.value === "" || Number(q.value) !== loadCart().lines.find((l) => l.shop === q.dataset.shop && l.item === q.dataset.item)?.qty) later();
      });
    }
    this.element.querySelector('select[name="pmk-buyer"]')?.addEventListener("change", (ev) => {
      const cart = loadCart();
      cart.buyer = ev.target.value;
      saveCart(cart);
      this.view.sell = new Map();
      this.render();
    });
    for (const q of this.element.querySelectorAll('input[name="pmk-sellqty"]')) {
      q.addEventListener("input", () => {
        if (q.value === "") return;
        const n = Math.max(0, Math.min(Math.floor(Number(q.value)) || 0, Number(q.max) || 0));
        if (n === (this.view.sell.get(q.dataset.item) ?? 0)) return;
        if (n) this.view.sell.set(q.dataset.item, n);
        else this.view.sell.delete(q.dataset.item);
        later();
      });
      q.addEventListener("change", () => {
        if (Number(q.value) !== (this.view.sell.get(q.dataset.item) ?? 0)) later();
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
      app.view.sell = new Map();
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
    this.view.sell = new Map();
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
    this.view.sell = new Map();
    this.render();
  }

  static #onSell() {
    const shop = game.actors.get(this.view.shop);
    const { chosen } = buyerChoices(loadCart());
    sellNow(this, shop, chosen);
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
      hint: a === "indifferent" ? "What players pay when buying from a shopkeeper with this attitude, in percent: positive costs more, negative is a discount. Selling prices don't change with attitude."
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
