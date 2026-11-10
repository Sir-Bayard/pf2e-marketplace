/**
 * PF2e Marketplace: everything that reads or writes the PF2e system's own data lives here, so a system update
 * that breaks something breaks it in one place. Each function says which part of the system it relies on.
 */

/** A PF2e merchant: a loot actor whose sheet type is "Merchant" (`system.lootSheetType`). */
export const isMerchant = (actor) => actor?.type === "loot" && actor.system?.lootSheetType === "Merchant";

const MOD_ID = "pf2e-marketplace";

/** A loot actor's level (`system.details.level.value`). */
export const actorLevel = (actor) => Number(actor?.system?.details?.level?.value ?? 0) || 0;

/** The item types PF2e counts as physical (things that can sit in an inventory). */
const PHYSICAL = new Set(["weapon", "ammo", "armor", "shield", "consumable", "equipment", "backpack", "kit", "book", "treasure"]);
const isPhysical = (item) => (typeof item?.isOfType === "function" ? item.isOfType("physical") : PHYSICAL.has(item?.type));

/** Coins are treasure items with category "coin" (`isCoinage`); they're the shop's money, not its stock. */
const isCoins = (item) => !!item?.isCoinage || (item?.type === "treasure" && item.system?.category === "coin");

/** An item as a shop sells it: always the real, identified item (shops sell identified goods, a design decision), read
 * from its source data so PF2e's mystified name and picture for an unidentified item don't show through. */
export function realItem(item) {
  const src = item?._source ?? {};
  return {
    name: src.name ?? item?.name ?? "",
    img: src.img ?? item?.img ?? "",
    description: String(src.system?.description?.value ?? item?.system?.description?.value ?? ""),
  };
}

/** An item's price in copper for one batch, and the batch size (`price.value.copperValue`, `price.per`). */
export function priceOf(item) {
  const p = item?.price ?? item?.system?.price ?? {};
  const v = p.value;
  const cp = typeof v?.copperValue === "number" ? v.copperValue : coinsToCp(v);
  return { cp: Math.max(0, Math.round(cp || 0)), per: Math.max(1, Number(p.per) || 1) };
}
const coinsToCp = (c) => (c && typeof c === "object" ? (Number(c.pp) || 0) * 1000 + (Number(c.gp) || 0) * 100 + (Number(c.sp) || 0) * 10 + (Number(c.cp) || 0) : 0);

/**
 * A shop's stock as plain rows: every physical item but coins. Items inside containers are listed too; a container
 * that holds something can't be sold as it is (PF2e won't sell one).
 */
export function stockRows(actor) {
  const out = [];
  for (const item of actor?.items ?? []) {
    if (!isPhysical(item) || isCoins(item)) continue;
    const { cp, per } = priceOf(item);
    const real = realItem(item);
    const holds = item.type === "backpack" ? (item.contents?.size ?? 0) : 0;
    out.push({
      id: item.id,
      name: real.name,
      img: real.img,
      type: item.type,
      usage: String(item.system?.usage?.value ?? ""),
      level: Number(item.level ?? item.system?.level?.value ?? 0) || 0,
      rarity: item.rarity ?? item.system?.traits?.rarity ?? "common",
      traits: [...(item.traits ?? item.system?.traits?.value ?? [])].map(String),
      qty: Math.max(0, Number(item.quantity ?? item.system?.quantity ?? 0) || 0),
      cp,
      per,
      holds,
      inside: !!item.system?.containerId,
      // Shown and sold identified; the GM sees a note that the sheet has it unidentified.
      identified: item.isIdentified !== false,
      // The module's stock mark (staple, rotating, sold), raw; cleaned by the caller.
      stock: item.flags?.[MOD_ID]?.stock ?? null,
    });
  }
  return out;
}

/** An item's description for showing: the players' text only (PF2e keeps GM notes in a separate field). */
export const descriptionOf = (item) => realItem(item).description;

/** A new, empty PF2e merchant. */
export function merchantData(name, folder, img) {
  return { name, type: "loot", folder: folder ?? null, img: img || undefined, system: { lootSheetType: "Merchant" } };
}

/* ------------------------------------------------------------------ */
/* Trading                                                            */
/* ------------------------------------------------------------------ */

/** Can a shop sell this item as it is? Physical, not coins, and not a container with things in it. */
export function sellable(item) {
  if (!item || !isPhysical(item) || isCoins(item)) return false;
  return !(item.type === "backpack" && (item.contents?.size ?? 0) > 0);
}

/** An item's quantity (`system.quantity`). */
export const quantityOf = (item) => Math.max(0, Number(item?.quantity ?? item?.system?.quantity ?? 0) || 0);

/** All the money an actor has, in copper (`inventory.currency.copperValue`). */
export function fundsCp(actor) {
  const inv = actor?.inventory;
  const v = inv?.currency?.copperValue ?? inv?.coins?.copperValue;
  return Math.max(0, Math.round(Number(v) || 0));
}

/** Copper as PF2e coins, gold first, for paying in (so a shop isn't handed a pile of copper). */
export const asCoins = (cp) => {
  const n = Math.max(0, Math.round(Number(cp) || 0));
  return { pp: 0, gp: Math.floor(n / 100), sp: Math.floor((n % 100) / 10), cp: n % 10 };
};

/** Take money from an actor, making change from bigger coins as PF2e does (`inventory.removeCoins`, by value).
 * False when it hasn't enough. */
export async function pay(actor, cp) {
  if (cp <= 0) return true;
  return !!(await actor.inventory.removeCoins(asCoins(cp)));
}

/** Give an actor money (`inventory.addCoins`). */
export async function receive(actor, cp) {
  if (cp > 0) await actor.inventory.addCoins(asCoins(cp));
}

/** The data for a bought copy of an item: the quantity bought, identified (shops sell identified goods), not equipped,
 * out of any container. Equip state as PF2e gives a newly moved item: carried as worn, out of its slot if worn. */
export function boughtCopy(item, qty) {
  const data = item.toObject();
  delete data._id;
  data.system ??= {};
  data.system.quantity = qty;
  data.system.containerId = null;
  if (data.system.identification) data.system.identification.status = "identified";
  // The module's own marks (a sold item's rotation count) stay with the shop.
  if (data.flags?.[MOD_ID]) delete data.flags[MOD_ID];
  const worn = item.system?.usage?.type === "worn" && item.system?.usage?.where;
  data.system.equipped = worn ? { carryType: "worn", inSlot: false } : { carryType: "worn" };
  return data;
}

/** Put items in an actor's inventory, stacked with what it already has where PF2e can (`inventory.add`). */
export async function giveItems(actor, datas) {
  if (!datas.length) return;
  if (typeof actor.inventory?.add === "function") await actor.inventory.add(datas, { stack: true });
  else await actor.createEmbeddedDocuments("Item", datas);
}

/** Take a quantity out of a shop's stock. Rotating and sold stock goes when none are left, as PF2e's own sale does; a
 * staple (an item with no stock mark is one) stays at none, sold out until the next restock. An actor's own items
 * (a character selling) always go at none. */
export async function takeFromStock(item, qty) {
  // Never more than there is now: a stack that shrank since the check is an error, not a deletion.
  if (quantityOf(item) < qty) throw new Error(`only ${quantityOf(item)} of ${item.name} left`);
  const left = quantityOf(item) - qty;
  const mark = item.flags?.[MOD_ID]?.stock;
  const staple = isMerchant(item.parent) && (mark?.kind ?? "staple") === "staple";
  if (left < 1 && !staple) return void (await item.delete());
  // An unmarked shop item is a staple of what it had before this sale: write that down now, or every sale would lower
  // what it restocks to.
  const change = { "system.quantity": Math.max(0, left) };
  if (staple && !mark) change[`flags.${MOD_ID}.stock`] = { kind: "staple", qty: quantityOf(item) };
  await item.update(change, { pmkInternal: true });
}

/** Actors a user can buy for: characters they own, and the party (its stash) if they own it. A GM can buy for any
 * character a player owns, and the party. */
export function buyersFor(user, actors) {
  return actors.filter((a) => {
    if (a.type !== "character" && a.type !== "party") return false;
    if (user.isGM) return a.type === "party" || a.hasPlayerOwner;
    return a.testUserPermission(user, "OWNER");
  });
}

/* ------------------------------------------------------------------ */
/* Selling to a shop                                                  */
/* ------------------------------------------------------------------ */

/** Treasure (gems, art objects and the like) that isn't coins: shops pay their treasure rate for it. */
export const isTreasure = (item) => item?.type === "treasure" && !isCoins(item);

/**
 * What a character can offer a shop, as plain rows: every physical item but coins. `why` says why one can't be sold
 * (unidentified items must be identified first, a design decision; a container must be emptied first; a temporary
 * item, or one a feature or effect granted, isn't the character's to sell).
 */
export function sellRows(actor) {
  const out = [];
  for (const item of actor?.items ?? []) {
    if (!isPhysical(item) || isCoins(item)) continue;
    const { cp, per } = priceOf(item);
    let why = null;
    if (item.isIdentified === false) why = "Identify it first.";
    else if (granted(item)) why = "Not yours to sell (temporary, or granted by a feature).";
    else if (item.type === "backpack" && (item.contents?.size ?? 0) > 0) why = "Empty it first.";
    const unid = item.isIdentified === false ? item.system?.identification?.unidentified ?? {} : null;
    out.push({ id: item.id, name: unid ? unid.name || "Unidentified item" : item.name, img: unid?.img || item.img, type: item.type, qty: quantityOf(item), cp, per, treasure: isTreasure(item), why });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
}

/** What a character can trade to another at the Trade Post, as plain rows: like `sellRows`, but an unidentified item can
 * change hands as it is (shown by its unidentified name). */
export function tradeRows(actor) {
  const out = [];
  for (const item of actor?.items ?? []) {
    if (!isPhysical(item) || isCoins(item)) continue;
    let why = null;
    if (granted(item)) why = "Not yours to trade (temporary, or granted by a feature).";
    else if (item.type === "backpack" && (item.contents?.size ?? 0) > 0) why = "Empty it first.";
    const unid = item.isIdentified === false ? item.system?.identification?.unidentified ?? {} : null;
    out.push({ id: item.id, name: unid ? unid.name || "Unidentified item" : item.name, img: unid?.img || item.img, qty: quantityOf(item), why });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
}

/** Can this item be sold to a shop now? Something worth nothing sells for nothing (a design decision: a way to get rid
 * of things while shopping). */
export const canSellToShop = (item) => !!item && isPhysical(item) && !isCoins(item) && item.isIdentified !== false && !granted(item)
  && !(item.type === "backpack" && (item.contents?.size ?? 0) > 0);
/** A temporary item (`system.temporary`), or one granted by a feat, feature or effect (`flags.pf2e.grantedBy`). */
function granted(item) {
  return !!item?.system?.temporary || !!item?.flags?.pf2e?.grantedBy;
}

/** The data for an item a shop bought: the quantity sold, out of any container, unequipped, marked as sold to the shop
 * for `left` more restocks (flag `stock`). */
export function soldCopy(item, qty, mod, left = 2) {
  const data = item.toObject();
  delete data._id;
  data.system ??= {};
  data.system.quantity = qty;
  data.system.containerId = null;
  data.system.equipped = { carryType: "worn" };
  delete data.system.temporary;
  data.flags ??= {};
  if (data.flags.pf2e?.grantedBy) delete data.flags.pf2e.grantedBy;
  data.flags[mod] = { ...(data.flags[mod] ?? {}), stock: { kind: "sold", left } };
  return data;
}

/** Set a loot actor's level (`system.details.level.value`). */
export const setLevel = (actor, level) => actor.update({ "system.details.level.value": Math.round(Number(level) || 0) });

/** Art that came with a stat block (the system's, core's or a token pack's): its path can name the real creature. */
const SHIPPED_ART = /^(?:systems\/pf2e\/|modules\/(?:pf2e-tokens-|pathfinder-tokens|pf2e-bestiary-|pf2e-monster-core|pf2e-npc-core)|icons\/)/i;
/** A shopkeeper as players know them: the name they go by (PF2e NPC Attitudes' "known as", else the token's name) and
 * the picture players get there (its portrait, else the actor's art unless it came with a stat block, else the token). */
export function keeperFace(actor, isGM) {
  if (!actor) return null;
  const rec = actor.flags?.["pf2e-npc-attitudes"]?.npc ?? {};
  const name = isGM ? actor.name : (rec.knownAs || actor.prototypeToken?.name?.trim() || actor.name);
  const art = actor.img && !SHIPPED_ART.test(actor.img) ? actor.img : null;
  return { name, img: rec.portrait || art || actor.prototypeToken?.texture?.src || actor.img };
}

/**
 * Was this item's price set by hand? Compares the price stored on the item (PF2e adds runes and materials on top of
 * it, so upgraded gear doesn't count) with the price on its compendium entry (`_stats.compendiumSource`, or the older
 * `flags.core.sourceId`). Null when they agree; otherwise `{ cp, per, source }` (source null when the item has no
 * entry, as homebrew does). The sale still goes through; the GM's notice and the trade log say so.
 */
export async function handPriced(item) {
  const own = item?._source?.system?.price ?? {};
  const cp = coinsToCp(own.value), per = Math.max(1, Number(own.per) || 1);
  const uuid = item?._stats?.compendiumSource ?? item?.flags?.core?.sourceId ?? null;
  let src = null;
  if (uuid) {
    try {
      src = await fromUuid(uuid);
    } catch {
      src = null;
    }
  }
  if (!src) return { cp, per, source: null };
  const sp = src._source?.system?.price ?? src.system?.price ?? {};
  const scp = coinsToCp(sp.value), sper = Math.max(1, Number(sp.per) || 1);
  // The same price per unit, whatever the batch size.
  if (scp * per === cp * sper) return null;
  return { cp, per, source: { cp: scp, per: sper } };
}

/* ------------------------------------------------------------------ */
/* The compendium, for drawing stock (0.2)                            */
/* ------------------------------------------------------------------ */

const EQUIPMENT_PACK = "pf2e.equipment-srd";
const SPELL_PACK = "pf2e.spells-srd";
let equipmentCache = null, spellCache = null;

/** The system's equipment as index entries, with the fields the filters read (`getIndex({ fields })`). */
export async function equipmentIndex() {
  if (equipmentCache) return equipmentCache;
  const pack = game.packs.get(EQUIPMENT_PACK);
  if (!pack) return [];
  const idx = await pack.getIndex({ fields: ["system.level.value", "system.traits.rarity", "system.traits.value", "system.usage.value", "system.category", "system.group", "system.price.value", "system.quantity"] });
  equipmentCache = [...idx];
  return equipmentCache;
}

/** The system's spells as index entries (rank, traits, rarity, ritual). */
export async function spellIndex() {
  if (spellCache) return spellCache;
  const pack = game.packs.get(SPELL_PACK);
  if (!pack) return [];
  const idx = await pack.getIndex({ fields: ["system.level.value", "system.traits.value", "system.traits.rarity", "system.traits.traditions", "system.ritual"] });
  spellCache = [...idx];
  return spellCache;
}

/** The system's scroll and wand templates (`CONFIG.PF2E.spellcastingItems`): for each kind, rank to { uuid, level }. */
export async function spellTemplates() {
  const out = { scroll: new Map(), wand: new Map() };
  const conf = CONFIG.PF2E?.spellcastingItems ?? {};
  const index = await equipmentIndex();
  for (const kind of ["scroll", "wand"]) {
    for (const [rank, uuid] of Object.entries(conf[kind]?.compendiumUuids ?? {})) {
      if (!uuid) continue;
      const e = index.find((x) => x.uuid === uuid);
      if (e) out[kind].set(Number(rank), { uuid, level: Number(e.system?.level?.value) || 0 });
    }
  }
  return out;
}

/** Item data for a compendium entry, as a world copy that remembers its source (`fromCompendium`). */
export async function itemFromEntry(uuid) {
  const doc = await fromUuid(uuid);
  if (!doc) return null;
  return game.items.fromCompendium(doc, { keepId: false });
}

/** A scroll or wand of a spell at a rank, the way the system makes one: its template, the spell inside it heightened to
 * the rank, the system's name for it, and the spell's traditions among its traits. */
export async function spellItemData(kind, templateUuid, spellUuid, rank) {
  const [template, spell] = await Promise.all([fromUuid(templateUuid), fromUuid(spellUuid)]);
  if (!template || !spell) return null;
  const data = game.items.fromCompendium(template, { keepId: false });
  const sp = spell.toObject();
  sp._id = foundry.utils.randomID();
  sp.system.location = { ...(sp.system.location ?? {}), heightenedLevel: rank };
  // Remember which spell it is, so a shop isn't given the same scroll twice.
  sp._stats = { ...(sp._stats ?? {}), compendiumSource: spell.uuid };
  data.system.spell = sp;
  const tmpl = CONFIG.PF2E?.spellcastingItems?.[kind]?.nameTemplate;
  data.name = tmpl ? game.i18n.format(tmpl, { name: spell.name, level: rank }) : `${template.name}: ${spell.name}`;
  const traditions = [...(spell.system?.traits?.traditions ?? [])];
  data.system.traits.value = [...new Set([...(data.system.traits?.value ?? []), ...traditions])];
  data.system.description.value = `<p>@UUID[${spell.uuid}]{${spell.name}}</p>${data.system.description?.value ?? ""}`;
  return data;
}
