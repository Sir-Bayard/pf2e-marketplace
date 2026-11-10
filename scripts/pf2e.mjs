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
