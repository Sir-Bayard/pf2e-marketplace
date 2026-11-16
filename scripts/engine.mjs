/**
 * PF2e Marketplace: the steps of a trade and how a failed one is undone. Nothing here needs Foundry or the system:
 * the actors and items are only asked for what any document has (parent, toObject, items.get, update, create and
 * delete), and the money, stock and deliveries come in `io`, so the node tests can run a trade on fake actors and
 * make each step fail in turn.
 *
 * io: {
 *   qty(item), hasParts(item),
 *   take(item, qty)            takes a quantity out (throws when it can't),
 *   pay(actor, cp) -> bool     false when the actor hasn't enough,
 *   receive(actor, cp),
 *   give(actor, datas)         puts items on an actor (the shop's own rule for what it bought comes as `giveSold`),
 *   known(actor) -> before, learn(actor, uuids), unlearn(actor, before)   formulas,
 *   error(text, err)           a problem the GM must look at (an undo that failed),
 * }
 */

/** A trade that can't go ahead: `key` names the reason in the language file, `data` fills it in. */
class Refused extends Error {
  constructor(key, data = {}) {
    super(key);
    this.key = key;
    this.data = data;
  }
}

const clone = (v) => (typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

/** Take each planned quantity out of its actor, checking the live quantity first. Returns what was taken (to put
 * back); on any failure puts back what it took and throws. */
async function takeAll(plan, io, changed = "Changed") {
  const taken = [];
  try {
    for (const p of plan) {
      if (!p.item.parent || io.qty(p.item) < p.qty || (io.hasParts(p.item) && io.qty(p.item) !== p.qty)) throw new Refused(changed);
      // Who held it, read before it's taken: a stack taken whole is deleted.
      const actor = p.item.parent;
      const snap = p.item.toObject();
      await io.take(p.item, p.qty);
      taken.push({ actor, snap, qty: p.qty });
    }
  } catch (err) {
    await putBack(taken, io);
    throw err;
  }
  return taken;
}

/** Put taken quantities back where they came from (stacked with what's left, or as the item again). */
async function putBack(taken, io) {
  for (const t of [...taken].reverse()) {
    const data = clone(t.snap);
    data.system ??= {};
    data.system.quantity = t.qty;
    const left = t.actor.items.get(data._id);
    try {
      // What's left of the stack takes it back; a stack taken whole comes back with its own id, so carts still find it.
      if (left) await left.update({ "system.quantity": io.qty(left) + t.qty });
      else await t.actor.createEmbeddedDocuments("Item", [data], { keepId: true });
    } catch (err) {
      io.error(`couldn't put ${t.qty} ${data.name} back on ${t.actor.name}`, err);
    }
  }
}

/** Give an actor items, remembering what was there before, so it can be undone. */
async function deliver(actor, datas, io, give = io.give) {
  const before = new Map(actor.items.map((i) => [i.id, io.qty(i)]));
  const record = { actor, before };
  try {
    await give(actor, datas);
  } catch (err) {
    // Part of it may have landed.
    await undeliver(record, io);
    throw err;
  }
  return record;
}

/** Undo a delivery: items it made are deleted, stacks it added to go back to what they were. */
async function undeliver({ actor, before }, io) {
  try {
    const made = actor.items.filter((i) => !before.has(i.id)).map((i) => i.id);
    if (made.length) await actor.deleteEmbeddedDocuments("Item", made);
    const grown = actor.items.filter((i) => before.has(i.id) && io.qty(i) > before.get(i.id)).map((i) => ({ _id: i.id, "system.quantity": before.get(i.id) }));
    if (grown.length) await actor.updateEmbeddedDocuments("Item", grown);
  } catch (err) {
    io.error(`couldn't undo items given to ${actor.name}; check its inventory`, err, actor);
  }
}

/**
 * Run a checked trade. Everything that could be refused has been; this only moves things.
 *
 * t: {
 *   trader,
 *   take: [{ item, qty }]          the shops' stock and the trader's goods, taken first (checked again as they go),
 *   owing: [[actor, cp]]           shops that pay in (they bought more than they sold),
 *   net                            what the trader pays (above 0) or gets (below 0),
 *   deliveries: [{ actor, datas, sold }]   items to give; `sold` ones go by the shop's own rule (io.giveSold),
 *   learn: [uuid]                  formulas the trader learns,
 *   receipts: [[actor, cp]]        shops that get money,
 * }
 * Order: take, shops pay, trader pays, deliveries, formulas. A step that fails undoes the ones before it, deliveries
 * included, and throws (a Refused for "not enough money"). After that the trade stands: the money still to go in is
 * paid, and a payment that fails is returned in `unpaid` ([actor, cp]) for the GM rather than undoing the trade.
 */
async function executeTrade(t, io) {
  const taken = await takeAll(t.take, io);
  const paid = [];
  const delivered = [];
  let knew = null;
  const undo = async () => {
    if (knew) await Promise.resolve(io.unlearn(t.trader, knew)).catch((e) => io.error(`couldn't take back the formulas given to ${t.trader.name}`, e));
    for (const d of delivered.reverse()) await undeliver(d, io);
    for (const [actor, n] of paid.reverse()) await Promise.resolve(io.receive(actor, n)).catch((e) => io.error(`couldn't give ${actor.name} back ${n} cp`, e));
    await putBack(taken, io);
  };
  const charge = async (actor, n, refusal) => {
    let ok = false;
    try {
      ok = await io.pay(actor, n);
    } catch {
      ok = false;
    }
    if (!ok) {
      await undo();
      throw refusal;
    }
    paid.push([actor, n]);
  };
  for (const [shop, n] of t.owing ?? []) if (n > 0) await charge(shop, n, new Refused("ShopCantPay", { shop: shop.name }));
  if (t.net > 0) await charge(t.trader, t.net, new Refused("NotEnoughMoney", { name: t.trader.name }));
  try {
    for (const d of t.deliveries ?? []) if (d.datas.length) delivered.push(await deliver(d.actor, d.datas, io, d.sold ? io.giveSold : io.give));
    if (t.learn?.length) {
      knew = io.known(t.trader);
      await io.learn(t.trader, t.learn);
    }
  } catch (err) {
    await undo();
    throw err;
  }
  const unpaid = [];
  const credit = async (actor, n) => {
    if (n <= 0) return;
    try {
      await io.receive(actor, n);
    } catch (err) {
      io.error(`${actor.name} wasn't paid ${n} cp`, err);
      unpaid.push([actor, n]);
    }
  };
  for (const [shop, n] of t.receipts ?? []) await credit(shop, n);
  if (t.net < 0) await credit(t.trader, -t.net);
  return { unpaid };
}

export { Refused, clone, deliver, executeTrade, putBack, takeAll, undeliver };
