import { ATTITUDES, HAGGLE_DEFAULTS, HAGGLE_DEGREES, tierName, addLogEntry, attitudePct, buyPrice, byMarketOrder, canTradeShop, cleanLines, cleanSales, cleanShop, cleanStock, cleanStore, hagglePct, haggleNow, offerFor, pctFor, planTrade, repTier, sellRate, settle, shopsOf, totalPct } from "./helpers.mjs";
import { actorLevel, buyersFor, formulaUuid, fundsCp, hasParts, isMerchant, isTreasure, keeperFace, knowsFormula, priceOf, quantityOf, realItem, receive, sellRows, sellable, stockRows } from "./pf2e.mjs";
import { L, MOD, TRACKERS, fmt, notice, store as browser } from "./constants.mjs";
import { formulaPrice, purseFor } from "./rules.mjs";

/* ------------------------------------------------------------------ */
/* The store                                                          */
/* ------------------------------------------------------------------ */

/** The markets, checked. Every client can read them (Foundry sends world settings to everyone). */
const store = () => cleanStore(game.settings.get(MOD, "store"));
const marketsSorted = () => store().markets.sort(byMarketOrder);
const marketById = (id) => store().markets.find((m) => m.id === id) ?? null;

let writing = Promise.resolve();
/** Change the store (GMs only). Writes run one after another, each on the latest copy. */
function mutate(fn) {
  if (!game.user.isGM) return Promise.resolve(false);
  writing = writing.then(async () => {
    const data = store();
    if (fn(data) === false) return false;
    await game.settings.set(MOD, "store", cleanStore(data));
    return true;
  }).catch((err) => {
    console.error(`${MOD} | couldn't save the markets`, err);
    notice("error", "CouldntSave");
    return false;
  });
  return writing;
}
const mutateMarket = (id, fn) => mutate((d) => {
  const m = d.markets.find((x) => x.id === id);
  return m ? fn(m, d) : false;
});

/* ------------------------------------------------------------------ */
/* Shops of markets, worked out once per draw                         */
/* ------------------------------------------------------------------ */

/** Loot actors as plain rows for the shop lists. */
const buildRows = () => game.actors.filter((a) => a.type === "loot").map((a) => ({
  id: a.id, name: a.name, folder: a.folder?.id ?? null, merchant: isMerchant(a), hidden: !!a.flags?.[MOD]?.hidden, closed: !!a.flags?.[MOD]?.closed,
}));
const parentOf = (id) => game.folders.get(id)?.folder?.id ?? null;

/*
 * Every market's shops, and the market each shop trades in, built once and kept until the current task ends: a draw
 * or a trade asks the same questions for every line, and building the lists walks every loot actor and folder.
 */
let index = null;
function shopIndex() {
  if (index) return index;
  const rows = buildRows();
  const markets = store().markets;
  const lists = new Map();
  const listFor = (m, gm) => {
    const key = `${m.id}|${gm}`;
    if (!lists.has(key)) lists.set(key, shopsOf(m, rows, parentOf, gm));
    return lists.get(key);
  };
  const trades = new Map();
  index = {
    rows,
    shopsFor: (market, gm) => listFor(market, gm),
    /** The market where a user (GM or not) may trade with a shop, or null. */
    tradeMarket: (shopId, gm) => {
      const key = `${shopId}|${gm}`;
      if (!trades.has(key)) trades.set(key, markets.find((m) => listFor(m, gm).some((s) => s.id === shopId && canTradeShop(m, s, gm))) ?? null);
      return trades.get(key);
    },
    /** The first market a shop is in (GM's view), or null. */
    marketOf: (shopId) => markets.find((m) => listFor(m, true).some((s) => s.id === shopId)) ?? null,
  };
  queueMicrotask(() => (index = null));
  return index;
}
const actorRows = () => shopIndex().rows;
const shopsFor = (market) => shopIndex().shopsFor(market, game.user.isGM);
/** A market where this user may trade with this shop (null if none): the market must be open, and the shop neither
 * hidden from them nor closed. GMs can trade anywhere. */
const tradeMarketFor = (shopId, user) => shopIndex().tradeMarket(shopId, !!user?.isGM);
/** The first market a shop is in (for its level and its prices). */
const marketOfShop = (shopId) => shopIndex().marketOf(shopId);
/** The market that sets a shop's prices for a user: where they trade with it, else the first that holds it. */
const priceMarket = (shopId, user) => tradeMarketFor(shopId, user) ?? marketOfShop(shopId);

/* ------------------------------------------------------------------ */
/* Stock prices: items, formulas and services                         */
/* ------------------------------------------------------------------ */

const formulaMults = () => ({ uncommon: Number(game.settings.get(MOD, "formula-uncommon")), rare: Number(game.settings.get(MOD, "formula-rare")) });
const isFormulaItem = (item) => !!cleanStock(item?.flags?.[MOD]?.stock).formula;
const itemLevel = (item) => Number(item?.level ?? item?.system?.level?.value ?? 0) || 0;
const itemRarity = (item) => item?.rarity ?? item?.system?.traits?.rarity ?? "common";
/**
 * What a shop item sells for: { cp, per }. A formula is a copy at the GM's price, or the price for its level worked
 * out from the system's treasure table; cp is null when there's no price for it (the table couldn't be read).
 */
function itemPrice(item) {
  const st = cleanStock(item?.flags?.[MOD]?.stock);
  if (!st.formula) return priceOf(item);
  return { cp: st.price ?? formulaPrice(itemLevel(item), itemRarity(item), formulaMults()), per: 1 };
}
/** A shop's stock rows as players see them: formulas priced as formulas, one copy at a time; then its services. */
const shopRows = (actor) => [
  ...stockRows(actor).map((r) => {
    const st = cleanStock(r.stock, r.qty);
    if (!st.formula) return r;
    return { ...r, name: L("FormulaOf", { name: r.name }), formula: true, cp: st.price ?? formulaPrice(r.level, r.rarity, formulaMults()), per: 1, qty: 1, uuid: formulaUuid(actor.items.get(r.id)) };
  }),
  ...shopConf(actor).services.map((s) => ({ id: s.id, name: s.name, note: s.note, service: true, type: "service", level: 0, rarity: "common", traits: [], qty: 1, cp: s.cp, per: 1, img: "icons/svg/coins.svg", stock: null })),
];
/** A shop's service by id, or null. */
const serviceOf = (shop, id) => (shop ? shopConf(shop).services.find((s) => s.id === id) ?? null : null);

/** A shop's own switches, as a row for canTradeShop. */
const shopRow = (actor) => ({ id: actor?.id, hidden: !!actor?.flags?.[MOD]?.hidden, closed: !!actor?.flags?.[MOD]?.closed });

/* ------------------------------------------------------------------ */
/* Shops: settings, attitude, prices, purse, log                      */
/* ------------------------------------------------------------------ */

/** A shop's settings (merchant actor flag `shop`). */
const shopConf = (actor) => cleanShop(actor?.flags?.[MOD]?.shop);
const ATTITUDES_MOD = "pf2e-npc-attitudes";
const flagOf = (shop, key) => shop?.flags?.[MOD]?.[key];

/**
 * The attitude that sets a buyer's prices. With PF2e NPC Attitudes on and a shopkeeper who has a record there:
 * - the party sees their true attitude ("shown" is "same"): that attitude, or the one toward this character if set;
 * - the party is shown the true attitude picked by hand: that attitude (per-character ones aren't shown then);
 * - the party is shown something else (a disguise, or Unknown): Indifferent, normal prices, so a secretly hostile
 *   merchant still trades and a pretended friend gives no discount (a missing discount is a soft tell).
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
    if (shown === "same") return { attitude: ATTITUDES.includes(own) ? own : ATTITUDES.includes(rec.attitude) ? rec.attitude : conf.attitude, real: rec.attitude ?? own, masked: false };
    if (shown === rec.attitude) return { attitude: rec.attitude, real: rec.attitude, masked: false };
    return { attitude: "indifferent", real: rec.attitude, shown, masked: true };
  }
  return { attitude: conf.attitude, real: conf.attitude, masked: false };
}
const attitudeFor = (shop, buyer) => attitudeInfo(shop, buyer).attitude;
const pricePcts = () => Object.fromEntries(ATTITUDES.map((a) => [a, game.settings.get(MOD, `price-${a}`)]));
const hagglePcts = () => Object.fromEntries(HAGGLE_DEGREES.map((d) => [d, Number(game.settings.get(MOD, `haggle-${d}`)) ?? HAGGLE_DEFAULTS[d]]));

/**
 * A market's reputation tier and what it does to prices: { tier: { id, name, revealed }, pct }, or null (no tracker
 * linked, Trackers off, or no tier read yet). Read from the copy the GM's client keeps on the market (syncReputation),
 * the same on every client, so a player sees the price the GM's client will charge.
 */
function reputationOf(market) {
  if (!market?.reputation || !market.repNow || !game.modules.get(TRACKERS)?.active) return null;
  return { tier: market.repNow, pct: Number(market.repPcts?.[market.repNow.id]) || 0 };
}

/** The tier of a Campaign Trackers reputation tracker now, as stored on a market, or null (GM clients: players can't
 * read the trackers). */
function readTier(trackerId) {
  let t = null;
  try {
    t = game.modules.get(TRACKERS)?.api?.get?.(trackerId) ?? null;
  } catch {
    t = null;
  }
  // The market keeps a percent per tier id: a tier without a usable id counts as none.
  const tier = t?.kind === "reputation" ? repTier(t) : null;
  return tier && /^[\w-]{1,64}$/.test(String(tier.id ?? "")) ? { id: tier.id, name: tierName(tier), revealed: t.revealed !== false } : null;
}

/** Copy each linked market's reputation tier onto the market (the lead GM tab, when the trackers change). */
async function syncReputation() {
  if (!game.user.isGM || !game.modules.get(TRACKERS)?.active) return;
  const changed = store().markets.filter((m) => m.reputation).map((m) => [m.id, readTier(m.reputation)])
    .filter(([id, now]) => JSON.stringify(marketById(id)?.repNow ?? null) !== JSON.stringify(now));
  if (changed.length) await mutate((d) => {
    for (const [id, now] of changed) {
      const m = d.markets.find((x) => x.id === id);
      if (m) m.repNow = now;
    }
  });
}

/**
 * What makes up a buyer's prices at a shop, as `user` trades there: { attitude (percent, or null: won't trade),
 * market, marketWhy, rep (reputationOf), haggle (the entry), haggled (percent), total (percent, or null) }.
 */
function priceParts(shop, buyer, user = game.user) {
  const market = shop ? priceMarket(shop.id, user) : null;
  const attitude = attitudePct(attitudeFor(shop, buyer), pricePcts(), game.settings.get(MOD, "hostileRefuses"));
  const rep = reputationOf(market);
  const h = buyer ? haggleNow(flagOf(shop, "haggle"), buyer.id, flagOf(shop, "rotations")) : null;
  const haggled = hagglePct(h, hagglePcts());
  return { attitude, market: market?.pricePct ?? 0, marketWhy: market?.priceWhy ?? "", rep, haggle: h, haggled, total: totalPct({ attitude, market: market?.pricePct ?? 0, reputation: rep?.pct ?? 0, haggle: haggled }) };
}
/** The price change for this buyer at this shop in percent, or null when the shop won't trade with them. */
const pricePct = (shop, buyer, user = game.user) => priceParts(shop, buyer, user).total;

/**
 * Who the shop is, for "won't trade" lines: the shopkeeper's name if there is one, as `user` knows it (a player gets
 * the name the keeper goes by, never the actor's real name).
 */
function shopFace(shop, user = game.user) {
  const keeper = shopConf(shop).keeper ? game.actors.get(shopConf(shop).keeper) : null;
  return keeperFace(keeper, user.isGM)?.name ?? shop?.name ?? L("TheShop");
}
/** "can only pay 12 gp right now", or "has no money to pay with right now", for a shop's purse. */
const canPay = (shop) => (fundsCp(shop) ? L("CanOnlyPay", { amount: fmt(fundsCp(shop)) }) : L("HasNoMoney"));

/** A shop's level: the merchant's own, else its market's. */
const shopLevel = (actor, market) => actorLevel(actor) || market?.level || 0;
/** A shop's full purse in copper, or null when the system's treasure table can't be read. */
const fullPurse = (shop, market = marketOfShop(shop.id)) => purseFor(shopLevel(shop, market), game.settings.get(MOD, "purseScale"));

/** Top a shop's purse up to its level's amount (never takes coins away). Returns what it added in copper, or null when
 * the purse can't be worked out (the system's treasure table couldn't be read). */
async function fillPurse(shop, market = marketOfShop(shop.id)) {
  if (shopConf(shop).unlimited) return 0;
  const target = fullPurse(shop, market);
  if (target === null) return null;
  const add = target - fundsCp(shop);
  if (add > 0) await receive(shop, add);
  return Math.max(0, add);
}

let logWrites = Promise.resolve();
/** Add entries to the log (GM clients only; one write at a time, all of a trade's entries in one, since every client
 * is sent the whole log on each write). */
function logTrade(...entries) {
  if (!game.user.isGM || !entries.length) return;
  const t = Date.now();
  logWrites = logWrites.then(() => game.settings.set(MOD, "log", entries.reduce((log, e) => addLogEntry(log, { t, ...e }), game.settings.get(MOD, "log"))))
    .catch((err) => console.warn(`${MOD} | couldn't write the trade log`, err));
}

/* ------------------------------------------------------------------ */
/* What players saw of a browse-only shop                             */
/* ------------------------------------------------------------------ */

/** Can players trade at this shop right now (in any market that holds it)? */
const openToPlayers = (shop) => !!shopIndex().tradeMarket(shop.id, false);
/**
 * What players last saw: a shop that stops trading notes its rotation count, so a browse-only view knows whether the
 * stock has changed since.
 */
async function noteSeen(shops) {
  for (const shop of shops) {
    const n = Number(flagOf(shop, "rotations")) || 0;
    if (flagOf(shop, "seenRotation") !== n) await shop.update({ [`flags.${MOD}.seenRotation`]: n });
  }
}
/** Do players see a shop's whole stock while it's browse only? Only when they saw it open since its last restock. */
const remembered = (shop) => flagOf(shop, "seenRotation") === (Number(flagOf(shop, "rotations")) || 0);

/* ------------------------------------------------------------------ */
/* The cart (per user, in this browser)                               */
/* ------------------------------------------------------------------ */

/* The cart holds what the user is buying (`lines`: { shop, item, qty }; item is a service's id for a service) and what
 * they're selling (`sales`: { actor, shop, item, qty }, the trader's own items). Sales belong to one character: only
 * the chosen trader's count. */
let memoryCart = null;
function loadCart() {
  const v = browser.get("cart", null) ?? memoryCart ?? {};
  return { lines: cleanLines(v.lines), sales: cleanSales(v.sales), buyer: typeof v.buyer === "string" ? v.buyer : null };
}
function saveCart(cart) {
  const v = { lines: cleanLines(cart.lines), sales: cleanSales(cart.sales), buyer: cart.buyer };
  // No storage: the cart lasts until reload.
  if (!browser.set("cart", v)) memoryCart = v;
}

/** The actors this user can buy for, and the one chosen (the cart's choice, else their own character). */
function buyerChoices(cart) {
  const list = buyersFor(game.user, game.actors.contents).sort((a, b) => (a.type === "party") - (b.type === "party") || a.name.localeCompare(b.name));
  const chosen = list.find((a) => a.id === cart.buyer) ?? list.find((a) => a.id === game.user.character?.id) ?? list[0] ?? null;
  return { list, chosen };
}

/** What each cart line is now: its shop, item or service, price for this buyer and anything wrong with it. */
function cartState(lines, buyer) {
  const formulas = new Set();
  return lines.map((l) => {
    const shop = game.actors.get(l.shop);
    const merchant = isMerchant(shop);
    const item = merchant ? shop.items.get(l.item) : null;
    const service = merchant && !item ? serviceOf(shop, l.item) : null;
    let stock = item ? quantityOf(item) : service ? 1 : 0;
    let { cp, per } = item ? priceOf(item) : { cp: service?.cp ?? 0, per: 1 };
    const market = shop ? tradeMarketFor(shop.id, game.user) : null;
    const pct = shop ? pricePct(shop, buyer) : 0;
    const formula = isFormulaItem(item);
    const uuid = formula ? formulaUuid(item) : null;
    if (formula) {
      ({ cp, per } = itemPrice(item));
      stock = 1;
    }
    let problem = null;
    if (!shop || !merchant) problem = L("ShopGone");
    else if (!service && (!item || !sellable(item))) problem = L("NoLongerForSale");
    else if (formula && !uuid) problem = L("NoLongerForSale");
    else if (formula && cp === null) problem = L("FormulaNoPrice");
    else if (formula && buyer?.type !== "character") problem = L("OnlyCharactersLearn");
    else if (formula && knowsFormula(buyer, uuid)) problem = L("AlreadyKnows", { name: buyer.name, item: realItem(item).name });
    else if (formula && formulas.has(uuid)) problem = L("InCartFromAnother");
    else if (!market) problem = L("ShopNotOpen");
    else if (pct === null) problem = L("WontTradeWith", { shop: shopFace(shop), name: buyer?.name ?? L("You") });
    else if (formula && l.qty > 1) problem = L("OneCopyOnly");
    else if (!service && stock < l.qty) problem = stock ? L("OnlyLeft", { n: stock }) : L("SoldOut");
    else if (!formula && !service && hasParts(item) && l.qty !== stock) problem = L("PartsAllOrNone", { n: stock });
    if (uuid) formulas.add(uuid);
    const price = cp === null ? 0 : buyPrice(cp, per, l.qty, pct ?? 0, isTreasure(item), formula || !!service);
    return { ...l, shopDoc: shop, itemDoc: item, service, formula, stock, cp, per, pct: pct ?? 0, price: service ? buyPrice(cp, 1, l.qty, pct ?? 0, false, false) : price, market, problem };
  });
}

/** The chosen trader's sales in the cart. */
const salesOf = (cart, trader) => (trader ? cart.sales.filter((l) => l.actor === trader.id) : []);

/** What each sale line is now: the shop, the trader's item, the offer, and anything wrong with it. */
function saleState(sales, trader) {
  const rows = new Map(sellRows(trader).map((r) => [r.id, r]));
  return sales.map((l) => {
    const shop = game.actors.get(l.shop);
    const row = rows.get(l.item) ?? null;
    const conf = shopConf(shop);
    const market = shop ? tradeMarketFor(shop.id, game.user) : null;
    const pct = shop ? pricePct(shop, trader) : 0;
    const offer = row ? offerFor(row.cp, row.per, Math.min(l.qty, row.qty), sellRate(conf, row.treasure, pctFor(pct ?? 0, row.treasure))) : 0;
    let problem = null;
    if (!shop || !isMerchant(shop)) problem = L("ShopGone");
    else if (!row) problem = L("NoLongerHas", { name: trader?.name ?? L("You") });
    else if (row.why) problem = row.why;
    else if (!market) problem = L("ShopNotOpen");
    else if (!conf.buys) problem = L("DoesntBuy", { shop: shop.name });
    else if (pct === null) problem = L("WontTradeWith", { shop: shopFace(shop), name: trader?.name ?? L("You") });
    else if (row.qty < l.qty) problem = L("HasOnly", { name: trader.name, n: row.qty, item: row.name });
    else if (row.parts && l.qty !== row.qty) problem = L("PartsAllOrNone", { n: row.qty });
    return { ...l, shopDoc: shop, row, conf, offer, market, problem };
  });
}

/** Each shop's purse, for planTrade. */
const shopInfo = (ids) => new Map([...ids].map((id) => {
  const shop = game.actors.get(id);
  return [id, { unlimited: !!shop && shopConf(shop).unlimited, funds: shop ? fundsCp(shop) : 0 }];
}));

/** The whole cart for the chosen trader: buys, sales, how it settles, and per shop any purse that can't cover it. */
function tradeState(cart, trader) {
  const buys = cartState(cart.lines, trader);
  const sales = saleState(salesOf(cart, trader), trader);
  const s = settle(buys, sales);
  const plan = planTrade(s, shopInfo(s.shops.keys()));
  const short = new Map(plan.short.map((id) => {
    const shop = game.actors.get(id);
    return [id, L("ShopShort", { shop: shop?.name ?? L("TheShop"), can: canPay(shop), owe: fmt(-s.shops.get(id)) })];
  }));
  return { buys, sales, ...s, short, empty: !buys.length && !sales.length };
}

export {
  ATTITUDES_MOD, actorRows, attitudeFor, attitudeInfo, buyerChoices, canPay, cartState, fillPurse, flagOf, formulaMults, fullPurse, isFormulaItem, itemLevel, itemPrice, itemRarity,
  loadCart, logTrade, marketById, marketOfShop, marketsSorted, mutate, mutateMarket, noteSeen, openToPlayers, parentOf, priceMarket, priceParts, pricePct, remembered, reputationOf, saleState, salesOf, saveCart,
  serviceOf, shopConf, shopFace, shopIndex, syncReputation, shopInfo, shopLevel, shopRow, shopRows, shopsFor, store, tradeMarketFor, tradeState,
};
