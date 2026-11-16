import { checkDegree, cleanHaggle, haggleNow, HAGGLE_DEGREES } from "./helpers.mjs";
import { buyersFor, isMerchant } from "./pf2e.mjs";
import { L, MOD, SOCKET, notice } from "./constants.mjs";
import { flagOf, marketOfShop, pricePct, shopLevel, tradeMarketFor } from "./data.mjs";
import { dcFor, dcsOk } from "./rules.mjs";
import { refresh, showsActor } from "./refresh.mjs";

/*
 * Haggling: a character tries Diplomacy once at a shop until its next restock, against the DC for the shop's level
 * (read from the PF2e system). A critical success, success or critical failure changes what that character pays
 * there for buying (the percents are world settings) until the restock; a failure changes nothing. The player rolls
 * on their own client (the roll is theirs, in chat). The GM's lead tab watches chat and records the first haggle roll
 * for that character at that shop: a roll made after it, or another shop's, never counts, so a player can't roll
 * until it comes up well and send only the best.
 */

const OPTION = `${MOD}:haggle`;
const optionFor = (shopId) => `${OPTION}:${shopId}`;
/** The haggle tag in a chat message's check context, or null. */
const haggleTag = (message) => {
  const options = message?.flags?.pf2e?.context?.options;
  return Array.isArray(options) ? options.find((o) => typeof o === "string" && o.startsWith(`${OPTION}:`)) ?? null : null;
};

const haggleOn = () => !!game.settings.get(MOD, "haggling");
/** The DC to haggle at a shop, or null when the system's DCs by level couldn't be read. */
const haggleDC = (shop) => (dcsOk() ? dcFor(shopLevel(shop, marketOfShop(shop.id))) : null);
/** A character's haggle at a shop now ({ rot, degree }), or null if they haven't tried since its last restock. */
const haggleOf = (shop, actor) => (shop && actor ? haggleNow(flagOf(shop, "haggle"), actor.id, flagOf(shop, "rotations")) : null);

/** Haggles rolled on this client and not yet recorded (shop.actor: when), so a second click doesn't roll again. */
const waiting = new Map();
const WAIT = 15000;
const isWaiting = (shop, actor) => Date.now() - (waiting.get(`${shop?.id}.${actor?.id}`) ?? 0) < WAIT;

/**
 * Why a character can't haggle at a shop now (a key for the language file), or null when they can. Checked the same
 * way on the player's client (for the button) and the GM's (when the roll comes in).
 */
function haggleProblem(shop, actor, user) {
  if (!haggleOn()) return "HaggleOff";
  if (!isMerchant(shop)) return "AShopIsGone";
  if (!actor || actor.type !== "character" || !buyersFor(user, [actor]).length) return "HaggleCharactersOnly";
  if (!tradeMarketFor(shop.id, user)) return "ShopNotOpen";
  if (pricePct(shop, actor, user) === null) return "HaggleWontTrade";
  if (haggleDC(shop) === null) return "HaggleNoDC";
  if (haggleOf(shop, actor)) return "HaggledAlready";
  return null;
}

/** The player's side: roll Diplomacy against the shop's DC. The GM's client records it when it reaches chat. */
async function startHaggle(shop, actor) {
  const why = haggleProblem(shop, actor, game.user) ?? (game.users.activeGM ? null : "NeedGM") ?? (isWaiting(shop, actor) ? "HaggleWaiting" : null);
  if (why) return void notice("warn", why, { name: actor?.name ?? "", shop: shop?.name ?? "" });
  const stat = actor.skills?.diplomacy;
  if (!stat?.roll) return void notice("warn", "HaggleNoSkill");
  waiting.set(`${shop.id}.${actor.id}`, Date.now());
  refresh(showsActor(shop.id));
  // Rolled openly, so the GM's client sees the message (a self roll is whispered to the roller only).
  const rolled = await stat.roll({ dc: { value: haggleDC(shop), label: L("HaggleDCLabel", { shop: shop.name }) }, extraRollOptions: [optionFor(shop.id)], rollMode: CONST.DICE_ROLL_MODES.PUBLIC });
  // Canceled in the roll dialog: nothing to wait for.
  if (!rolled) waiting.delete(`${shop.id}.${actor.id}`);
  refresh(showsActor(shop.id));
  // If no answer comes (refused, or no GM tab took it), the button comes back when the wait ends.
  setTimeout(() => refresh(showsActor(shop.id)), WAIT + 100);
}

/**
 * The GM's side (the lead tab, for every new chat message): a Diplomacy check made with a shop's haggle option, by a
 * user who may trade for the character it speaks for, at that shop's DC, with a real roll in it. The first one since
 * the shop's last restock is recorded; later ones are ignored.
 */
async function recordHaggle(chat) {
  const ctx = chat?.flags?.pf2e?.context;
  const tag = haggleTag(chat);
  if (!tag) return;
  const options = ctx.options;
  const shop = game.actors.get(tag.slice(OPTION.length + 1));
  const actor = game.actors.get(String(chat.speaker?.actor ?? ""));
  const user = chat.author;
  if (!shop || !actor || !user) return;
  const tell = (key) => {
    if (user.id === game.user.id) notice("info", key, { name: actor.name, shop: shop.name });
    else game.socket.emit(SOCKET, { type: "notice", users: [user.id], say: { key, data: { name: actor.name, shop: shop.name } } });
  };
  // A Hero Point reroll of this haggle (PF2e posts it as a new message marked check:reroll) replaces it, once.
  const before = haggleOf(shop, actor);
  const reroll = options.includes("check:reroll") && before && !before.rerolled;
  const why = reroll ? (buyersFor(user, [actor]).length ? null : "HaggleCharactersOnly") : haggleProblem(shop, actor, user);
  if (why) return void tell(why);
  const domains = Array.isArray(ctx.domains) ? ctx.domains : [];
  const roll = chat.rolls?.[0];
  // The die that counts: the d20's kept result (none for Assurance, which PF2e builds from a number).
  const d20 = roll?.dice?.find((d) => d.faces === 20);
  const natural = d20 ? (d20.results?.find((r) => r.active && !r.discarded)?.result ?? null) : null;
  const assured = !d20 && Array.isArray(ctx.substitutions) && ctx.substitutions.some((s) => s?.selected);
  const dc = haggleDC(shop);
  // The outcome must follow from the total against the DC (before rules that adjust degrees, which PF2e keeps apart).
  const claimed = ctx.unadjustedOutcome ?? ctx.outcome;
  const ok = ctx.type === "skill-check" && domains.includes("diplomacy") && Number(ctx.dc?.value) === dc
    && HAGGLE_DEGREES.includes(ctx.outcome) && (!!d20 || assured) && Number.isFinite(roll?.total)
    && checkDegree(roll.total, dc, natural) === claimed;
  if (!ok) return void tell("HaggleNotCounted");
  const rot = Number(flagOf(shop, "rotations")) || 0;
  // Only this rotation's haggles are kept: older ones mean nothing once the shop has restocked.
  const kept = Object.fromEntries(Object.entries(cleanHaggle(flagOf(shop, "haggle"))).filter(([, h]) => h.rot === rot));
  kept[actor.id] = reroll ? { rot, degree: ctx.outcome, rerolled: true } : { rot, degree: ctx.outcome };
  const Replace = foundry.data?.operators?.ForcedReplacement;
  await shop.update({ [`flags.${MOD}.haggle`]: Replace ? new Replace(kept) : kept });
  refresh(showsActor(shop.id));
  tell(`Haggle-${ctx.outcome}`);
}

export { haggleDC, haggleOf, haggleOn, haggleProblem, haggleTag, isWaiting, recordHaggle, startHaggle };
