import { buyPrice, cleanLines, cleanSales, esc, offerFor, pctFor, planTrade, sellRate, settle, sourceKey } from "./helpers.mjs";
import { addFormulas, boughtCopy, buyersFor, canSellToShop, formulaUuid, fundsCp, giveItems, handPricedParts, hasParts, isMerchant, isTreasure, knowsFormula, parchmentData, pay, priceOf, quantityOf, realItem, receive, restoreFormulas, sellable, soldCopy, takeFromStock } from "./pf2e.mjs";
import { L, Lh, MOD, fmt, listOf, notice } from "./constants.mjs";
import { isFormulaItem, itemPrice, loadCart, logTrade, pricePct, saveCart, serviceOf, shopConf, shopFace, shopInfo, tradeMarketFor } from "./data.mjs";
import { Refused, executeTrade } from "./engine.mjs";
import { refresh, showsActor } from "./refresh.mjs";

/** Trades run one at a time on the GM's client, so two buyers can't both take the last one. */
let tradeQueue = Promise.resolve();
function queued(fn) {
  const run = tradeQueue.then(fn);
  tradeQueue = run.catch(() => null);
  return run;
}

/** What the trade steps use on Foundry and the PF2e system (engine.mjs runs them). */
const io = {
  qty: quantityOf,
  hasParts,
  take: takeFromStock,
  pay,
  receive,
  give: giveItems,
  giveSold,
  known: (actor) => foundry.utils.deepClone(actor._source?.system?.crafting?.formulas ?? []),
  learn: addFormulas,
  unlearn: restoreFormulas,
  error(text, err, actor = null) {
    console.error(`${MOD} | ${text}`, err);
    if (actor) notice("error", "UndoFailed", { name: actor.name }, { permanent: true });
  },
};

/** "Dagger priced by hand at 500 gp (its compendium entry: 2 sp)", or "... has no compendium entry; priced at ...". */
function handPricedNote(name, h) {
  const price = (cp, per) => (per > 1 ? L("PriceFor", { price: fmt(cp), n: per }) : fmt(cp));
  return h.source ? L("HandPriced", { name, price: price(h.cp, h.per), source: price(h.source.cp, h.source.per) }) : L("NoEntryPriced", { name, price: price(h.cp, h.per) });
}

/**
 * Make a trade on the primary GM's client: the trader buys `lines` and sells `sales`. Everything is checked before
 * anything moves: the trader is the sender's, each shop is open to them (and buys from customers, for a sale), each
 * item is there in that quantity, the totals match what the trader saw, and the money is there. Sales settle with
 * purchases, so at each shop only the difference changes hands, and the trader pays (or gets) only the difference.
 */
async function processTrade(msg, sender) {
  const lines = cleanLines(msg.lines);
  const trader = game.actors.get(String(msg.trader ?? ""));
  if (!trader || !buyersFor(sender, [trader]).length) throw new Refused("CantTradeFor");
  const sales = cleanSales(msg.sales).filter((l) => l.actor === trader.id);
  if (!lines.length && !sales.length) throw new Refused("CartEmpty");
  const buys = [];
  for (const l of lines) {
    const shop = game.actors.get(l.shop);
    if (!isMerchant(shop)) throw new Refused("AShopIsGone");
    if (!tradeMarketFor(shop.id, sender)) throw new Refused("NotOpenForTrade", { shop: shop.name });
    const item = shop.items.get(l.item);
    const service = item ? null : serviceOf(shop, l.item);
    if (!service && (!item || !sellable(item))) throw new Refused("NotForSaleFrom", { shop: shop.name });
    const pct = pricePct(shop, trader, sender);
    if (pct === null) throw new Refused("WontTradeWith", { shop: shopFace(shop, sender), name: trader.name });
    if (service) {
      buys.push({ shop: shop.id, shopDoc: shop, qty: l.qty, price: buyPrice(service.cp, 1, l.qty, pct, false, false), name: service.name, cp: service.cp, service: true });
      continue;
    }
    if (isFormulaItem(item)) {
      // A formula is a copy: the shop keeps the item, the trader learns it and gets a parchment.
      const uuid = formulaUuid(item);
      const name = L("FormulaOf", { name: realItem(item).name });
      if (!uuid) throw new Refused("NotForSaleFrom", { shop: shop.name });
      if (trader.type !== "character") throw new Refused("OnlyCharactersLearn");
      if (l.qty !== 1) throw new Refused("OneCopyOf", { name });
      if (knowsFormula(trader, uuid)) throw new Refused("AlreadyKnows", { name: trader.name, item: realItem(item).name });
      if (buys.some((b) => b.uuid === uuid)) throw new Refused("InCartTwice", { name });
      const { cp, per } = itemPrice(item);
      if (cp === null) throw new Refused("FormulaNoPrice");
      buys.push({ shop: shop.id, shopDoc: shop, item, qty: 1, price: buyPrice(cp, per, 1, pct, false, true), name, uuid, formula: true });
      continue;
    }
    if (l.qty > quantityOf(item)) throw new Refused("ShopHasOnly", { shop: shop.name, n: quantityOf(item), name: realItem(item).name });
    if (hasParts(item) && l.qty !== quantityOf(item)) throw new Refused("PartsBuyAll", { name: realItem(item).name, n: quantityOf(item) });
    const { cp, per } = priceOf(item);
    buys.push({ shop: shop.id, shopDoc: shop, item, qty: l.qty, price: buyPrice(cp, per, l.qty, pct, isTreasure(item)), name: realItem(item).name });
  }
  const sold = [];
  for (const l of sales) {
    const shop = game.actors.get(l.shop);
    if (!isMerchant(shop)) throw new Refused("AShopIsGone");
    if (!tradeMarketFor(shop.id, sender)) throw new Refused("NotOpenForTrade", { shop: shop.name });
    const conf = shopConf(shop);
    if (!conf.buys) throw new Refused("DoesntBuy", { shop: shop.name });
    const pct = pricePct(shop, trader, sender);
    if (pct === null) throw new Refused("WontTradeWith", { shop: shopFace(shop, sender), name: trader.name });
    const item = trader.items.get(l.item);
    if (!item) throw new Refused("OfferedGone");
    if (item.isIdentified === false) throw new Refused("IdentifyFirst");
    if (!canSellToShop(item)) throw new Refused("WontBuyAsIs", { shop: shop.name, name: item.name });
    if (l.qty > quantityOf(item)) throw new Refused("HasOnly", { name: trader.name, n: quantityOf(item), item: item.name });
    if (hasParts(item) && l.qty !== quantityOf(item)) throw new Refused("PartsSellAll", { name: item.name, n: quantityOf(item) });
    const { cp, per } = priceOf(item);
    sold.push({ shop: shop.id, shopDoc: shop, conf, item, qty: l.qty, offer: offerFor(cp, per, l.qty, sellRate(conf, isTreasure(item), pctFor(pct, isTreasure(item)))), name: item.name });
  }
  const s = settle(buys, sold);
  if (Number(msg.buy) !== s.buy || Number(msg.sell) !== s.sell) throw new Refused("PricesChanged");
  if (s.net > 0 && fundsCp(trader) < s.net) throw new Refused("NotEnoughFor", { name: trader.name, amount: fmt(s.net) });
  const shopDoc = (id) => buys.find((b) => b.shop === id)?.shopDoc ?? sold.find((x) => x.shop === id)?.shopDoc;
  const plan = planTrade(s, shopInfo(s.shops.keys()));
  for (const id of plan.short) throw new Refused("ShopCantPay", { shop: shopDoc(id).name });
  // A price set by hand on the trader's item (or homebrew with no compendium entry) is flagged for the GM, not refused.
  const notes = new Map();
  for (const x of sold) {
    for (const { part, h } of await handPricedParts(x.item)) {
      notes.set(x.shop, [...(notes.get(x.shop) ?? []), handPricedNote(part ? L("AttachedTo", { part, name: x.name }) : x.name, h)]);
    }
  }

  // The copies are made before anything changes; then the steps run (engine.mjs: a failed step undoes the ones
  // before it).
  const goods = buys.filter((b) => !b.service);
  const { unpaid: missed } = await executeTrade({
    trader,
    take: [...goods.filter((b) => !b.formula), ...sold],
    owing: plan.owing.map(([id, n]) => [shopDoc(id), n]),
    net: s.net,
    deliveries: [
      { actor: trader, datas: goods.map((b) => (b.formula ? parchmentData(realItem(b.item).name, b.uuid) : boughtCopy(b.item, b.qty))) },
      ...sold.map((x) => ({ actor: x.shopDoc, datas: [soldCopy(x.item, x.qty, MOD, x.conf.keepSold)], sold: true })),
    ],
    learn: goods.filter((b) => b.formula).map((b) => b.uuid),
    receipts: plan.receipts.map(([id, n]) => [shopDoc(id), n]),
  }, io);
  const unpaidNote = missed.map(([a, n]) => L("WasntPaid", { name: a.name, amount: fmt(n) })).join("; ");

  // The log keeps purchases and sales apart, one entry each per shop.
  const market = (id) => tradeMarketFor(id, sender)?.name ?? "";
  const entries = [];
  for (const id of new Set([...buys.map((b) => b.shop), ...sold.map((x) => x.shop)])) {
    const b = buys.filter((x) => x.shop === id), x = sold.filter((y) => y.shop === id);
    const shop = shopDoc(id);
    const note = [...(notes.get(id) ?? []), unpaidNote].filter(Boolean).join("; ");
    if (b.length) entries.push({ kind: "buy", user: sender.name, actor: trader.name, shop: shop.name, market: market(id), items: b.map((p) => ({ name: p.name, qty: p.qty })), cp: b.reduce((n, p) => n + p.price, 0), note: x.length ? "" : unpaidNote });
    if (x.length) entries.push({ kind: "sell", user: sender.name, actor: trader.name, shop: shop.name, market: market(id), items: x.map((p) => ({ name: p.name, qty: p.qty })), cp: x.reduce((n, p) => n + p.offer, 0), note });
  }
  logTrade(...entries);
  for (const id of s.shops.keys()) refresh(showsActor(id));
  refresh(showsActor(trader.id));
  const named = (list) => list.map((p) => (p.qty > 1 ? L("NameTimes", { name: p.name, n: p.qty }) : p.name));
  const result = { trader: trader.name, buy: s.buy, sell: s.sell, net: s.net, bought: named(buys), soldNames: named(sold), note: [...notes.values()].flat().join("; "), unpaid: unpaidNote, lines, sales };
  await postReceipt(trader, buys, sold, s).catch((err) => console.warn(`${MOD} | couldn't post the receipt`, err));
  return result;
}

/**
 * The chat receipt (world setting "receipts"): what was bought and sold, at what price, and what changed hands.
 * "whisper" sends it to the trader's owners and the GMs; "public" to everyone; "off" sends none.
 */
async function postReceipt(trader, buys, sold, s) {
  const mode = game.settings.get(MOD, "receipts");
  if (mode === "off") return;
  const line = (name, qty, cp, zero = "Free") => `<li><span>${esc(qty > 1 ? L("NameTimes", { name, n: qty }) : name)}</span> <span class="pmk-receipt-price">${esc(fmt(cp, zero))}</span></li>`;
  const block = (title, rows) => (rows.length ? `<h4>${Lh(title)}</h4><ul>${rows.join("")}</ul>` : "");
  const shops = [...new Set([...buys, ...sold].map((x) => x.shopDoc.name))];
  const total = s.net > 0 ? Lh("ReceiptPaid", { amount: fmt(s.net) }) : s.net < 0 ? Lh("ReceiptGot", { amount: fmt(-s.net) }) : Lh("ReceiptEven");
  const content = `<div class="pmk-receipt"><h3>${Lh("ReceiptTitle", { name: trader.name })}</h3><p class="pmk-receipt-shops">${esc(listOf(shops))}</p>`
    + block("ReceiptBought", buys.map((b) => line(b.name, b.qty, b.price)))
    + block("ReceiptSold", sold.map((x) => line(x.name, x.qty, x.offer, "Nothing")))
    + `<p class="pmk-receipt-total">${total}</p></div>`;
  const data = { content, speaker: ChatMessage.getSpeaker({ actor: trader }), flags: { [MOD]: { receipt: true } } };
  if (mode === "whisper") data.whisper = game.users.filter((u) => u.isGM || trader.testUserPermission(u, "OWNER")).map((u) => u.id);
  await ChatMessage.create(data);
}

/** What a shop bought from a player: stacked only with the same item it bought earlier and still holds for as many
 * restocks, never with its staples or rotating stock (the system's stacking ignores the stock mark). */
async function giveSold(shop, datas) {
  for (const data of datas) {
    const src = sourceKey(data._stats?.compendiumSource ?? data.flags?.core?.sourceId);
    const left = data.flags?.[MOD]?.stock?.left;
    // An item with attached parts keeps a stack of its own, as do the shop's items with parts.
    const same = !hasParts(data) && shop.items.find((i) => {
      const st = i.flags?.[MOD]?.stock;
      return st?.kind === "sold" && st.left === left && !hasParts(i) && i.name === data.name && i.type === data.type
        && sourceKey(i._stats?.compendiumSource ?? i.flags?.core?.sourceId) === src && !i.system?.containerId;
    });
    if (same) await same.update({ "system.quantity": quantityOf(same) + (Number(data.system?.quantity) || 1) });
    else await shop.createEmbeddedDocuments("Item", [data]);
  }
}

/** What the trader is told, and what the GM sees when a player traded (in the reader's language). */
function tradeText(r) {
  const parts = [];
  if (r.bought.length) parts.push(L("TextBought", { list: listOf(r.bought), amount: fmt(r.buy) }));
  if (r.soldNames.length) parts.push(L("TextSold", { list: listOf(r.soldNames), amount: fmt(r.sell, "Nothing") }));
  const both = r.bought.length && r.soldNames.length;
  const money = both ? (r.net > 0 ? L("TextPaying", { amount: fmt(r.net) }) : r.net < 0 ? L("TextGetting", { amount: fmt(-r.net) }) : L("TextEven")) : "";
  return L("TextTrade", { name: r.trader, what: listOf(parts), money });
}

/** The GM's notice for a trade: a warning when a price or a payment needs checking. */
function gmNotice(r, who = "") {
  const text = `${L("Prefix")}${who}${tradeText(r)}`;
  const check = [r.note && L("CheckPrice", { note: r.note }), r.unpaid && L("CheckMoney", { note: r.unpaid })].filter(Boolean).join(" ");
  if (check) ui.notifications.warn(esc(`${text} ${check}`), { permanent: true });
  else ui.notifications.info(esc(text));
}

/** What was traded comes out of the cart (a line raised meanwhile keeps the rest). */
function clearTraded(lines, sales) {
  const cart = loadCart();
  const bought = new Map(cleanLines(lines).map((l) => [`${l.shop}.${l.item}`, l.qty]));
  cart.lines = cart.lines.map((l) => ({ ...l, qty: l.qty - (bought.get(`${l.shop}.${l.item}`) ?? 0) })).filter((l) => l.qty >= 1);
  const sold = new Map(cleanSales(sales).map((l) => [`${l.actor}.${l.item}`, l.qty]));
  cart.sales = cart.sales.map((l) => ({ ...l, qty: l.qty - (sold.get(`${l.actor}.${l.item}`) ?? 0) })).filter((l) => l.qty >= 1);
  saveCart(cart);
  refresh();
}

export { Refused, clearTraded, giveSold, gmNotice, io, processTrade, queued, tradeText };
