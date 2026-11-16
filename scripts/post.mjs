import { MAX_OFFERS, MAX_OFFERS_EACH, canAccept, cleanOffer, cleanOffers, offerNet } from "./helpers.mjs";
import { buyersFor, fundsCp, itemPrint, tradeRows } from "./pf2e.mjs";
import { L, MOD, SOCKET, fmt } from "./constants.mjs";
import { logTrade } from "./data.mjs";
import { Refused, deliver, putBack, takeAll, undeliver } from "./engine.mjs";
import { io } from "./trade.mjs";
import { refresh, showsActor } from "./refresh.mjs";

/** A reason, as { key, data } for the language file: shown in the reader's language. */
const say = (key, data = {}) => ({ key, data });

/* ------------------------------------------------------------------ */
/* The Trade Post: offers between players' characters                 */
/* ------------------------------------------------------------------ */

const offers = () => cleanOffers(game.settings.get(MOD, "offers"));

let offerWrites = Promise.resolve();

/** Change the offers (the GM's client), one write at a time, each on the latest copy. */
function mutateOffers(fn) {
  const run = offerWrites.catch(() => null).then(async () => {
    const list = offers();
    fn(list);
    await game.settings.set(MOD, "offers", cleanOffers(list));
  });
  offerWrites = run.catch(() => null);
  return run;
}

/** Characters a user can trade for at the Trade Post: their characters, never the party stash. */
const tradersFor = (user) => buyersFor(user, game.actors.contents).filter((a) => a.type === "character");

/** A request: an offer that gives nothing and asks for something. */
const isRequest = (o) => !o.give.items.length && !o.give.cp;

/** Characters an offer can be for: any character a player owns. */
const offerTargets = () => game.actors.filter((a) => a.type === "character" && a.hasPlayerOwner);

/** Is every item of an offer's side still there, in that number, and as it was? Null when it is, else "gone" or
 * "changed". `prints`: compare fingerprints (only under the PF2e version the offer was posted under). */
function sideProblem(actor, items, prints = true) {
  const rows = new Map(tradeRows(actor).map((r) => [r.id, r]));
  let changed = false;
  for (const l of items) {
    const r = rows.get(l.item);
    if (!r || r.why || r.qty < l.qty) return "gone";
    // Renamed, identified, used or edited since the offer went up, it isn't what the offer shows (an offer posted
    // before fingerprints has only the name to go by). An item with attached parts is offered as its whole stack.
    if ((l.name && r.name !== l.name) || (r.parts && r.qty !== l.qty) || (prints && l.fp && itemPrint(actor.items.get(l.item)) !== l.fp)) changed = true;
  }
  return changed ? "changed" : null;
}

/** Can this offer be taken by `taker` now? Null when it can, else why not ({ key, data }). */
function offerProblem(offer, taker) {
  const from = game.actors.get(offer.from);
  if (!from) return say("PosterGone");
  const prints = !!offer.sv && offer.sv === game.system.version;
  const give = sideProblem(from, offer.give.items, prints);
  if (give === "gone") return say("NoLongerHasOffered", { name: from.name });
  if (give) return say("OfferedChanged");
  const net = offerNet(offer);
  if (net < 0 && fundsCp(from) < -net) return say("HasntMoneyOffered", { name: from.name });
  if (!taker) return null;
  if (!canAccept(offer, taker.id)) return offer.from === taker.id ? say("YourOwnOffer") : say("ForSomeoneElse");
  const want = sideProblem(taker, offer.want.items, prints);
  if (want === "gone") return say("DoesntHaveAsked", { name: taker.name });
  if (want) return say("AskedChanged");
  if (net > 0 && fundsCp(taker) < net) return say("NotEnoughMoney", { name: taker.name });
  return null;
}

/**
 * Post an offer (the GM's client): the poster's own character, items that are theirs to trade, a target that's a
 * player's character, at most MAX_OFFERS_EACH offers per character and MAX_OFFERS in all.
 */
async function processPost(msg, sender) {
  const o = cleanOffer({ ...msg.offer, id: foundry.utils.randomID(16), user: sender.id, created: Date.now(), sv: game.system.version });
  if (!o) throw new Refused("OfferNeedsSomething");
  const from = game.actors.get(o.from);
  if (!from || !tradersFor(sender).some((a) => a.id === from.id)) throw new Refused("CantPostFor");
  if (o.to && !offerTargets().some((a) => a.id === o.to)) throw new Refused("CantTradeHere");
  const fromRows = new Map(tradeRows(from).map((r) => [r.id, r]));
  for (const l of o.give.items) {
    const r = fromRows.get(l.item);
    if (!r || r.why || r.qty < l.qty) throw new Refused("CantOfferAsIs", { name: from.name, item: r?.name ?? L("That") });
    if (r.parts && l.qty !== r.qty) throw new Refused("PartsOfferAll", { name: r.name, n: r.qty });
    Object.assign(l, { name: r.name, img: r.img, fp: itemPrint(from.items.get(l.item)) });
  }
  if (o.want.items.length) {
    const to = game.actors.get(o.to);
    const toRows = new Map(tradeRows(to).map((r) => [r.id, r]));
    for (const l of o.want.items) {
      const r = toRows.get(l.item);
      if (!r || r.why || r.qty < l.qty) throw new Refused("HasntToTrade", { name: to.name, item: r?.name ?? L("That") });
      if (r.parts && l.qty !== r.qty) throw new Refused("PartsAskAll", { name: r.name, n: r.qty });
      Object.assign(l, { name: r.name, img: r.img, fp: itemPrint(to.items.get(l.item)) });
    }
  }
  if (offers().filter((x) => x.from === from.id).length >= MAX_OFFERS_EACH) throw new Refused("TooManyOffers", { name: from.name, n: MAX_OFFERS_EACH });
  if (offers().length >= MAX_OFFERS) throw new Refused("PostFull");
  const problem = offerProblem(o, null);
  if (problem) throw new Refused(problem.key, problem.data);
  await mutateOffers((list) => list.unshift(o));
  return { say: say("OfferUp", { name: from.name }), posted: true };
}

/** Take an offer down: the poster, or a GM. */
async function processWithdraw(msg, sender) {
  const o = offers().find((x) => x.id === msg.id);
  if (!o) throw new Refused("OfferAlreadyGone");
  if (!sender.isGM && !tradersFor(sender).some((a) => a.id === o.from)) throw new Refused("NotYourOffer");
  await mutateOffers((list) => {
    const i = list.findIndex((x) => x.id === o.id);
    if (i >= 0) list.splice(i, 1);
  });
  return { say: say("OfferDown") };
}

/**
 * An item's data as it moves between characters: the quantity, out of any container, carried (carry type "worn", not
 * in a slot), the module's marks dropped. Identification stays as it was.
 */
function tradeCopy(item, qty) {
  const data = item.toObject();
  delete data._id;
  data.system ??= {};
  data.system.quantity = qty;
  data.system.containerId = null;
  const worn = item.system?.usage?.type === "worn" && item.system?.usage?.where;
  data.system.equipped = worn ? { carryType: "worn", inSlot: false } : { carryType: "worn" };
  if (data.flags?.[MOD]) delete data.flags[MOD];
  return data;
}

/** Take an offer (the GM's client): everything checked again, then both sides' items out, the money settled (only the
 * difference moves), the items in, the offer down. A step that fails undoes the ones before it. */
async function processAccept(msg, sender) {
  const o = offers().find((x) => x.id === msg.id);
  if (!o) throw new Refused("OfferGone");
  const taker = game.actors.get(String(msg.actor ?? ""));
  if (!taker || !tradersFor(sender).some((a) => a.id === taker.id)) throw new Refused("CantTradeFor");
  const from = game.actors.get(o.from);
  const problem = offerProblem(o, taker);
  if (problem) throw new Refused(problem.key, problem.data);
  const plan = [
    ...o.give.items.map((l) => ({ item: from.items.get(l.item), qty: l.qty, to: taker })),
    ...o.want.items.map((l) => ({ item: taker.items.get(l.item), qty: l.qty, to: from })),
  ];
  const copies = plan.map((p) => ({ to: p.to, data: tradeCopy(p.item, p.qty) }));
  const net = offerNet(o);
  const taken = await takeAll(plan, io, "InventoryChanged");
  const delivered = [];
  let paid = null;
  const undo = async () => {
    for (const d of delivered.reverse()) await undeliver(d, io);
    if (paid) await Promise.resolve(io.receive(paid[0], paid[1])).catch((e) => console.error(`${MOD} | couldn't give ${paid[0].name} back ${paid[1]} cp`, e));
    await putBack(taken, io);
  };
  const [payer, payee, amount] = net > 0 ? [taker, from, net] : [from, taker, -net];
  if (amount > 0) {
    if (!(await Promise.resolve(io.pay(payer, amount)).catch(() => false))) {
      await undo();
      throw new Refused("NotEnoughMoney", { name: payer.name });
    }
    paid = [payer, amount];
  }
  try {
    for (const side of [taker, from]) {
      const datas = copies.filter((c) => c.to === side).map((c) => c.data);
      if (datas.length) delivered.push(await deliver(side, datas, io));
    }
  } catch (err) {
    await undo();
    throw err;
  }
  let unpaid = "";
  if (amount > 0) await Promise.resolve(io.receive(payee, amount)).catch((err) => {
    console.error(`${MOD} | ${payee.name} wasn't paid ${amount} cp`, err);
    unpaid = L("WasntPaid", { name: payee.name, amount: fmt(amount) });
  });
  refresh(showsActor(taker.id));
  refresh(showsActor(from.id));
  // The trade stands now: log it before anything else can fail.
  logTrade({ kind: "trade", user: game.users.get(o.user)?.name ?? "", actor: from.name, shop: taker.name, market: L("TradePost"), items: o.give.items.map((l) => ({ name: l.name, qty: l.qty })), got: o.want.items.map((l) => ({ name: l.name, qty: l.qty })), net, cp: Math.abs(net), note: unpaid });
  try {
    await mutateOffers((list) => {
      const i = list.findIndex((x) => x.id === o.id);
      if (i >= 0) list.splice(i, 1);
    });
  } catch (err) {
    console.error(`${MOD} | the taken offer couldn't be taken down`, err);
  }
  const done = say(isRequest(o) ? "FilledRequest" : "TookOffer", { taker: taker.name, from: from.name });
  if (o.user && o.user !== sender.id) game.socket.emit(SOCKET, { type: "notice", users: [o.user], say: done });
  return { say: done, unpaid };
}

export { isRequest, mutateOffers, offerProblem, offerTargets, offers, processAccept, processPost, processWithdraw, say, sideProblem, tradeCopy, tradersFor };
