import { AMOUNTS, STOCK_FILTERS, cleanStockLines, drawEntries, drawSpells, drawable, drawnQty, lineCount, parseRange, rarityAllowed, restockDue, restockPlan, scribable, sourceKey } from "./helpers.mjs";
import { equipmentIndex, isMerchant, itemFromEntry, quantityOf, sellable, spellIndex, spellItemData, spellTemplates, stockRows } from "./pf2e.mjs";
import { MOD, listOf, notice } from "./constants.mjs";
import { fillPurse, flagOf, isFormulaItem, mutateMarket, openToPlayers, shopConf, shopLevel, shopsFor, store } from "./data.mjs";
import { tabs } from "./requests.mjs";
import { treasureOk } from "./rules.mjs";
import { queued } from "./trade.mjs";
import { refresh, showsActor } from "./refresh.mjs";

/**
 * Draw a shop's rotating stock from its lines: item data ready to create, marked rotating. Levels lean to the shop's
 * level; nothing the shop already stocks (by compendium source) or already drawn; scrolls and some wands are made
 * from the spell list. Formula lines are skipped while formulas can't be priced (the system's treasure table couldn't
 * be read), with a notice. Returns [{ data, filter, formula }].
 */
async function drawStock(shop, market, lines = shopConf(shop).lines, ignore = new Set()) {
  const maxLevel = Math.max(0, shopLevel(shop, market));
  const index = await equipmentIndex();
  const templates = await spellTemplates();
  const templateIds = new Set([...templates.scroll.values(), ...templates.wand.values()].map((t) => t.uuid));
  // What the shop has: items by compendium source, scrolls and wands by kind and spell (both uuid forms match).
  const seen = new Set();
  for (const i of shop.items) {
    if (ignore.has(i.id)) continue;
    const key = sourceKey(i._stats?.compendiumSource ?? i.flags?.core?.sourceId);
    const spell = i.system?.spell;
    if (spell) seen.add(`${i.system?.category}:${sourceKey(spell._stats?.compendiumSource ?? spell.flags?.core?.sourceId)}`);
    else if (key) seen.add(isFormulaItem(i) ? `formula:${key}` : key);
  }
  const out = [];
  // Formulas are kept apart: a shop can sell a sword and the formula for it.
  const pick = (pool, n, pre = "") => drawEntries(pool.filter((e) => !seen.has(pre + sourceKey(e.uuid))), n, maxLevel);
  const ranges = Object.fromEntries(AMOUNTS.map((a) => [a, game.settings.get(MOD, `amount-${a}`)]));
  const stack = parseRange(game.settings.get(MOD, "stackRange"), [1, 4], 1, 100);
  const spells = async (kind, n, rarity) => {
    const list = (await spellIndex()).filter((e) => scribable(e, rarity) && !seen.has(`${kind}:${sourceKey(e.uuid)}`));
    const ranks = new Map([...templates[kind]].map(([r, t]) => [r, t.level]));
    const picks = drawSpells(list, ranks, n, maxLevel);
    for (const { spell } of picks) seen.add(`${kind}:${sourceKey(spell.uuid)}`);
    return (await Promise.all(picks.map(({ spell, rank }) => spellItemData(kind, templates[kind].get(rank).uuid, spell.uuid, rank)))).filter(Boolean);
  };
  let skipped = 0;
  for (const line of cleanStockLines(lines)) {
    const f = STOCK_FILTERS.find((x) => x.id === line.filter);
    if (f.formula && !treasureOk()) {
      skipped++;
      continue;
    }
    const pool = index.filter((e) => f.test(e) && drawable(e, templateIds) && rarityAllowed(e.system?.traits?.rarity, line.rarity));
    const count = lineCount(line, ranges);
    let datas = [];
    if (line.filter === "scrolls") datas = await spells("scroll", count, line.rarity);
    else if (f.formula) {
      const picks = pick(pool, count, "formula:");
      for (const e of picks) seen.add(`formula:${sourceKey(e.uuid)}`);
      datas = (await Promise.all(picks.map((e) => itemFromEntry(e.uuid)))).filter(Boolean);
    } else {
      // Wands: about half named wands, half magic wands of a spell.
      const made = line.filter === "wands" ? await spells("wand", Math.floor(count / 2), line.rarity) : [];
      const picks = pick(pool, count - made.length);
      for (const e of picks) seen.add(sourceKey(e.uuid));
      datas.push(...(await Promise.all(picks.map((e) => itemFromEntry(e.uuid)))).filter(Boolean));
      datas.push(...made);
    }
    for (const data of datas) {
      // A formula is one copy that never runs out.
      data.system.quantity = f.formula ? 1 : Math.max(1, Number(data.system.quantity) || 1) * drawnQty(data, Math.random, stack);
      // Shops sell identified goods.
      if (data.system.identification) data.system.identification.status = "identified";
      data.flags ??= {};
      data.flags[MOD] = { ...(data.flags[MOD] ?? {}), stock: f.formula ? { kind: "rotating", formula: true } : { kind: "rotating" } };
      out.push({ data, filter: line.filter, formula: !!f.formula });
    }
  }
  if (skipped) notice("warn", "FormulaLinesSkipped", { shop: shop.name, n: skipped });
  return out;
}

/** A shop's stock items for a restock plan. */
const planItems = (shop) => stockRows(shop).map((r) => ({ id: r.id, qty: r.qty, stock: r.stock }));

/**
 * Restock a shop (GM): unmarked items marked as staples, staples back to their number, rotating stock cleared and
 * (with `opts.draw`) drawn again from the shop's lines, sold items counted down (not with `opts.keepSold`), the purse
 * filled. A restock is a rotation; a shop open to players right then is one they've seen. Returns { refilled,
 * cleared, aged, drawn, filled }.
 */
function restockShop(shop, market, opts = {}) {
  // In the trade queue, so a restock never runs in the middle of a trade with this shop.
  return queued(() => restockNow(shop, market, opts));
}

async function restockNow(shop, market, { keepSold = false, draw = true } = {}) {
  await markStaples([shop]);
  const plan = restockPlan(planItems(shop), { keepSold });
  // Drawn first: if the draw fails, nothing has changed yet. What's about to go may be drawn again.
  const removing = new Set(plan.remove);
  const drawn = draw && cleanStockLines(shopConf(shop).lines).length ? await drawStock(shop, market, undefined, removing) : [];
  if (plan.remove.length) await shop.deleteEmbeddedDocuments("Item", plan.remove);
  const updates = [
    ...plan.refill.map((r) => ({ _id: r.id, "system.quantity": r.qty })),
    ...plan.age.map((a) => ({ _id: a.id, [`flags.${MOD}.stock.left`]: a.left })),
  ];
  if (updates.length) await shop.updateEmbeddedDocuments("Item", updates);
  if (drawn.length) await shop.createEmbeddedDocuments("Item", drawn.map((d) => d.data));
  const filled = await fillPurse(shop, market);
  const rotations = (Number(flagOf(shop, "rotations")) || 0) + 1;
  await shop.update({ [`flags.${MOD}.rotations`]: rotations, ...(openToPlayers(shop) ? { [`flags.${MOD}.seenRotation`]: rotations } : {}) });
  refresh(showsActor(shop.id));
  return { refilled: plan.refill.length, cleared: plan.remove.length, aged: plan.age.length, drawn: drawn.length, filled };
}

/** Restock every shop of a market (GM), noting the game time for its schedule. */
async function restockMarket(market, opts) {
  // The clock first: a shop that fails mustn't make the schedule restock the others again on the next tick.
  await mutateMarket(market.id, (m) => {
    m.lastRestock = game.time.worldTime;
  });
  const shops = shopsFor(market).map((s) => game.actors.get(s.id)).filter(isMerchant);
  const failed = [];
  for (const shop of shops) {
    try {
      await restockShop(shop, market, opts);
    } catch (err) {
      console.error(`${MOD} | restocking ${shop.name} failed`, err);
      failed.push(shop.name);
    }
  }
  if (failed.length) notice("error", "CouldntRestockList", { list: listOf(failed) });
  return shops.length - failed.length;
}

/**
 * Give each shop item with no stock mark its staple mark, of what it has now (duplicated or imported merchants, items
 * added while the module was off or that predate stock marks), and identify anything unidentified.
 */
async function markStaples(shops) {
  for (const shop of shops) {
    const updates = [];
    for (const i of shop.items) {
      const u = {};
      if (sellable(i) && !i.flags?.[MOD]?.stock) u[`flags.${MOD}.stock`] = { kind: "staple", qty: quantityOf(i) };
      // Shops sell identified goods.
      if (i.system?.identification?.status && i.system.identification.status !== "identified") u["system.identification.status"] = "identified";
      if (Object.keys(u).length) updates.push({ _id: i.id, ...u });
    }
    if (updates.length) await shop.updateEmbeddedDocuments("Item", updates);
  }
}

let restocking = false;

/** Timed restocks: on the primary GM's lead tab, a market whose interval has passed in game time restocks all its shops
 * once (however much time passed). A market that has never restocked starts its clock at the first check. */
async function checkSchedules() {
  if (restocking || !tabs.isLead()) return;
  restocking = true;
  try {
    const now = game.time.worldTime;
    for (const m of store().markets) {
      if (!(m.restockEvery > 0)) continue;
      // Never restocked, or the clock was turned back: the interval counts from now.
      if (m.lastRestock === null || now < m.lastRestock) await mutateMarket(m.id, (x) => (x.lastRestock = now));
      else if (restockDue(m.restockEvery, m.lastRestock, now)) {
        const n = await restockMarket(m, { draw: true, keepSold: false });
        notice("info", n === 1 ? "MarketRestockedOne" : "MarketRestockedMany", { name: m.name, n });
      }
    }
  } catch (err) {
    console.error(`${MOD} | a timed restock failed`, err);
  } finally {
    restocking = false;
  }
}

export { checkSchedules, drawStock, markStaples, planItems, restockMarket, restockShop };
