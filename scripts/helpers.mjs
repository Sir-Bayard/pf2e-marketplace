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
 * `actors` are plain rows { id, name, folder, merchant, hidden }. Players don't get hidden shops.
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
  ["gear", "Gear", ["equipment", "backpack", "kit", "book"]],
  ["treasure", "Treasure", ["treasure"]],
];
const CATEGORY_OF = new Map(CATEGORIES.flatMap(([key, , types]) => types.map((t) => [t, key])));
/** A row's group: by its type, except runes (PF2e marks them by usage, "etched onto a weapon" or "armor"). */
export const categoryOf = (row) => (String(row?.usage ?? "").startsWith("etched-onto") ? "runes" : CATEGORY_OF.get(row?.type) ?? "gear");

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

/** "Longsword, 10 Arrows and Chain Mail": a list of bought things for a notice. */
export function listOf(names) {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
