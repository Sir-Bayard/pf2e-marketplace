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

/** What players know of an item: an unidentified one shows its unidentified name, picture and description
 * (`system.identification.unidentified`). GMs see the real item. */
export function knownAs(item, isGM) {
  const real = { name: item?.name ?? "", img: item?.img ?? "", description: String(item?.system?.description?.value ?? "") };
  if (isGM || item?.isIdentified !== false) return real;
  const u = item.system?.identification?.unidentified ?? {};
  return { name: u.name || "Unidentified item", img: u.img || real.img, description: String(u.data?.description?.value ?? "") };
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
export function stockRows(actor, isGM) {
  const out = [];
  for (const item of actor?.items ?? []) {
    if (!isPhysical(item) || isCoins(item)) continue;
    const { cp, per } = priceOf(item);
    // Players learn nothing of an unidentified item's level or traits from the shop list.
    const hide = !isGM && item.isIdentified === false;
    const holds = item.type === "backpack" ? (item.contents?.size ?? 0) : 0;
    out.push({
      id: item.id,
      name: knownAs(item, isGM).name,
      img: knownAs(item, isGM).img,
      type: item.type,
      usage: String(item.system?.usage?.value ?? ""),
      level: hide ? 0 : Number(item.level ?? item.system?.level?.value ?? 0) || 0,
      rarity: hide ? "common" : item.rarity ?? item.system?.traits?.rarity ?? "common",
      traits: hide ? [] : [...(item.traits ?? item.system?.traits?.value ?? [])].map(String),
      qty: Math.max(0, Number(item.quantity ?? item.system?.quantity ?? 0) || 0),
      cp,
      per,
      holds,
      inside: !!item.system?.containerId,
      identified: item.isIdentified !== false,
    });
  }
  return out;
}

/** An item's description for showing: the players' text only (PF2e keeps GM notes in a separate field). */
export const descriptionOf = (item, isGM) => knownAs(item, isGM).description;

/** A new, empty PF2e merchant. */
export function merchantData(name, folder, img) {
  return { name, type: "loot", folder: folder ?? null, img: img || undefined, system: { lootSheetType: "Merchant" } };
}
