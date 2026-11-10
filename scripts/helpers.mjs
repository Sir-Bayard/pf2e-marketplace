/**
 * PF2e Marketplace: helpers that need nothing from Foundry or the system, so node tests can load them.
 */

export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const str = (v, max) => String(v ?? "").trim().slice(0, max);
const int = (v, lo, hi) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null;
};
const ID = /^[A-Za-z0-9]{1,32}$/;

/** A market as stored, with every field checked: anything odd in the setting is dropped or reset, never trusted. */
export function cleanMarket(m) {
  if (!m || typeof m !== "object" || !ID.test(String(m.id ?? ""))) return null;
  const extra = Array.isArray(m.extra) ? [...new Set(m.extra.map(String).filter((id) => ID.test(id)))].slice(0, 200) : [];
  return {
    id: String(m.id),
    name: str(m.name, 120) || "Market",
    img: str(m.img, 500),
    description: String(m.description ?? "").slice(0, 50000),
    level: m.level === null || m.level === undefined || m.level === "" ? null : int(m.level, -1, 30),
    folder: ID.test(String(m.folder ?? "")) ? String(m.folder) : null,
    extra,
    visible: !!m.visible,
    open: !!m.open,
    sort: Number.isFinite(Number(m.sort)) ? Number(m.sort) : 0,
    created: Number.isFinite(Number(m.created)) ? Number(m.created) : 0,
    // A timed restock of every shop, in game days (0: none), and the game time of the last one.
    restockEvery: m.restockEvery === null || m.restockEvery === undefined || m.restockEvery === "" ? 0 : int(m.restockEvery, 0, 365),
    lastRestock: m.lastRestock !== null && m.lastRestock !== undefined && m.lastRestock !== "" && Number.isFinite(Number(m.lastRestock)) ? Number(m.lastRestock) : null,
  };
}

/** The module's whole store (one world setting). */
export function cleanStore(raw) {
  const markets = [];
  const seen = new Set();
  for (const m of Array.isArray(raw?.markets) ? raw.markets : []) {
    const c = cleanMarket(m);
    if (c && !seen.has(c.id)) {
      seen.add(c.id);
      markets.push(c);
    }
  }
  return { markets };
}

/** Markets in the order the GM set, then by name. */
export const byMarketOrder = (a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

/** Can this user see the market (GMs always), and can they trade in it? */
export const canSee = (market, isGM) => !!market && (isGM || market.visible);
export const canTrade = (market, isGM) => !!market && (isGM || (market.visible && market.open));
/** Can this user trade with this shop in this market? The market must be open, and the shop (a row from `shopsOf`, or
 * anything with `closed`) not closed by itself. GMs can trade anywhere. */
export const canTradeShop = (market, shop, isGM) => canTrade(market, isGM) && !!shop && (isGM || !shop.closed);

/** Is a folder the market's folder or inside it? `parentOf(id)` gives a folder's parent id (or null). */
export function inFolder(folderId, rootId, parentOf) {
  if (!rootId) return false;
  const seen = new Set();
  for (let f = folderId; f && !seen.has(f); f = parentOf(f)) {
    if (f === rootId) return true;
    seen.add(f);
  }
  return false;
}

/**
 * The shops of a market: merchants in its folder (subfolders too) and those added by hand, by name.
 * `actors` are plain rows { id, name, folder, merchant, hidden, closed }. Players don't get hidden shops.
 */
export function shopsOf(market, actors, parentOf, isGM) {
  if (!market) return [];
  const extra = new Set(market.extra);
  return actors
    .filter((a) => a.merchant && (extra.has(a.id) || inFolder(a.folder, market.folder, parentOf)))
    .filter((a) => isGM || !a.hidden)
    .map((a) => ({ ...a, byHand: extra.has(a.id) && !inFolder(a.folder, market.folder, parentOf) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
}

/* ------------------------------------------------------------------ */
/* Money                                                              */
/* ------------------------------------------------------------------ */

/** Copper as coins for showing: "12 gp 5 sp", "3 cp", or `zero` ("free" for a price; "no money" for a purse).
 * Platinum is shown as gold, as PF2e's prices are. */
export function formatCp(cp, zero = "free") {
  const n = Math.max(0, Math.round(Number(cp) || 0));
  if (!n) return zero;
  const gp = Math.floor(n / 100), sp = Math.floor((n % 100) / 10), c = n % 10;
  return [gp && `${gp.toLocaleString("en-US")} gp`, sp && `${sp} sp`, c && `${c} cp`].filter(Boolean).join(" ");
}

/** The price of `qty` of an item sold in batches of `per` for `cp` copper, rounded up to the copper. */
export const priceFor = (cp, per, qty) => Math.ceil((Math.max(0, Number(cp) || 0) * Math.max(0, Number(qty) || 0)) / Math.max(1, Number(per) || 1));

/* ------------------------------------------------------------------ */
/* Stock                                                              */
/* ------------------------------------------------------------------ */

/** Groups of stock in a shop, by PF2e item type, in the order they're shown. */
export const CATEGORIES = [
  ["weapons", "Weapons", ["weapon", "ammo"]],
  ["armor", "Armor and shields", ["armor", "shield"]],
  ["consumables", "Consumables", ["consumable"]],
  ["runes", "Runes", []],
  ["gear", "Gear", ["equipment", "backpack", "book"]],
  ["treasure", "Treasure", ["treasure"]],
  ["formulas", "Formulas", []],
];
const CATEGORY_OF = new Map(CATEGORIES.flatMap(([key, , types]) => types.map((t) => [t, key])));
/** A row's group: by its type, except runes (PF2e marks them by usage, "etched onto a weapon" or "armor"). */
export const categoryOf = (row) => (row?.formula ? "formulas" : String(row?.usage ?? "").startsWith("etched-onto") ? "runes" : CATEGORY_OF.get(row?.type) ?? "gear");

/** Does a stock row match a search? Every word must appear in its name, its traits or its type. */
export function matchesQuery(row, query) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [row.name, row.type, ...(row.traits ?? [])].join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Stock rows grouped for showing: [key, label, rows] for each group with rows, each group by level then name. */
export function groupStock(rows, query = "") {
  const out = [];
  for (const [key, label] of CATEGORIES) {
    const list = rows.filter((r) => categoryOf(r) === key && matchesQuery(r, query))
      .sort((a, b) => (a.level - b.level) || a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
    if (list.length) out.push([key, label, list]);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The cart                                                           */
/* ------------------------------------------------------------------ */

export const MAX_LINES = 50;
export const MAX_QTY = 9999;

/** Cart lines as stored or sent: each { shop, item, qty } with real ids and a whole quantity, the same item once. */
export function cleanLines(raw) {
  const out = [];
  const seen = new Map();
  for (const l of Array.isArray(raw) ? raw : []) {
    const shop = String(l?.shop ?? ""), item = String(l?.item ?? "");
    const qty = Math.floor(Number(l?.qty));
    if (!ID.test(shop) || !ID.test(item) || !(qty >= 1)) continue;
    const key = `${shop}.${item}`;
    if (seen.has(key)) {
      const line = seen.get(key);
      line.qty = Math.min(MAX_QTY, line.qty + qty);
      continue;
    }
    if (out.length >= MAX_LINES) break;
    const line = { shop, item, qty: Math.min(MAX_QTY, qty) };
    seen.set(key, line);
    out.push(line);
  }
  return out;
}

/** Add to a cart: a new line, or more of one already there, never past what's in stock. */
export function addToCart(lines, shop, item, qty, stock) {
  const out = cleanLines(lines);
  const line = out.find((l) => l.shop === shop && l.item === item);
  const want = Math.min(Math.max(0, stock), (line?.qty ?? 0) + qty);
  if (line) line.qty = want;
  else if (want >= 1 && out.length < MAX_LINES) out.push({ shop, item, qty: want });
  return out.filter((l) => l.qty >= 1);
}

/** Take `qty` off a cart line (the line goes at none). */
export function takeFromCart(lines, shop, item, qty) {
  return cleanLines(lines).map((l) => (l.shop === shop && l.item === item ? { ...l, qty: l.qty - Math.max(0, qty) } : l)).filter((l) => l.qty >= 1);
}

/** "Longsword, 10 Arrows and Chain Mail": a list of bought things for a notice. */
export function listOf(names) {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/* ------------------------------------------------------------------ */
/* Shops: settings, purse, attitude prices, selling                   */
/* ------------------------------------------------------------------ */

/** A party's expected treasure over one level, in gp (GM Core's party treasure by level, total value), 1 to 20. */
export const TREASURE_BY_LEVEL = [175, 300, 500, 850, 1350, 2000, 2900, 4000, 5700, 8000, 11500, 16500, 25000, 36500, 54500, 82500, 128000, 208000, 355000, 490000];

/** A shop's full purse in copper: one level's party treasure for its level (100 gp below level 1), scaled by the
 * world's purse setting (a percentage). */
export function purseFor(level, scalePct = 100) {
  const lvl = Math.round(Number(level) || 0);
  const gp = lvl < 1 ? 100 : TREASURE_BY_LEVEL[Math.min(lvl, 20) - 1];
  const scale = Math.max(0, Number(scalePct) || 0);
  return Math.round(gp * 100 * scale / 100);
}

export const ATTITUDES = ["hostile", "unfriendly", "indifferent", "friendly", "helpful"];
export const ATTITUDE_LABEL = { hostile: "Hostile", unfriendly: "Unfriendly", indifferent: "Indifferent", friendly: "Friendly", helpful: "Helpful" };
export const PRICE_DEFAULTS = { hostile: 50, unfriendly: 20, indifferent: 0, friendly: -10, helpful: -20 };

/** A shop's settings (actor flag `shop`), every field checked. */
export function cleanShop(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const pct = (v, d) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(0, Math.min(1000, n)) : d;
  };
  return {
    buys: r.buys !== false,
    itemRate: pct(r.itemRate, 50),
    treasureRate: pct(r.treasureRate, 100),
    unlimited: !!r.unlimited,
    attitude: ATTITUDES.includes(r.attitude) ? r.attitude : "indifferent",
    keeper: ID.test(String(r.keeper ?? "")) ? String(r.keeper) : null,
    lines: cleanStockLines(r.lines),
    // How many restocks an item players sold stays for (1: gone at the next one).
    keepSold: Number.isFinite(Math.round(Number(r.keepSold))) && r.keepSold !== null && r.keepSold !== "" ? Math.max(1, Math.min(9, Math.round(Number(r.keepSold)))) : 2,
  };
}

/* ------------------------------------------------------------------ */
/* Stock kinds (0.2)                                                  */
/* ------------------------------------------------------------------ */

/** A shop item's place in the stock: a staple comes back to `qty` on each restock; rotating stock is cleared and drawn
 * again; a sold item (one a player sold the shop) stays for `left` more restocks. */
export const STOCK_KINDS = ["staple", "rotating", "sold"];

/**
 * An item's stock flag, cleaned. An item with none is a staple (anything the GM puts in a shop by hand is, a design
 * decision) whose restock quantity is what it has now (`have`).
 */
export function cleanStock(raw, have = 0) {
  const r = raw && typeof raw === "object" ? raw : {};
  const kind = STOCK_KINDS.includes(r.kind) ? r.kind : "staple";
  const whole = (v, lo, hi, d) => {
    const n = Math.round(Number(v));
    return v !== null && v !== "" && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
  };
  const out = { kind };
  if (kind === "staple") out.qty = whole(r.qty, 0, MAX_QTY, Math.max(0, Math.round(Number(have) || 0)));
  if (kind === "sold") out.left = whole(r.left, 0, 9, 2);
  // Sold as a formula (a copy; the shop keeps it), with the GM's own price in copper if set.
  if (r.formula && kind !== "sold") {
    out.formula = true;
    const price = whole(r.price, 0, 100000000, null);
    if (price !== null) out.price = price;
  }
  return out;
}

/** The next kind when the GM clicks an item's stock mark: staple and rotating swap; a sold item becomes a staple. */
export const nextStockKind = (kind) => (kind === "staple" ? "rotating" : "staple");

/** The price change for an attitude, in percent (positive costs more), or null when the shop won't trade at all. */
export function attitudePct(attitude, pcts, hostileRefuses = true) {
  const a = ATTITUDES.includes(attitude) ? attitude : "indifferent";
  if (a === "hostile" && hostileRefuses) return null;
  const n = Number(pcts?.[a]);
  return Number.isFinite(n) ? Math.max(-100, Math.min(1000, n)) : PRICE_DEFAULTS[a];
}

/** The price change that applies to an item: treasure (gems, art objects) is never discounted, since shops buy it
 * back at its full value; a markup still applies. Design decision, 10 Nov. */
export const pctFor = (pct, treasure) => (treasure ? Math.max(0, Number(pct) || 0) : Number(pct) || 0);

/** What a buyer pays for a line: the price for the quantity changed by the buyer's percentage. Treasure is never
 * discounted; a formula is one copy and never treasure. The cart and the GM's client both price lines with this. */
export const buyPrice = (cp, per, qty, pct, treasure = false, formula = false) =>
  adjust(priceFor(cp, formula ? 1 : per, formula ? 1 : qty), pctFor(pct, !formula && !!treasure));

/** A price changed by a percentage, rounded up to the copper (never below nothing). */
export const adjust = (cp, pct) => Math.max(0, Math.ceil((Math.max(0, Number(cp) || 0) * (100 + (Number(pct) || 0))) / 100));

/** The rate a shop pays a seller, in percent: its item or treasure rate, but never more than the share of the price
 * it would charge that seller (100 plus their attitude change), so buying and selling back can't make money. */
export const sellRate = (conf, treasure, pct) => Math.max(0, Math.min(treasure ? conf.treasureRate : conf.itemRate, 100 + (Number(pct) || 0)));

/** What a shop pays for `qty` of an item worth `cp` copper per batch of `per`, at `ratePct` percent: rounded down to
 * the copper, since the shop is the one paying. */
export const offerFor = (cp, per, qty, ratePct) => Math.floor((Math.max(0, Number(cp) || 0) * Math.max(0, Number(qty) || 0) * Math.max(0, Number(ratePct) || 0)) / (Math.max(1, Number(per) || 1) * 100));

/** What the trader offers in the cart: { actor, shop, item, qty }, the trader's item and the shop it's offered to. Each
 * item is offered once, to one shop. */
export function cleanSales(raw) {
  const out = [];
  const seen = new Map();
  for (const l of Array.isArray(raw) ? raw : []) {
    const actor = String(l?.actor ?? ""), shop = String(l?.shop ?? ""), item = String(l?.item ?? "");
    const qty = Math.floor(Number(l?.qty));
    if (!ID.test(actor) || !ID.test(shop) || !ID.test(item) || !(qty >= 1)) continue;
    const key = `${actor}.${item}`;
    if (seen.has(key)) {
      const line = seen.get(key);
      if (line.shop === shop) line.qty = Math.min(MAX_QTY, line.qty + qty);
      continue;
    }
    if (out.length >= MAX_LINES) break;
    const line = { actor, shop, item, qty: Math.min(MAX_QTY, qty) };
    seen.set(key, line);
    out.push(line);
  }
  return out;
}

/** Offer `qty` more of an item to a shop, never more than the trader has. An item already offered to another shop
 * moves to this one, starting again from `qty`. */
export function addSale(sales, actor, shop, item, qty, have) {
  const out = cleanSales(sales);
  const i = out.findIndex((l) => l.actor === actor && l.item === item);
  const was = i >= 0 && out[i].shop === shop ? out[i].qty : 0;
  const want = Math.min(Math.max(0, have), was + qty);
  if (i >= 0) out.splice(i, 1);
  if (want >= 1 && out.length < MAX_LINES) out.push({ actor, shop, item, qty: Math.min(MAX_QTY, want) });
  return out;
}

/** Offer `qty` fewer (the line goes at none). */
export function takeSale(sales, actor, item, qty) {
  return cleanSales(sales).map((l) => (l.actor === actor && l.item === item ? { ...l, qty: l.qty - Math.max(0, qty) } : l)).filter((l) => l.qty >= 1);
}

/**
 * How a trade settles. `buys` are { shop, price } and `sales` { shop, offer }, in copper. Sales are settled with
 * purchases: at each shop only the difference changes hands. Returns { buy, sell, net, shops }: `net` is what the
 * trader pays (negative: what they get), `shops` maps each shop to what it takes in (negative: what it pays out).
 */
export function settle(buys, sales) {
  const shops = new Map();
  let buy = 0, sell = 0;
  for (const b of buys) {
    const n = Math.max(0, Math.round(Number(b.price) || 0));
    buy += n;
    shops.set(b.shop, (shops.get(b.shop) ?? 0) + n);
  }
  for (const s of sales) {
    const n = Math.max(0, Math.round(Number(s.offer) || 0));
    sell += n;
    shops.set(s.shop, (shops.get(s.shop) ?? 0) - n);
  }
  return { buy, sell, net: buy - sell, shops };
}

/**
 * Who pays whom in a settled trade. `shopInfo` maps each shop to { unlimited, funds } (copper). Returns `owing` (shops
 * that pay out, [id, cp]; an unlimited purse pays nothing), `receipts` (shops that take in, [id, cp]) and `short`
 * (shops whose purse can't cover what they owe).
 */
export function planTrade(settled, shopInfo) {
  const owing = [], receipts = [], short = [];
  for (const [id, n] of settled.shops) {
    const info = shopInfo.get(id) ?? { unlimited: false, funds: 0 };
    if (n > 0) receipts.push([id, n]);
    else if (n < 0 && !info.unlimited) {
      owing.push([id, -n]);
      if ((Number(info.funds) || 0) < -n) short.push(id);
    }
  }
  return { owing, receipts, short };
}

/* ------------------------------------------------------------------ */
/* The trade log                                                      */
/* ------------------------------------------------------------------ */

export const LOG_MAX = 300;

/** A log entry as stored, checked. */
export function cleanLogEntry(e) {
  if (!e || typeof e !== "object") return null;
  const kind = ["buy", "sell", "trade"].includes(e.kind) ? e.kind : null;
  if (!kind) return null;
  const list = (v) => (Array.isArray(v) ? v : []).slice(0, MAX_LINES).map((i) => ({ name: str(i?.name, 120), qty: Math.max(1, Math.floor(Number(i?.qty)) || 1) }));
  const items = list(e.items);
  const extra = kind === "trade" ? { got: list(e.got), net: Math.round(Number(e.net) || 0) } : {};
  return {
    ...extra,
    t: Number.isFinite(Number(e.t)) ? Number(e.t) : 0,
    kind,
    user: str(e.user, 80),
    actor: str(e.actor, 120),
    shop: str(e.shop, 120),
    market: str(e.market, 120),
    items,
    cp: Math.max(0, Math.round(Number(e.cp) || 0)),
    note: str(e.note, 600),
  };
}

/** The log with a new entry first, at most LOG_MAX entries. */
export function addLogEntry(log, entry) {
  const e = cleanLogEntry(entry);
  const list = (Array.isArray(log) ? log : []).map(cleanLogEntry).filter(Boolean);
  return e ? [e, ...list].slice(0, LOG_MAX) : list.slice(0, LOG_MAX);
}

/** "Dagger priced by hand at 500 gp (its compendium entry: 2 sp)" for the GM's notice and the log. */
export function handPricedNote(name, h) {
  const price = (cp, per) => `${formatCp(cp)}${per > 1 ? ` for ${per}` : ""}`;
  return h.source ? `${name} priced by hand at ${price(h.cp, h.per)} (its compendium entry: ${price(h.source.cp, h.source.per)})`
    : `${name} has no compendium entry; priced at ${price(h.cp, h.per)}`;
}

/* ------------------------------------------------------------------ */
/* Drawing rotating stock (0.2)                                       */
/* ------------------------------------------------------------------ */

/** The ready filters a shop's rotating stock is drawn with. `scrolls` and `wands` also make spell scrolls and magic wands
 * from the spell list (the caller does that part). Each test reads a compendium index entry. */
const tr = (e) => e?.system?.traits?.value ?? [];
const cat = (e) => String(e?.system?.category ?? "");
const usage = (e) => String(e?.system?.usage?.value ?? "");
const magical = (e) => tr(e).some((t) => t === "magical" || t === "invested" || t === "arcane" || t === "divine" || t === "occult" || t === "primal");
export const STOCK_FILTERS = [
  { id: "weapons", label: "Weapons", test: (e) => e.type === "weapon" && e.system?.group !== "bomb" && !tr(e).includes("staff") },
  { id: "armor", label: "Armor", test: (e) => e.type === "armor" },
  { id: "shields", label: "Shields", test: (e) => e.type === "shield" },
  { id: "ammo", label: "Ammunition", test: (e) => e.type === "ammo" },
  { id: "bombs", label: "Bombs", test: (e) => e.type === "weapon" && e.system?.group === "bomb" },
  { id: "elixirs", label: "Elixirs and mutagens", test: (e) => e.type === "consumable" && ["elixir", "mutagen"].includes(cat(e)) },
  { id: "alchemy", label: "Poisons and alchemical tools", test: (e) => e.type === "consumable" && (cat(e) === "poison" || (tr(e).includes("alchemical") && !["elixir", "mutagen", "potion", "oil"].includes(cat(e)))) },
  { id: "potions", label: "Potions and oils", test: (e) => e.type === "consumable" && ["potion", "oil"].includes(cat(e)) },
  { id: "scrolls", label: "Scrolls", test: (e) => e.type === "consumable" && cat(e) === "scroll" },
  { id: "wands", label: "Wands", test: (e) => e.type === "consumable" && cat(e) === "wand" },
  { id: "staves", label: "Staves", test: (e) => e.type === "weapon" && tr(e).includes("staff") },
  { id: "talismans", label: "Talismans", test: (e) => e.type === "consumable" && ["talisman", "fulu"].includes(cat(e)) },
  { id: "weapon-runes", label: "Weapon runes", test: (e) => e.type === "equipment" && usage(e).startsWith("etched-onto-a-weapon") },
  { id: "armor-runes", label: "Armor runes", test: (e) => e.type === "equipment" && usage(e).startsWith("etched-onto-armor") },
  { id: "worn", label: "Worn items", test: (e) => e.type === "equipment" && usage(e).startsWith("worn") && magical(e) },
  { id: "held", label: "Held and other magic items", test: (e) => e.type === "equipment" && magical(e) && !usage(e).startsWith("worn") && !usage(e).startsWith("etched") },
  // Kits are left out: the system unpacks a kit into its contents when it lands on an actor.
  { id: "gear", label: "Adventuring gear", test: (e) => ["equipment", "backpack", "book"].includes(e.type) && !magical(e) && !usage(e).startsWith("etched") },
  { id: "treasure", label: "Gems and art", test: (e) => e.type === "treasure" && ["gem", "art-object"].includes(cat(e)) },
  // Formulas: the shop sells a copy of the formula, not the item.
  { id: "formulas-alchemical", label: "Formulas: alchemical", formula: true, test: (e) => tr(e).includes("alchemical") && e.type !== "treasure" },
  { id: "formulas", label: "Formulas: any", formula: true, test: (e) => ["weapon", "armor", "shield", "ammo", "consumable", "equipment", "backpack"].includes(e.type) },
];
const FILTER_IDS = new Set(STOCK_FILTERS.map((f) => f.id));
export const filterLabel = (id) => STOCK_FILTERS.find((f) => f.id === id)?.label ?? id;

/** How many a line draws: a size (its range is a world setting) or an exact number. */
export const AMOUNTS = ["few", "some", "many", "lots"];
export const AMOUNT_LABEL = { few: "Few", some: "Some", many: "Many", lots: "Lots" };
export const AMOUNT_DEFAULTS = { few: "1-3", some: "3-6", many: "6-10", lots: "10-20" };
/** Rarities a line can reach: common only, up to uncommon, or up to rare (unique items are never drawn). */
export const LINE_RARITIES = ["common", "uncommon", "rare"];
const RARITY_RANK = { common: 0, uncommon: 1, rare: 2 };
export const rarityAllowed = (rarity, upTo) => (RARITY_RANK[rarity ?? "common"] ?? 9) <= (RARITY_RANK[upTo] ?? 0);

/** A range written "3-6" (or "4"), as [min, max] within lo..hi; `fallback` when it can't be read. */
export function parseRange(text, fallback = [1, 1], lo = 1, hi = 50) {
  const m = String(text ?? "").trim().match(/^(\d+)\s*(?:-|to)?\s*(\d+)?$/);
  if (!m) return fallback;
  let a = Math.max(lo, Math.min(hi, Number(m[1]))), b = m[2] === undefined ? a : Math.max(lo, Math.min(hi, Number(m[2])));
  if (a > b) [a, b] = [b, a];
  return [a, b];
}
export const rollRange = ([a, b], rand = Math.random) => a + Math.floor(rand() * (b - a + 1));

/** A line of a shop's rotating stock: { filter, amount (a size or 1 to 50), rarity (how rare it may draw) }. 12 at
 * most. Lines saved by earlier builds ({ count, uncommon }) read the same. */
export const MAX_STOCK_LINES = 12;
export function cleanStockLines(raw) {
  const out = [];
  for (const l of Array.isArray(raw) ? raw : []) {
    if (!FILTER_IDS.has(l?.filter) || out.length >= MAX_STOCK_LINES) continue;
    let amount = l.amount ?? l.count;
    if (!AMOUNTS.includes(amount)) {
      const n = Math.round(Number(amount));
      amount = Number.isFinite(n) ? Math.max(1, Math.min(50, n)) : "some";
    }
    const rarity = LINE_RARITIES.includes(l.rarity) ? l.rarity : l.uncommon ? "uncommon" : "common";
    out.push({ filter: l.filter, amount, rarity });
  }
  return out;
}
/** How many a line draws this time: an exact number, or a roll in its size's range (`ranges`: size to "a-b"). */
export function lineCount(line, ranges = AMOUNT_DEFAULTS, rand = Math.random) {
  if (typeof line.amount === "number") return line.amount;
  return rollRange(parseRange(ranges[line.amount], parseRange(AMOUNT_DEFAULTS[line.amount] ?? "3-6")), rand);
}

/** Can an index entry be drawn at all: a price, not unique or cursed, not a spell template. (A line decides how rare.) */
export function drawable(e, templates = new Set()) {
  const rarity = e?.system?.traits?.rarity ?? "common";
  if (rarity === "unique") return false;
  if (tr(e).includes("cursed") || tr(e).includes("artifact")) return false;
  if (templates.has(e.uuid) || templates.has(e._id)) return false;
  const p = e?.system?.price?.value ?? {};
  const cp = (Number(p.pp) || 0) * 1000 + (Number(p.gp) || 0) * 100 + (Number(p.sp) || 0) * 10 + (Number(p.cp) || 0);
  return cp > 0;
}
export const entryLevel = (e) => Math.max(0, Number(e?.system?.level?.value ?? 0) || 0);

/** How likely a level is to be drawn, leaning to the shop's level: each level below it is about two thirds as likely
 * as the one above (design decision: most draws near the shop's level, a few lower). */
export const levelWeight = (level, max) => Math.pow(0.62, Math.max(0, max - level));

/**
 * Draw `count` different entries for one line: a level first (weighted, among levels that have something), then an
 * entry at that level. `pool` is the line's entries already filtered; `rand` returns [0, 1). Never more than the pool has.
 */
export function drawEntries(pool, count, maxLevel, rand = Math.random) {
  const byLevel = new Map();
  for (const e of pool) {
    const lv = entryLevel(e);
    if (lv > maxLevel) continue;
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv).push(e);
  }
  const out = [];
  while (out.length < count && byLevel.size) {
    const levels = [...byLevel.keys()];
    const weights = levels.map((lv) => levelWeight(lv, maxLevel));
    let r = rand() * weights.reduce((a, b) => a + b, 0);
    let i = 0;
    while (i < levels.length - 1 && r >= weights[i]) r -= weights[i++];
    const list = byLevel.get(levels[i]);
    const [pick] = list.splice(Math.floor(rand() * list.length), 1);
    if (!list.length) byLevel.delete(levels[i]);
    out.push(pick);
  }
  return out;
}

/** How many of a drawn item a shop gets: consumables (but wands, which are used again), bombs and ammunition come in a
 * stack (of their batch) rolled in `stack` (a world setting, 1 to 4 by default), everything else one each. */
export const stacks = (e) => (e?.type === "consumable" && e?.system?.category !== "wand") || e?.type === "ammo" || (e?.type === "weapon" && e?.system?.group === "bomb");
export const drawnQty = (e, rand = Math.random, stack = [1, 4]) => (stacks(e) ? rollRange(stack, rand) : 1);

/** Can a spell (an index entry of the spell list) go on a scroll or in a wand: not a cantrip, focus spell or ritual,
 * and no rarer than the line allows (`upTo`: common, uncommon or rare; true means uncommon, as earlier builds). */
export function scribable(e, upTo = "common") {
  const t = tr(e);
  if (t.includes("cantrip") || t.includes("focus")) return false;
  if (e?.system?.ritual) return false;
  return rarityAllowed(e?.system?.traits?.rarity, upTo === true ? "uncommon" : upTo || "common");
}

/**
 * Draw `count` different spells for scrolls or wands. `ranks` maps each rank to its template's item level; a rank is
 * chosen by that level's weight (as `drawEntries` does), then a spell of exactly that rank. Returns [{ spell, rank }].
 */
export function drawSpells(spells, ranks, count, maxLevel, rand = Math.random) {
  const byRank = new Map();
  for (const sp of spells) {
    const r = Number(sp?.system?.level?.value) || 0;
    const lv = ranks.get(r);
    if (lv === undefined || lv === null || lv > maxLevel) continue;
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r).push(sp);
  }
  const out = [];
  while (out.length < count && byRank.size) {
    const rs = [...byRank.keys()];
    const weights = rs.map((r) => levelWeight(ranks.get(r), maxLevel));
    let x = rand() * weights.reduce((a, b) => a + b, 0);
    let i = 0;
    while (i < rs.length - 1 && x >= weights[i]) x -= weights[i++];
    const list = byRank.get(rs[i]);
    const [spell] = list.splice(Math.floor(rand() * list.length), 1);
    if (!list.length) byRank.delete(rs[i]);
    out.push({ spell, rank: rs[i] });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Restocking (0.2)                                                   */
/* ------------------------------------------------------------------ */

/**
 * What a restock does to a shop's items (`items`: { id, qty, stock } with the raw stock mark): staples go back to
 * exactly their number, rotating stock is cleared, and sold items count down, going when none are left. With
 * `keepSold`, sold items neither count down nor go this time. Returns { refill: [{ id, qty }], remove: [id],
 * age: [{ id, left }] }.
 */
export function restockPlan(items, { keepSold = false } = {}) {
  const refill = [], remove = [], age = [];
  for (const it of items) {
    const st = cleanStock(it.stock, it.qty);
    if (st.kind === "staple") {
      if (st.qty !== it.qty) refill.push({ id: it.id, qty: st.qty });
    } else if (st.kind === "rotating") remove.push(it.id);
    else if (!keepSold) {
      if (st.left <= 1) remove.push(it.id);
      else age.push({ id: it.id, left: st.left - 1 });
    }
  }
  return { refill, remove, age };
}

/** Is a timed restock due? `every` in days, times in seconds of game time. A market never restocked starts its clock at
 * the first check (returns false, and the caller notes the time). */
export const restockDue = (every, last, now) => every > 0 && last !== null && Number.isFinite(last) && now - last >= every * 86400;

/** A formula's uuid in one form, so old and new compendium links match: `Compendium.<pack>.Item.<id>` (older items say
 * `Compendium.<pack>.<id>`). Anything else is kept as it is; no uuid gives null. */
export function formulaKey(uuid) {
  if (!uuid) return null;
  const parts = String(uuid).split(".");
  if (parts[0] !== "Compendium" || parts.length < 4) return String(uuid);
  return `Compendium.${parts[1]}.${parts[2]}.Item.${parts[parts.length - 1]}`;
}

/** A compendium source as a key that matches old and new forms ("Compendium.pack.ID" and "Compendium.pack.Item.ID"):
 * the pack and the document id. */
export function sourceKey(uuid) {
  const parts = String(uuid ?? "").split(".");
  if (parts[0] !== "Compendium" || parts.length < 4) return null;
  return `${parts[1]}.${parts[2]}.${parts[parts.length - 1]}`;
}

/* ------------------------------------------------------------------ */
/* The Trade Post (0.3)                                               */
/* ------------------------------------------------------------------ */

/** Offers a character can have up at once, and in all. */
export const MAX_OFFERS_EACH = 10;
export const MAX_OFFERS = 100;
const MAX_OFFER_ITEMS = 20;

/** Coins as copper: { gp, sp, cp } (or a number) to a whole number of copper, 0 to a million gold. */
export function coinsCp(c) {
  if (typeof c === "number") return Math.max(0, Math.min(100000000, Math.round(c) || 0));
  const n = (Number(c?.pp) || 0) * 1000 + (Number(c?.gp) || 0) * 100 + (Number(c?.sp) || 0) * 10 + (Number(c?.cp) || 0);
  return Math.max(0, Math.min(100000000, Math.round(n) || 0));
}

/** Items in an offer: { item (the owner's item id), qty, name, img }, each item once. */
function cleanOfferItems(raw) {
  const out = [];
  const seen = new Set();
  for (const l of Array.isArray(raw) ? raw : []) {
    const item = String(l?.item ?? "");
    const qty = Math.floor(Number(l?.qty));
    if (!ID.test(item) || seen.has(item) || !(qty >= 1) || out.length >= MAX_OFFER_ITEMS) continue;
    seen.add(item);
    out.push({ item, qty: Math.min(MAX_QTY, qty), name: str(l.name, 120), img: str(l.img, 500) });
  }
  return out;
}

/**
 * A Trade Post offer: one character (`from`) gives items and coins, and wants coins, and items of the character it's
 * for (`to`; none for an offer open to anyone, who can only be asked for coins). `note` is the poster's words.
 */
export function cleanOffer(o) {
  if (!o || typeof o !== "object" || !ID.test(String(o.id ?? "")) || !ID.test(String(o.from ?? ""))) return null;
  const to = ID.test(String(o.to ?? "")) && o.to !== o.from ? String(o.to) : null;
  const give = { items: cleanOfferItems(o.give?.items), cp: coinsCp(o.give?.cp) };
  const want = { items: to ? cleanOfferItems(o.want?.items) : [], cp: coinsCp(o.want?.cp) };
  if (!give.items.length && !give.cp) return null;
  if (!want.items.length && !want.cp && !give.items.length) return null;
  return {
    id: String(o.id),
    from: String(o.from),
    user: ID.test(String(o.user ?? "")) ? String(o.user) : null,
    to,
    give,
    want,
    note: str(o.note, 300),
    created: Number.isFinite(Number(o.created)) ? Number(o.created) : 0,
  };
}

/** All offers, newest first, each id once, capped per character and in all. */
export function cleanOffers(raw) {
  const out = [];
  const seen = new Set();
  const each = new Map();
  const list = (Array.isArray(raw) ? raw : []).map(cleanOffer).filter(Boolean).sort((a, b) => b.created - a.created);
  for (const o of list) {
    if (seen.has(o.id) || out.length >= MAX_OFFERS) continue;
    const n = each.get(o.from) ?? 0;
    if (n >= MAX_OFFERS_EACH) continue;
    seen.add(o.id);
    each.set(o.from, n + 1);
    out.push(o);
  }
  return out;
}

/** Can a character take this offer: not their own, and the offer is open or for them. */
export const canAccept = (offer, actorId) => !!offer && !!actorId && offer.from !== actorId && (!offer.to || offer.to === actorId);

/** What changes hands, in copper, when an offer is taken: positive, the taker pays the poster; negative, the reverse. */
export const offerNet = (offer) => coinsCp(offer?.want?.cp) - coinsCp(offer?.give?.cp);

/* ------------------------------------------------------------------ */
/* Formulas (0.4)                                                     */
/* ------------------------------------------------------------------ */

/** A common formula's price in gold by item level, 0 to 20 (the rules' Formula Price table). */
export const FORMULA_GP = [0.5, 1, 2, 3, 5, 8, 13, 18, 25, 35, 50, 70, 100, 150, 225, 325, 500, 750, 1200, 2000, 3500];
/** What uncommon and rare formulas cost, as multiples of a common one (world settings; unique items have none). */
export const FORMULA_MULT_DEFAULTS = { uncommon: 2, rare: 10 };

/** A formula's price in copper: the table for its level (below 0 as 0, above 20 as 20) times its rarity's multiple. */
export function formulaPrice(level, rarity = "common", mults = FORMULA_MULT_DEFAULTS) {
  const lv = Math.max(0, Math.min(20, Math.floor(Number(level) || 0)));
  const n = Number(mults?.[rarity] ?? FORMULA_MULT_DEFAULTS[rarity] ?? 1);
  const m = rarity === "common" || !Number.isFinite(n) || n <= 0 ? 1 : n;
  return Math.round(FORMULA_GP[lv] * 100 * m);
}
