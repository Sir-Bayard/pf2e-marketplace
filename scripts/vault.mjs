import { canTrade, cleanLines } from "./helpers.mjs";
import { buyersFor, fundsCp, hasParts, quantityOf, tradeRows } from "./pf2e.mjs";
import { L, MOD, fmt } from "./constants.mjs";
import { logTrade, marketById } from "./data.mjs";
import { Refused, executeTrade } from "./engine.mjs";
import { tradeCopy } from "./post.mjs";
import { io } from "./trade.mjs";
import { refresh, showsActor } from "./refresh.mjs";

/*
 * Market vaults: each character's own storage at a market, reached only through that market while it's open, with a
 * fee for each deposit if the market sets one. A vault is a loot actor the module makes the first time a character
 * deposits (flag `vault: { market, owner }`), in a folder of its own. No player has any permission on it (every client
 * can still read it, as every actor); every move goes through the GM's client.
 */

const vaultFlag = (actor) => actor?.flags?.[MOD]?.vault ?? null;
/** A character's vault at a market, or null if they have none yet. */
const vaultOf = (marketId, actorId) => game.actors.find((a) => a.type === "loot" && vaultFlag(a)?.market === marketId && vaultFlag(a)?.owner === actorId) ?? null;
/** Every vault at a market (for the GM). */
const vaultsAt = (marketId) => game.actors.filter((a) => a.type === "loot" && vaultFlag(a)?.market === marketId);
/** Is this actor a vault? */
const isVault = (actor) => actor?.type === "loot" && !!vaultFlag(actor);

/** Characters a user can use a vault for: their own characters (never the party stash). */
const vaultUsersFor = (user) => buyersFor(user, game.actors.contents).filter((a) => a.type === "character");

/** The folder vaults are kept in, made on first use (GM). */
async function vaultFolder() {
  const found = game.folders.find((f) => f.type === "Actor" && f.flags?.[MOD]?.vaults);
  if (found) return found.id;
  const made = await Folder.create({ name: L("VaultsFolder"), type: "Actor", flags: { [MOD]: { vaults: true } } });
  return made?.id ?? null;
}

/**
 * Make a character's vault at a market (GM): a loot actor no player owns. Every client reads every actor, so the vault
 * page can show what's in it; any permission at all on a loot actor would let PF2e's own sheet move items in and out
 * past the market's rules.
 */
async function makeVault(market, actor) {
  return Actor.create({
    name: L("VaultName", { name: actor.name, market: market.name }).slice(0, 120),
    type: "loot",
    img: "icons/svg/chest.svg",
    folder: await vaultFolder(),
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
    flags: { [MOD]: { vault: { market: market.id, owner: actor.id } } },
  });
}

/**
 * A vault request (the GM's client): { market, actor, op: "deposit" | "withdraw", items: [{ item, qty }], cp }.
 * Checked first: the market has vaults and is open to the sender, the character is theirs, every item is there in that
 * number (a stack with attached parts goes whole), and the coins and the fee are there. Then it moves, undone if a step
 * fails (engine.mjs).
 */
async function processVault(msg, sender) {
  const market = marketById(String(msg.market ?? ""));
  if (!market?.vaults) throw new Refused("NoVaultsHere");
  if (!canTrade(market, sender.isGM)) throw new Refused("VaultMarketClosed", { market: market?.name ?? "" });
  const actor = game.actors.get(String(msg.actor ?? ""));
  if (!actor || actor.type !== "character" || !buyersFor(sender, [actor]).length) throw new Refused("CantTradeFor");
  const deposit = msg.op === "deposit";
  if (!deposit && msg.op !== "withdraw") throw new Refused("DidntWork");
  const lines = cleanLines((Array.isArray(msg.items) ? msg.items : []).map((l) => ({ shop: "vault", item: l?.item, qty: l?.qty })));
  const cp = Math.max(0, Math.min(100000000, Math.round(Number(msg.cp) || 0)));
  if (!lines.length && !cp) throw new Refused("VaultNothing");
  let vault = vaultOf(market.id, actor.id);
  if (!deposit && !vault) throw new Refused("VaultEmpty", { name: actor.name });
  const from = deposit ? actor : vault;
  const rows = new Map((from ? tradeRows(from) : []).map((r) => [r.id, r]));
  const plan = [];
  for (const l of lines) {
    const r = rows.get(l.item);
    const item = from?.items.get(l.item);
    if (!r || !item || r.why || r.qty < l.qty) throw new Refused(deposit ? "VaultCantDeposit" : "VaultHasntIt", { name: r?.name ?? L("That") });
    if (hasParts(item) && l.qty !== quantityOf(item)) throw new Refused("PartsAllOrNoneNamed", { name: r.name, n: r.qty });
    plan.push({ item, qty: l.qty, name: r.name });
  }
  const fee = deposit ? market.vaultFee : 0;
  if (deposit && fundsCp(actor) < cp + fee) throw new Refused("VaultNotEnough", { name: actor.name, amount: fmt(cp + fee) });
  if (!deposit && fundsCp(vault) < cp) throw new Refused("VaultNotThatMuch", { amount: fmt(fundsCp(vault)) });
  if (deposit && !vault) {
    vault = await makeVault(market, actor);
    if (!vault) throw new Refused("DidntWork");
  }
  const to = deposit ? vault : actor;
  const { unpaid } = await executeTrade({
    trader: actor,
    take: plan,
    // A withdrawal: the vault pays the coins out. A deposit: the character pays the coins and the fee.
    owing: deposit ? [] : [[vault, cp]],
    net: deposit ? cp + fee : -cp,
    deliveries: [{ actor: to, datas: plan.map((p) => tradeCopy(p.item, p.qty)) }],
    receipts: deposit ? [[vault, cp]] : [],
  }, io);
  const note = [fee ? L("VaultFeePaid", { amount: fmt(fee) }) : "", ...unpaid.map(([a, n]) => L("WasntPaid", { name: a.name, amount: fmt(n) }))].filter(Boolean).join("; ");
  logTrade({ kind: deposit ? "deposit" : "withdraw", user: sender.name, actor: actor.name, shop: L("Vault"), market: market.name, items: plan.map((p) => ({ name: p.name, qty: p.qty })), cp, note });
  refresh(showsActor(actor.id));
  refresh(showsActor(vault.id));
  return { say: { key: deposit ? "VaultDeposited" : "VaultWithdrew", data: { name: actor.name, market: market.name } }, unpaid: unpaid.length ? note : "" };
}

export { isVault, processVault, vaultOf, vaultUsersFor, vaultsAt };
