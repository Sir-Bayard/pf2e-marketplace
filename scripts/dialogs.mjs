import { AMOUNTS, ATTITUDES, LINE_RARITIES, MAX_SERVICES, MAX_STOCK_LINES, SHOP_KINDS, STOCK_FILTERS, tierName, cleanMarket, cleanServices, cleanShop, cleanStock, cleanStockLines, copyShopSettings, esc, lineCount, restockPlan } from "./helpers.mjs";
import { actorLevel, equipmentIndex, isMerchant, priceOf, sellable } from "./pf2e.mjs";
import { tipAttr, labelAttr } from "./kit/safe-text.mjs";
import { DialogV2, L, Lh, MOD, TRACKERS, fmt, notice } from "./constants.mjs";
import { ATTITUDES_MOD, flagOf, formulaMults, shopConf } from "./data.mjs";
import { formulaPrice } from "./rules.mjs";
import { drawStock, planItems } from "./stock.mjs";

const OPTS = { classes: ["pmk-dialog"], rejectClose: false };
const opt = (value, label, sel) => `<option value="${esc(value)}" ${value === sel ? "selected" : ""}>${esc(label)}</option>`;
const filterLabel = (id) => L(`Filter.${id}`);

/** Actor folders for the market editor, nested ones indented. */
function actorFolderOptions(selected) {
  const out = [];
  const walk = (parent, depth) => {
    const kids = game.folders.filter((f) => f.type === "Actor" && (f.folder?.id ?? null) === parent).sort((a, b) => (a.sort - b.sort) || a.name.localeCompare(b.name));
    for (const f of kids) {
      out.push(`<option value="${esc(f.id)}" ${f.id === selected ? "selected" : ""}>${"  ".repeat(depth)}${esc(f.name)}</option>`);
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out.join("");
}

/** GM: draw rotating stock from the shop's lines, look it over, and add it (or draw again). */
async function drawStockDialog(shop, market, openSettings) {
  if (!cleanStockLines(shopConf(shop).lines).length) {
    notice("info", "AddLinesFirst");
    return openSettings?.();
  }
  for (;;) {
    const drawn = await drawStock(shop, market);
    if (!drawn.length) return void notice("warn", "NothingToDraw");
    const rows = drawn.map(({ data, filter, formula }) => {
      const level = Number(data.system.level?.value) || 0;
      // An entry with attached parts is priced as its whole stack, parts once (as the shop will sell it).
      const { cp, per } = formula ? { cp: formulaPrice(level, data.system.traits?.rarity, formulaMults()), per: 1 } : priceOf({ system: data.system });
      const price = cp === null ? L("NoPrice") : per > 1 ? L("PriceFor", { price: fmt(cp), n: per }) : fmt(cp);
      return `<tr><td>${esc(formula ? L("FormulaOf", { name: data.name }) : data.name)}</td><td>${esc(filterLabel(filter))}</td><td class="pmk-r">${level}</td><td class="pmk-r">${formula ? Lh("Copy") : `×${data.system.quantity}`}</td><td class="pmk-r">${esc(price)}</td></tr>`;
    }).join("");
    const choice = await DialogV2().wait({
      ...OPTS,
      window: { title: L("DrawTitle", { shop: shop.name }), icon: "fa-solid fa-dice" },
      position: { width: 560 },
      content: `<table class="pmk-drawn"><thead><tr><th>${Lh("ColItem")}</th><th>${Lh("ColLine")}</th><th class="pmk-r">${Lh("ColLevel")}</th><th class="pmk-r">${Lh("ColQty")}</th><th class="pmk-r">${Lh("ColPrice")}</th></tr></thead><tbody>${rows}</tbody></table>`,
      buttons: [
        { action: "add", label: L("AddAsRotating"), icon: "fa-solid fa-check", default: true },
        { action: "again", label: L("DrawAgain"), icon: "fa-solid fa-dice" },
        { action: "cancel", label: L("Cancel") },
      ],
    });
    if (choice === "again") continue;
    if (choice === "add") await shop.createEmbeddedDocuments("Item", drawn.map((d) => d.data));
    return;
  }
}

/** The confirm dialog for a restock: what will happen, with the two choices. Resolves to the options or null. */
async function restockDialog(title, shops) {
  let staples = 0, rotating = 0, soldGo = 0, soldStay = 0, lines = 0;
  for (const shop of shops) {
    const plan = restockPlan(planItems(shop));
    staples += plan.refill.length;
    for (const id of plan.remove) (cleanStock(flagOf(shop.items.get(id), "stock")).kind === "sold" ? soldGo++ : rotating++);
    soldStay += plan.age.length;
    lines += cleanStockLines(shopConf(shop).lines).reduce((n, l) => n + lineCount(l, Object.fromEntries(AMOUNTS.map((a) => [a, game.settings.get(MOD, `amount-${a}`)])), () => 0.5), 0);
  }
  return DialogV2().wait({
    ...OPTS,
    window: { title, icon: "fa-solid fa-rotate" },
    position: { width: 420 },
    content: `<div class="pmk-form"><p>${Lh("RestockSummary", { staples, rotating, soldGo, soldStay, lines })}</p>
      <label class="pmk-check"><input type="checkbox" name="draw" ${lines ? "checked" : "disabled"}> ${Lh("DrawNewStock")}</label>
      <label class="pmk-check"><input type="checkbox" name="keepSold"> ${Lh("KeepSoldThisTime")}</label></div>`,
    buttons: [
      { action: "ok", label: L("Restock"), icon: "fa-solid fa-rotate", default: true, callback: (event, button) => ({ draw: button.form.elements.draw.checked, keepSold: button.form.elements.keepSold.checked }) },
      { action: "cancel", label: L("Cancel") },
    ],
  });
}

/* ---------------- Shop settings ---------------- */

const filterOptions = (sel) => STOCK_FILTERS.map((f) => opt(f.id, filterLabel(f.id), sel)).join("");
const amountOptions = (sel) => {
  const sizes = AMOUNTS.map((a) => opt(a, `${L(`Amount.${a}`)} (${game.settings.get(MOD, `amount-${a}`)})`, sel));
  const nums = [...new Set([...Array.from({ length: 20 }, (_, i) => i + 1), ...(typeof sel === "number" ? [sel] : [])])].sort((a, b) => a - b)
    .map((n) => `<option value="${n}" ${n === sel ? "selected" : ""}>${n}</option>`);
  return sizes.join("") + nums.join("");
};
const rarityOptions = (sel) => LINE_RARITIES.map((r) => opt(r, L(`LineRarity.${r}`), sel)).join("");
const stockLineHTML = (l = { filter: "weapons", amount: "some", rarity: "common" }) => `<div class="pmk-sline">
  <select name="amount" aria-label="${Lh("LineAmount")}">${amountOptions(l.amount)}</select>
  <select name="filter" aria-label="${Lh("LineFilter")}">${filterOptions(l.filter)}</select>
  <select name="rarity" aria-label="${Lh("LineRarityLabel")}">${rarityOptions(l.rarity)}</select>
  <button type="button" class="pmk-sline-x"${labelAttr(L("RemoveLine"))}><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
</div>`;
const serviceHTML = (s = { id: foundry.utils.randomID(16), name: "", cp: 0, note: "" }) => `<div class="pmk-svc" data-id="${esc(s.id)}">
  <input type="text" name="svc-name" value="${esc(s.name)}" maxlength="80" placeholder="${Lh("ServiceNamePh")}" aria-label="${Lh("ServiceName")}">
  <input type="number" name="svc-gp" value="${s.cp ? s.cp / 100 : ""}" min="0" step="0.01" placeholder="0" aria-label="${Lh("ServicePrice")}">
  <input type="text" name="svc-note" value="${esc(s.note)}" maxlength="200" placeholder="${Lh("ServiceNotePh")}" aria-label="${Lh("ServiceNote")}">
  <button type="button" class="pmk-svc-x"${labelAttr(L("RemoveService"))}><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
</div>`;
const kindOptions = () => `<option value="">${Lh("KindPick")}</option>${Object.keys(SHOP_KINDS).map((k) => opt(k, L(`Kind.${k}`))).join("")}`;

/** Put settings into the shop settings form (a kind's lines, or another shop's settings). */
function fillForm(root, conf, { linesOnly = false } = {}) {
  const list = root.querySelector(".pmk-slines");
  list.innerHTML = conf.lines.map(stockLineHTML).join("");
  if (linesOnly) return;
  const e = root.querySelector("form")?.elements ?? {};
  if (e.buys) e.buys.checked = conf.buys;
  if (e.itemRate) e.itemRate.value = conf.itemRate;
  if (e.treasureRate) e.treasureRate.value = conf.treasureRate;
  if (e.unlimited) e.unlimited.checked = conf.unlimited;
  if (e.keepSold) e.keepSold.value = conf.keepSold;
  root.querySelector(".pmk-svcs").innerHTML = conf.services.map((s) => serviceHTML({ ...s, id: foundry.utils.randomID(16) })).join("");
}

/** The GM's form for a shop's settings: level, buying, purse, shopkeeper and attitude, rotating stock (with a kind of
 * shop to start from, or another shop's settings to copy), services. */
async function shopSettingsDialog(shop, market) {
  const c = shopConf(shop);
  const keeper = c.keeper ? game.actors.get(c.keeper) : null;
  const att = game.modules.get(ATTITUDES_MOD)?.active;
  const npcs = game.actors.filter((a) => a.type === "npc").sort((a, b) => a.name.localeCompare(b.name));
  const others = game.actors.filter((a) => isMerchant(a) && a.id !== shop.id && flagOf(a, "shop")).sort((a, b) => a.name.localeCompare(b.name));
  const data = await DialogV2().wait({
    ...OPTS,
    window: { title: L("SettingsTitle", { shop: shop.name }), icon: "fa-solid fa-sliders" },
    position: { width: 520 },
    content: `<div class="pmk-form">
      <label>${Lh("Level")} <input type="number" name="level" value="${actorLevel(shop)}" min="-1" max="30" step="1"></label>
      <p class="pmk-hint">${Lh(market?.level ? "LevelHintMarket" : "LevelHint", { level: market?.level ?? 0 })}</p>
      ${others.length ? `<label>${Lh("CopyFrom")} <select name="copyFrom"><option value="">${Lh("CopyPick")}</option>${others.map((a) => opt(a.id, a.name)).join("")}</select></label>` : ""}
      <label class="pmk-check"><input type="checkbox" name="buys" ${c.buys ? "checked" : ""}> ${Lh("BuysFromPlayers")}</label>
      <label>${Lh("PaysItems")} <input type="number" name="itemRate" value="${c.itemRate}" min="0" max="1000" step="5"></label>
      <label>${Lh("PaysTreasure")} <input type="number" name="treasureRate" value="${c.treasureRate}" min="0" max="1000" step="5"></label>
      <label class="pmk-check"><input type="checkbox" name="unlimited" ${c.unlimited ? "checked" : ""}> ${Lh("UnlimitedPurse")}</label>
      <label>${Lh("KeepsSold")} <input type="number" name="keepSold" value="${c.keepSold}" min="1" max="9" step="1"></label>
      <label>${Lh("Shopkeeper")} <select name="keeper"><option value="">${Lh("NoShopkeeper")}</option>${npcs.map((a) => opt(a.id, a.name, keeper?.id)).join("")}</select></label>
      <label>${Lh("KeeperAttitude")} <select name="attitude">${ATTITUDES.map((a) => opt(a, L(`Attitude.${a}`), c.attitude)).join("")}</select></label>
      <p class="pmk-hint">${Lh(att ? "AttitudeHintModule" : "AttitudeHint")}</p>
      <div class="pmk-field">${Lh("RotatingStock")}
        <label>${Lh("KindOfShop")} <select name="kind">${kindOptions()}</select></label>
        <div class="pmk-slines">${c.lines.map(stockLineHTML).join("")}</div>
        <button type="button" class="pmk-sline-add"><i class="fa-solid fa-plus" aria-hidden="true"></i> ${Lh("Line")}</button>
      </div>
      <div class="pmk-field">${Lh("Services")}
        <p class="pmk-hint">${Lh("ServicesHint")}</p>
        <div class="pmk-svcs">${c.services.map(serviceHTML).join("")}</div>
        <button type="button" class="pmk-svc-add"><i class="fa-solid fa-plus" aria-hidden="true"></i> ${Lh("AddService")}</button>
      </div>
    </div>`,
    render: (event, dialog) => {
      const root = dialog.element ?? event?.target?.element;
      const list = root?.querySelector(".pmk-slines");
      const svcs = root?.querySelector(".pmk-svcs");
      root?.querySelector(".pmk-sline-add")?.addEventListener("click", () => {
        if (list.children.length < MAX_STOCK_LINES) list.insertAdjacentHTML("beforeend", stockLineHTML());
      });
      list?.addEventListener("click", (ev) => ev.target.closest(".pmk-sline-x")?.closest(".pmk-sline")?.remove());
      root?.querySelector(".pmk-svc-add")?.addEventListener("click", () => {
        if (svcs.children.length < MAX_SERVICES) svcs.insertAdjacentHTML("beforeend", serviceHTML());
      });
      svcs?.addEventListener("click", (ev) => ev.target.closest(".pmk-svc-x")?.closest(".pmk-svc")?.remove());
      root?.querySelector('select[name="kind"]')?.addEventListener("change", (ev) => {
        const lines = SHOP_KINDS[ev.target.value];
        if (lines) fillForm(root, cleanShop({ lines }), { linesOnly: true });
      });
      root?.querySelector('select[name="copyFrom"]')?.addEventListener("change", (ev) => {
        const from = game.actors.get(ev.target.value);
        if (from) fillForm(root, copyShopSettings(shopConf(from), c));
      });
    },
    buttons: [
      { action: "ok", label: L("Save"), icon: "fa-solid fa-check", default: true, callback: (event, button) => {
        const e = button.form.elements;
        const f = button.form;
        return { level: Number(e.level.value) || 0, buys: e.buys.checked, itemRate: Number(e.itemRate.value), treasureRate: Number(e.treasureRate.value), unlimited: e.unlimited.checked, keepSold: Number(e.keepSold.value), attitude: e.attitude.value, keeper: e.keeper.value || null,
          lines: [...f.querySelectorAll(".pmk-sline")].map((row) => {
            const a = row.querySelector('[name="amount"]').value;
            return { amount: AMOUNTS.includes(a) ? a : Number(a), filter: row.querySelector('[name="filter"]').value, rarity: row.querySelector('[name="rarity"]').value };
          }),
          services: [...f.querySelectorAll(".pmk-svc")].map((row) => ({ id: row.dataset.id, name: row.querySelector('[name="svc-name"]').value.trim(), cp: Math.round((Number(row.querySelector('[name="svc-gp"]').value) || 0) * 100), note: row.querySelector('[name="svc-note"]').value.trim() })) };
      } },
      { action: "cancel", label: L("Cancel") },
    ],
  });
  if (!data || typeof data !== "object") return;
  const conf = cleanShop({ ...c, ...data, services: cleanServices(data.services) });
  await shop.update({ [`flags.${MOD}.shop`]: conf, "system.details.level.value": Math.max(-1, Math.min(30, Math.round(data.level))) });
}

/** GM: a new shop's name and kind. Resolves to { name, kind } or null. */
async function newShopDialog() {
  const r = await DialogV2().prompt({
    ...OPTS,
    window: { title: L("NewShop"), icon: "fa-solid fa-shop" },
    content: `<div class="pmk-form"><label>${Lh("Name")} <input type="text" name="name" placeholder="${Lh("NewShopPh")}" autofocus></label>
      <label>${Lh("KindOfShop")} <select name="kind">${kindOptions()}</select></label>
      <p class="pmk-hint">${Lh("NewShopHint")}</p></div>`,
    ok: { label: L("MakeIt"), icon: "fa-solid fa-check", callback: (event, button) => ({ name: button.form.elements.name.value.trim(), kind: button.form.elements.kind.value }) },
  });
  return r?.name ? r : null;
}

/* ---------------- Markets ---------------- */

/** PF2e Campaign Trackers' reputation trackers, when that module is on: [{ id, name, tiers }]. */
function reputationTrackers() {
  if (!game.modules.get(TRACKERS)?.active) return [];
  try {
    return (game.modules.get(TRACKERS).api?.list?.() ?? []).filter((t) => t?.kind === "reputation" && Array.isArray(t.tiers) && t.tiers.length);
  } catch {
    return [];
  }
}

/** The GM's form for a market. Resolves to the fields, or null when canceled. */
async function marketDialog(market) {
  const m = market ?? { name: "", img: "", description: "", level: null, folder: "_new", pricePct: 0, priceWhy: "", reputation: null, repPcts: {}, vaults: false, vaultFee: 0 };
  const editor = foundry.applications.elements.HTMLProseMirrorElement.create({ name: "description", value: m.description ?? "", toggled: false, height: 180 });
  const reps = reputationTrackers();
  const tierRows = (t) => `<div class="pmk-tiers" data-tracker="${esc(t.id)}" ${t.id === m.reputation ? "" : "hidden"}>${[...t.tiers].filter((x) => typeof x?.id === "string" && /^[\w-]{1,64}$/.test(x.id)).sort((a, b) => (Number(a.min) || 0) - (Number(b.min) || 0)).map((tier) => `<label>${esc(tierName(tier))} <input type="number" name="rep-${esc(t.id)}-${esc(tier.id)}" value="${t.id === m.reputation ? (m.repPcts?.[tier.id] ?? "") : ""}" min="-90" max="200" step="5" placeholder="0"></label>`).join("")}</div>`;
  const repField = reps.length ? `<div class="pmk-field">${Lh("Reputation")}
      <label>${Lh("ReputationTracker")} <select name="reputation"><option value="">${Lh("NoReputation")}</option>${reps.map((t) => opt(t.id, t.name, m.reputation)).join("")}</select></label>
      <p class="pmk-hint">${Lh("ReputationHint")}</p>${reps.map(tierRows).join("")}</div>`
    : game.modules.get(TRACKERS)?.active ? `<p class="pmk-hint">${Lh("ReputationNone")}</p>` : "";
  const data = await DialogV2().wait({
    ...OPTS,
    window: { title: L(market ? "EditMarket" : "NewMarket"), icon: "fa-solid fa-landmark" },
    position: { width: 580 },
    content: `<div class="pmk-form">
      <label>${Lh("Name")} <input type="text" name="name" value="${esc(m.name)}" placeholder="${Lh("MarketNamePh")}" autofocus></label>
      <label>${Lh("Picture")} <span class="pmk-pick"><input type="text" name="img" value="${esc(m.img)}" placeholder="${Lh("PicturePh")}"><button type="button" class="pmk-browse"${labelAttr(L("Browse"))}><i class="fa-solid fa-file-image" aria-hidden="true"></i></button></span></label>
      <label>${Lh("Level")} <input type="number" name="level" value="${m.level ?? ""}" min="-1" max="30" step="1" placeholder="${Lh("None")}"></label>
      <label>${Lh("RestockEvery")} <input type="number" name="restockEvery" value="${m.restockEvery || ""}" min="0" max="365" step="1" placeholder="${Lh("Never")}"></label>
      <label>${Lh("MerchantFolder")} <select name="folder">
        <option value="">${Lh("FolderNone")}</option>
        <option value="_new" ${m.folder === "_new" ? "selected" : ""}>${Lh("FolderNew")}</option>
        ${actorFolderOptions(m.folder)}
      </select></label>
      <p class="pmk-hint">${Lh("FolderHint")}</p>
      <div class="pmk-field">${Lh("MarketPrices")}
        <label>${Lh("MarketPct")} <input type="number" name="pricePct" value="${m.pricePct || ""}" min="-90" max="200" step="5" placeholder="0"></label>
        <label>${Lh("MarketWhy")} <input type="text" name="priceWhy" value="${esc(m.priceWhy ?? "")}" maxlength="120" placeholder="${Lh("MarketWhyPh")}"></label>
        <p class="pmk-hint">${Lh("MarketPctHint")}</p>
      </div>
      ${repField}
      <div class="pmk-field">${Lh("Vaults")}
        <label class="pmk-check"><input type="checkbox" name="vaults" ${m.vaults ? "checked" : ""}> ${Lh("VaultsOn")}</label>
        <label>${Lh("VaultFee")} <input type="number" name="vaultFee" value="${m.vaultFee ? m.vaultFee / 100 : ""}" min="0" step="0.01" placeholder="0"></label>
        <p class="pmk-hint">${Lh("VaultsHint")}</p>
      </div>
      <div class="pmk-field">${Lh("Description")} ${editor.outerHTML}</div>
    </div>`,
    render: (event, dialog) => {
      const root = dialog.element ?? event?.target?.element;
      root?.querySelector(".pmk-browse")?.addEventListener("click", () => {
        const input = root.querySelector('input[name="img"]');
        const FP = foundry.applications.apps.FilePicker.implementation;
        new FP({ type: "image", current: input.value, callback: (path) => (input.value = path) }).render({ force: true });
      });
      root?.querySelector('select[name="reputation"]')?.addEventListener("change", (ev) => {
        for (const g of root.querySelectorAll(".pmk-tiers")) g.hidden = g.dataset.tracker !== ev.target.value;
      });
    },
    buttons: [
      { action: "ok", label: L(market ? "Save" : "MakeIt"), icon: "fa-solid fa-check", default: true, callback: (event, button) => {
        const e = button.form.elements;
        const level = e.level.value === "" ? null : Number(e.level.value);
        const rep = e.reputation?.value || null;
        const repPcts = {};
        if (rep) for (const input of button.form.querySelectorAll(`.pmk-tiers[data-tracker="${CSS.escape(rep)}"] input`)) {
          if (input.value !== "") repPcts[input.name.slice(`rep-${rep}-`.length)] = Number(input.value);
        }
        return { name: e.name.value.trim().slice(0, 120) || L("Market"), img: e.img.value.trim(), level, folder: e.folder.value || null, description: e.description.value ?? "", restockEvery: Number(e.restockEvery.value) || 0,
          pricePct: Number(e.pricePct.value) || 0, priceWhy: e.priceWhy.value.trim(), reputation: rep, repPcts, vaults: e.vaults.checked, vaultFee: Math.round((Number(e.vaultFee.value) || 0) * 100) };
      } },
      { action: "cancel", label: L("Cancel") },
    ],
  });
  if (!data || typeof data !== "object") return null;
  const checked = cleanMarket({ id: "x", ...data, folder: data.folder === "_new" ? null : data.folder });
  return { ...checked, folder: data.folder === "_new" ? "_new" : checked.folder };
}

/* ---------------- Small prompts ---------------- */

/** GM: a formula's price in gp ("" for the price for its level), or null when canceled. */
function formulaPriceDialog(name, current, auto) {
  return DialogV2().prompt({
    ...OPTS,
    window: { title: L("FormulaOf", { name }), icon: "fa-solid fa-scroll" },
    position: { width: 340 },
    content: `<div class="pmk-form"><label>${Lh("PriceInGp")} <input type="number" name="gp" value="${current != null ? current / 100 : ""}" placeholder="${auto === null ? "" : auto / 100}" min="0" step="0.01" autofocus></label>
      <p class="pmk-hint">${auto === null ? Lh("FormulaBlankNone") : Lh("FormulaBlank", { price: fmt(auto) })}</p></div>`,
    ok: { label: L("Save"), icon: "fa-solid fa-check", callback: (event, button) => button.form.elements.gp.value },
  });
}

/** GM: what a staple restocks to, or null when canceled. */
async function stapleQtyDialog(name, qty) {
  const n = await DialogV2().prompt({
    ...OPTS,
    window: { title: L("RestocksTo", { name }), icon: "fa-solid fa-boxes-stacked" },
    position: { width: 320 },
    content: `<div class="pmk-form"><label>${Lh("Number")} <input type="number" name="qty" value="${qty}" min="0" max="9999" step="1" autofocus></label></div>`,
    ok: { label: L("Save"), icon: "fa-solid fa-check", callback: (event, button) => Number(button.form.elements.qty.value) },
  });
  return Number.isFinite(n) ? n : null;
}

/**
 * GM: find an item in the system's equipment compendium by name and pick how many: the keyboard way to stock a shop
 * (the other is dragging an item onto it). Resolves to { uuid, qty } or null.
 */
async function addItemDialog() {
  const index = (await equipmentIndex()).filter((e) => sellable({ type: e.type, system: e.system }));
  let picked = null;
  const list = (q) => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return `<p class="pmk-hint">${Lh("AddItemType")}</p>`;
    const hits = index.filter((e) => words.every((w) => e.name.toLowerCase().includes(w))).slice(0, 40);
    if (!hits.length) return `<p class="pmk-none">${Lh("NothingMatches", { q })}</p>`;
    return `<div class="pmk-picklist" role="listbox" aria-label="${Lh("AddItemResults")}">${hits.map((e) => `<button type="button" class="pmk-pick-item" role="option" aria-selected="false" data-uuid="${esc(e.uuid)}"><img src="${esc(e.img)}" alt=""> <span>${esc(e.name)}</span> <span class="pmk-dim">${Lh("LevelN", { n: Number(e.system?.level?.value) || 0 })}</span></button>`).join("")}</div>`;
  };
  const r = await DialogV2().wait({
    ...OPTS,
    window: { title: L("AddItem"), icon: "fa-solid fa-box-open" },
    position: { width: 460 },
    content: `<div class="pmk-form"><label>${Lh("Search")} <input type="search" name="q" autocomplete="off" autofocus></label>
      <div class="pmk-picks">${list("")}</div>
      <label>${Lh("Quantity")} <input type="number" name="qty" value="1" min="1" max="9999" step="1"></label></div>`,
    render: (event, dialog) => {
      const root = dialog.element ?? event?.target?.element;
      const box = root?.querySelector(".pmk-picks");
      let timer = null;
      root?.querySelector('input[name="q"]')?.addEventListener("input", (ev) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          picked = null;
          box.innerHTML = list(ev.target.value);
        }, 150);
      });
      box?.addEventListener("click", (ev) => {
        const b = ev.target.closest(".pmk-pick-item");
        if (!b) return;
        picked = b.dataset.uuid;
        for (const x of box.querySelectorAll(".pmk-pick-item")) x.setAttribute("aria-selected", String(x === b));
      });
    },
    buttons: [
      { action: "ok", label: L("AddToShop"), icon: "fa-solid fa-check", default: true, callback: (event, button) => (picked ? { uuid: picked, qty: Math.max(1, Math.min(9999, Math.round(Number(button.form.elements.qty.value) || 1))) } : "none") },
      { action: "cancel", label: L("Cancel") },
    ],
  });
  if (r === "none") notice("info", "AddItemPickOne");
  return r && typeof r === "object" ? r : null;
}

/** GM: pick a merchant to add to a market by hand (the keyboard way; the other is dragging one onto the market).
 * Resolves to the actor id or null. */
async function addMerchantDialog(exclude) {
  const list = game.actors.filter((a) => isMerchant(a) && !exclude.has(a.id)).sort((a, b) => a.name.localeCompare(b.name));
  if (!list.length) return void notice("info", "NoMerchantsToAdd");
  return DialogV2().prompt({
    ...OPTS,
    window: { title: L("AddMerchant"), icon: "fa-solid fa-shop" },
    content: `<div class="pmk-form"><label>${Lh("Merchant")} <select name="id" autofocus>${list.map((a) => opt(a.id, a.name)).join("")}</select></label></div>`,
    ok: { label: L("Add"), icon: "fa-solid fa-check", callback: (event, button) => button.form.elements.id.value },
  });
}

/** A yes or no question. */
function confirmDialog(title, html, yes = null, no = null) {
  return DialogV2().confirm({ ...OPTS, window: { title }, content: html, ...(yes ? { yes } : {}), ...(no ? { no } : {}) });
}

export { actorFolderOptions, addItemDialog, addMerchantDialog, confirmDialog, drawStockDialog, formulaPriceDialog, marketDialog, newShopDialog, reputationTrackers, restockDialog, shopSettingsDialog, stapleQtyDialog, tipAttr };
