/**
 * PF2e Marketplace: everything that reads or writes the PF2e system's own data lives here, so a system update
 * that breaks something breaks it in one place. Each function says which part of the system it relies on.
 */

/** A PF2e merchant: a loot actor whose sheet type is "Merchant" (`system.lootSheetType`). */
export const isMerchant = (actor) => actor?.type === "loot" && actor.system?.lootSheetType === "Merchant";

/** A loot actor's level (`system.details.level.value`). */
export const actorLevel = (actor) => Number(actor?.system?.details?.level?.value ?? 0) || 0;

/** The item types PF2e counts as physical (things that can sit in an inventory). */
const PHYSICAL = new Set(["weapon", "ammo", "armor", "shield", "consumable", "equipment", "backpack", "kit", "book", "treasure"]);
const isPhysical = (item) => (typeof item?.isOfType === "function" ? item.isOfType("physical") : PHYSICAL.has(item?.type));

/** Coins are treasure items with category "coin" (`isCoinage`); they're the shop's money, not its stock. */
const isCoins = (item) => !!item?.isCoinage || (item?.type === "treasure" && item.system?.category === "coin");

/** An item as a shop sells it: always the real, identified item (shops sell identified goods, Patrick 9 Nov), read
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

/** Take a quantity out of a shop's stock: the item goes when none are left, as PF2e's own sale does. */
export async function takeFromStock(item, qty) {
  const left = quantityOf(item) - qty;
  if (left < 1) await item.delete();
  else await item.update({ "system.quantity": left });
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
 * (unidentified items must be identified first, Patrick 9 Nov; a container must be emptied first).
 */
export function sellRows(actor) {
  const out = [];
  for (const item of actor?.items ?? []) {
    if (!isPhysical(item) || isCoins(item)) continue;
    const { cp, per } = priceOf(item);
    let why = null;
    if (item.isIdentified === false) why = "Identify it first.";
    else if (item.type === "backpack" && (item.contents?.size ?? 0) > 0) why = "Empty it first.";
    else if (!cp) why = "Worth nothing to a shop.";
    const unid = item.isIdentified === false ? item.system?.identification?.unidentified ?? {} : null;
    out.push({ id: item.id, name: unid ? unid.name || "Unidentified item" : item.name, img: unid?.img || item.img, type: item.type, qty: quantityOf(item), cp, per, treasure: isTreasure(item), why });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
}

/** Can this item be sold to a shop now? */
export const canSellToShop = (item) => !!item && isPhysical(item) && !isCoins(item) && item.isIdentified !== false
  && !(item.type === "backpack" && (item.contents?.size ?? 0) > 0) && priceOf(item).cp > 0;

/** The data for an item a shop bought: the quantity sold, out of any container, unequipped, marked as sold to the shop
 * (flag `stock.kind`, for 0.2's rotation). */
export function soldCopy(item, qty, mod) {
  const data = item.toObject();
  delete data._id;
  data.system ??= {};
  data.system.quantity = qty;
  data.system.containerId = null;
  data.system.equipped = { carryType: "worn" };
  data.flags ??= {};
  data.flags[mod] = { ...(data.flags[mod] ?? {}), stock: { kind: "sold", left: 2 } };
  return data;
}

/** Set a loot actor's level (`system.details.level.value`). */
export const setLevel = (actor, level) => actor.update({ "system.details.level.value": Math.round(Number(level) || 0) });

/** A shopkeeper as players know them: the name and picture on their token. */
export function keeperFace(actor, isGM) {
  if (!actor) return null;
  const known = actor.flags?.["pf2e-npc-attitudes"]?.npc?.knownAs;
  const name = isGM ? actor.name : (known || actor.prototypeToken?.name?.trim() || actor.name);
  return { name, img: actor.prototypeToken?.texture?.src || actor.img };
}
