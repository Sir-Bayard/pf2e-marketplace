import { ATTITUDES, buyPrice, cleanStock, esc, groupStock, offerFor, pctFor, sellRate } from "./helpers.mjs";
import { actorLevel, descriptionOf, fundsCp, keeperFace, knowsFormula, sellRows, stockRows } from "./pf2e.mjs";
import { labelAttr, tipAttr } from "./kit/safe-text.mjs";
import { L, Lh, TextEditor, fmt } from "./constants.mjs";
import { attitudeFor, attitudeInfo, buyerChoices, canPay, fullPurse, loadCart, priceMarket, priceParts, remembered, salesOf, shopConf, shopFace, shopLevel, shopRow, shopRows, shopsFor, tradeMarketFor, tradeState } from "./data.mjs";
import { haggleDC, haggleOf, haggleOn, haggleProblem, isWaiting } from "./haggle.mjs";
import { treasureOk } from "./rules.mjs";

/* The market and shop pages of the window. Each function takes the window (`app`: its view state and its own
 * helpers) and returns HTML. Every control is a button (the keyboard pattern); icon-only ones carry labelAttr. */

const RARITY = ["uncommon", "rare", "unique"];
const icon = (cls) => `<i class="fa-solid ${cls}" aria-hidden="true"></i>`;
/** A button that looks like a link or a card (the window's own look, not Foundry's button). */
const btn = (cls, attrs, inner) => `<button type="button" class="pmk-a ${cls}" ${attrs}>${inner}</button>`;
const pctText = (pct) => (pct < 0 ? L("PctOff", { n: -pct }) : L("PctMore", { n: pct }));

/** A line saying what players can do here: for a market, or for a shop in it (its own switches count too). */
function statusChip(app, market, shop = null) {
  const own = shop ? shopRow(shop) : null;
  let key, good = false;
  if (app.isGM) {
    if (!market.visible) key = shop ? "StatusHiddenMarket" : "StatusHidden";
    else if (own?.hidden) key = "StatusHidden";
    else if (!market.open) key = shop ? "StatusBrowseMarket" : "StatusBrowse";
    else if (own?.closed) key = "StatusBrowse";
    else [key, good] = ["StatusOpen", true];
  } else {
    good = shop ? !!tradeMarketFor(shop.id, game.user) : market.open;
    key = good ? "StatusOpen" : "StatusBrowse";
  }
  return `<span class="pmk-chip pmk-statuschip ${good ? "pmk-good" : ""}">${icon(good ? "fa-store" : "fa-store-slash")} ${Lh(key)}</span>`;
}

/** The market's own price change, as a line for everyone (it's public: a festival, a siege). */
function marketPriceLine(market) {
  if (!market.pricePct) return "";
  const text = market.priceWhy ? L("MarketPriceWhy", { pct: pctText(market.pricePct), why: market.priceWhy }) : L("MarketPrice", { pct: pctText(market.pricePct) });
  return `<p class="pmk-status ${market.pricePct < 0 ? "pmk-good" : ""}">${icon("fa-scale-balanced")} ${esc(text)}</p>`;
}

async function marketHTML(app, market, shops) {
  const desc = market.description ? await TextEditor().enrichHTML(market.description, { secrets: app.isGM }) : "";
  const sub = [market.level !== null ? L("LevelN", { n: market.level }) : "", L(shops.length === 1 ? "ShopsOne" : "ShopsMany", { n: shops.length })].filter(Boolean).join(" · ");
  const gmBar = app.isGM ? `<div class="pmk-gmbar">
      <button type="button" class="pmk-tog" data-action="pmkToggle" data-what="visible" aria-pressed="${market.visible}"${tipAttr(L("TipVisible"))}>${icon(market.visible ? "fa-eye" : "fa-eye-slash")} ${Lh("Visible")}</button>
      <button type="button" class="pmk-tog" data-action="pmkToggle" data-what="open" aria-pressed="${market.open}"${tipAttr(L("TipOpen"))}>${icon(market.open ? "fa-store" : "fa-store-slash")} ${Lh("Open")}</button>
      <span class="pmk-gap"></span>
      <button type="button" data-action="pmkRestockAll"${tipAttr(market.restockEvery ? L(market.restockEvery === 1 ? "TipRestockAllOne" : "TipRestockAllMany", { n: market.restockEvery }) : L("TipRestockAll"))}>${icon("fa-rotate")} ${Lh("RestockAll")}</button>
      <button type="button" data-action="pmkNewShop">${icon("fa-plus")} ${Lh("NewShop")}</button>
      <button type="button" data-action="pmkAddMerchant"${tipAttr(L("TipAddMerchant"))}>${icon("fa-shop")} ${Lh("AddMerchant")}</button>
      <button type="button" data-action="pmkEditMarket">${icon("fa-pen")} ${Lh("Edit")}</button>
      <button type="button" data-action="pmkDeleteMarket"${labelAttr(L("TipDeleteMarket"))}>${icon("fa-trash")}</button>
    </div>` : "";
  const folder = market.folder ? game.folders.get(market.folder) : null;
  const cards = shops.map((s) => {
    const actor = game.actors.get(s.id);
    // As the shop page shows it: a browse-only shop players haven't seen since its last restock counts its staples.
    const staplesOnly = !app.isGM && !tradeMarketFor(s.id, game.user) && !remembered(actor);
    const count = stockRows(actor).filter((r) => !staplesOnly || cleanStock(r.stock, r.qty).kind === "staple").length;
    const marks = [
      app.isGM && s.hidden ? `<i class="fa-solid fa-eye-slash" role="img" aria-label="${Lh("StatusHidden")}"${tipAttr(L("StatusHidden"))}></i>` : "",
      s.closed && (app.isGM || market.open) ? `<i class="fa-solid fa-store-slash" role="img" aria-label="${Lh(app.isGM ? "TipClosedGM" : "StatusBrowse")}"${tipAttr(L(app.isGM ? "TipClosedGM" : "StatusBrowse"))}></i>` : "",
      btn("pmk-x pmk-linkbtn", `data-action="pmkCopyLink" data-kind="Shop" data-id="${esc(s.id)}"${labelAttr(L("CopyLink"))}`, icon("fa-link")),
      app.isGM && s.byHand ? btn("pmk-x", `data-action="pmkRemoveShop" data-id="${esc(s.id)}"${labelAttr(L("TipRemoveShop"))}`, icon("fa-xmark")) : "",
    ].join("");
    return `<div class="pmk-shopcard" draggable="true" data-drag-shop="${esc(s.id)}" data-name="${esc(s.name)}">
      ${btn(`pmk-shop ${s.closed ? "pmk-closed" : ""}`, `data-action="pmkShop" data-id="${esc(s.id)}"`, `<img src="${esc(actor?.img ?? "")}" alt="">
        <span class="pmk-shopn">${esc(s.name)}</span>
        <span class="pmk-shops">${esc([L(count === 1 ? "ItemsOne" : "ItemsMany", { n: count }), actorLevel(actor) ? L("LevelN", { n: actorLevel(actor) }) : ""].filter(Boolean).join(" · "))}</span>`)}
      <span class="pmk-shopm">${marks}</span>
    </div>`;
  }).join("");
  const none = app.isGM ? `<p class="pmk-none">${folder ? Lh("NoShopsFolder", { folder: folder.name }) : Lh("NoShopsGM")}</p>` : `<p class="pmk-none">${Lh("NoShops")}</p>`;
  const vaults = market.vaults ? btn("pmk-vaultlink", `data-action="pmkVault"`, `${icon("fa-vault")} ${Lh(app.isGM ? "VaultsHere" : "YourVault")}${market.vaultFee ? ` <span class="pmk-dim">${Lh("VaultFeeEach", { amount: fmt(market.vaultFee) })}</span>` : ""}`) : "";
  return `<div class="pmk-market pmk-drop">
    <header class="pmk-mhead">
      ${market.img ? `<img class="pmk-banner" src="${esc(market.img)}" alt="">` : ""}
      <div class="pmk-mtitle"><h2>${esc(market.name)}</h2><div class="pmk-sub">${esc(sub)} ${statusChip(app, market)}</div></div>
    </header>
    ${gmBar}
    ${marketPriceLine(market)}
    ${desc ? `<div class="pmk-desc">${desc}</div>` : ""}
    ${vaults}
    <h3 class="pmk-h">${Lh("Shops")}</h3>
    ${shops.length ? `<div class="pmk-shopgrid" data-focus-home tabindex="-1">${cards}</div>` : none}
    ${app.isGM && shops.length ? `<p class="pmk-hint">${Lh("DragMerchantHint")}</p>` : ""}
  </div>`;
}

/** The running tally of the cart for the trader, with a way to the cart. */
function tallyHTML(cart, trader) {
  if (!trader) return "";
  const t = tradeState(cart, trader);
  if (t.empty) return "";
  const n = (list) => list.reduce((k, l) => k + l.qty, 0);
  const bits = [];
  if (t.buys.length) bits.push(`<span>${Lh("TallyBuying", { n: n(t.buys) })} <strong>${esc(fmt(t.buy))}</strong></span>`);
  if (t.sales.length) bits.push(`<span>${Lh("TallySelling", { n: n(t.sales) })} <strong>${esc(fmt(t.sell, "Nothing"))}</strong></span>`);
  const net = t.net > 0 ? Lh("TallyPays", { name: trader.name, amount: fmt(t.net) }) : t.net < 0 ? Lh("TallyGets", { name: trader.name, amount: fmt(-t.net) }) : Lh("Even");
  const short = t.net > fundsCp(trader);
  const bad = [...t.buys, ...t.sales].some((l) => l.problem) || t.short.size;
  return `<div class="pmk-tally ${short || bad ? "pmk-tally-bad" : ""}" role="status">
    ${bits.join(`<span class="pmk-sep">·</span>`)}<span class="pmk-sep">=</span><span class="pmk-net">${net}</span>
    ${short ? `<span class="pmk-warn">${Lh("TallyHas", { amount: fmt(fundsCp(trader), "NoMoney") })}</span>` : bad ? `<span class="pmk-warn">${icon("fa-triangle-exclamation")} ${Lh("CheckTheCart")}</span>` : ""}
    <span class="pmk-gap"></span>
    <button type="button" data-action="pmkCart">${icon("fa-cash-register")} ${Lh("Checkout")}</button>
  </div>`;
}

/** What makes up the chosen trader's prices here, as one line beside Trading as. */
function priceLine(shop, chosen, parts) {
  if (!chosen) return "";
  if (parts.total === null) return `<span class="pmk-pricebits pmk-warn">${Lh("WontTradeWith", { shop: shopFace(shop), name: chosen.name })}</span>`;
  const bits = [];
  const info = attitudeInfo(shop, chosen);
  if (parts.attitude) bits.push(info.masked ? pctText(parts.attitude) : L("PartAttitude", { attitude: L(`Attitude.${attitudeFor(shop, chosen)}`), pct: pctText(parts.attitude) }));
  if (parts.market) bits.push(L("PartMarket", { pct: pctText(parts.market) }));
  if (parts.rep?.pct) bits.push(L("PartReputation", { tier: parts.rep.tier.revealed === false && !game.user.isGM ? L("Reputation") : parts.rep.tier.name, pct: pctText(parts.rep.pct) }));
  if (parts.haggled) bits.push(L("PartHaggle", { pct: pctText(parts.haggled) }));
  if (!parts.total && !bits.length) return "";
  const head = parts.total ? L("PricesFor", { name: chosen.name, pct: pctText(parts.total) }) : L("PricesNormal", { name: chosen.name });
  return `<span class="pmk-pricebits ${parts.total < 0 ? "pmk-goodtext" : ""}">${esc(head)}${bits.length ? ` <span class="pmk-dim">(${esc(bits.join(", "))})</span>` : ""}</span>`;
}

/** The haggle button, or what came of the haggle (players and GMs trading as a character). */
function haggleHTML(shop, chosen) {
  if (!haggleOn() || !chosen || chosen.type !== "character") return "";
  const done = haggleOf(shop, chosen);
  if (done) return `<span class="pmk-chip">${icon("fa-comments-dollar")} ${Lh(`Haggled-${done.degree}`)}</span>`;
  const why = haggleProblem(shop, chosen, game.user);
  if (why && why !== "HaggleNoDC") return "";
  const dc = haggleDC(shop);
  if (isWaiting(shop, chosen)) return `<button type="button" disabled>${icon("fa-hourglass-half")} ${Lh("Waiting")}</button>`;
  return `<button type="button" data-action="pmkHaggle" ${why ? "disabled" : ""}${tipAttr(why ? L(why) : L("TipHaggle", { dc }))}>${icon("fa-comments-dollar")} ${Lh("Haggle")}</button>`;
}

async function shopHTML(app, market, actor) {
  if (!actor) return marketHTML(app, market, shopsFor(market));
  const own = shopRow(actor);
  // Open to this user in any market that holds it (a shop can be in two), as the cart and the GM's client see it.
  const trade = !!tradeMarketFor(actor.id, game.user);
  // Browse only: players see the staples, and the rest only if they saw the shop open since its last restock.
  const staplesOnly = !trade && !app.isGM && !remembered(actor);
  const rows = shopRows(actor).filter((r) => !staplesOnly || (!r.service && cleanStock(r.stock, r.qty).kind === "staple"));
  const conf = shopConf(actor);
  const cart = loadCart();
  const { list: buyers, chosen } = buyerChoices(cart);
  const parts = priceParts(actor, chosen);
  const pct = parts.total;
  const keeper = conf.keeper ? game.actors.get(conf.keeper) : null;
  const face = keeperFace(keeper, app.isGM);
  const sells = trade && conf.buys && pct !== null;
  const tab = app.view.tab === "sell" && sells ? "sell" : "buy";
  const level = shopLevel(actor, market);
  const purse = conf.unlimited ? L("Unlimited") : fmt(fundsCp(actor), "Empty");
  const full = conf.unlimited ? null : fullPurse(actor, market);
  const gmBar = app.isGM ? `<div class="pmk-gmbar">
      <button type="button" class="pmk-tog" data-action="pmkHideShop" aria-pressed="${!own.hidden}"${tipAttr(L(own.hidden ? "TipShopHidden" : "TipShopShown"))}>${icon(own.hidden ? "fa-eye-slash" : "fa-eye")} ${Lh("Shown")}</button>
      <button type="button" class="pmk-tog" data-action="pmkCloseShop" aria-pressed="${!own.closed}"${tipAttr(L(own.closed ? "TipShopClosed" : "TipShopOpen"))}>${icon(own.closed ? "fa-store-slash" : "fa-store")} ${Lh("Open")}</button>
      ${conf.unlimited ? "" : `<button type="button" data-action="pmkFill" ${full === null ? "disabled" : ""}${tipAttr(full === null ? L("TipFillOff") : L("TipFill", { amount: fmt(full), level }))}>${icon("fa-coins")} ${Lh("FillPurse")}</button>`}
      <span class="pmk-gap"></span>
      <button type="button" data-action="pmkRestock"${tipAttr(L("TipRestock"))}>${icon("fa-rotate")} ${Lh("Restock")}</button>
      <button type="button" data-action="pmkDraw"${tipAttr(L("TipDraw"))}>${icon("fa-dice")} ${Lh("Draw")}</button>
      <button type="button" data-action="pmkAddItem"${tipAttr(L("TipAddItem"))}>${icon("fa-box-open")} ${Lh("AddItem")}</button>
      <button type="button" data-action="pmkShopSettings">${icon("fa-sliders")} ${Lh("Settings")}</button>
      <button type="button" data-action="pmkSheet">${icon("fa-file-invoice")} ${Lh("MerchantSheet")}</button>
    </div>` : "";
  const info = attitudeInfo(actor, null);
  const gmAtt = !info.masked ? L("AttitudeGeneral", { attitude: L(`Attitude.${info.attitude}`) })
    : L("AttitudeMasked", { real: ATTITUDES.includes(info.real) ? L(`Attitude.${info.real}`) : L("NoAttitude"), shown: ATTITUDES.includes(info.shown) ? L(`Attitude.${info.shown}`) : L("Unknown") });
  const keeperHTML = face ? `<div class="pmk-keeper"><img src="${esc(face.img)}" alt=""><div><strong>${esc(face.name)}</strong>
      ${app.isGM ? `<span class="pmk-dim">${esc(gmAtt)}</span>` : ""}</div></div>`
    : app.isGM ? `<p class="pmk-hint">${Lh("KeeperHint")}</p>` : "";
  const tradingAs = buyers.length ? `<label class="pmk-buyer-l">${Lh("TradingAs")} <select name="pmk-buyer">${buyers.map((a) => `<option value="${esc(a.id)}" ${a.id === chosen?.id ? "selected" : ""}>${esc(a.type === "party" ? L("PartyStash", { name: a.name }) : a.name)}: ${esc(fmt(fundsCp(a), "NoMoney"))}</option>`).join("")}</select></label>` : "";
  const tabs = sells ? `<div class="pmk-tabs" role="tablist" aria-label="${Lh("BuyOrSell")}">
      <button type="button" class="pmk-a pmk-tab ${tab === "buy" ? "active" : ""}" role="tab" id="pmk-tab-buy" aria-selected="${tab === "buy"}" aria-controls="pmk-panel" data-action="pmkTab" data-tab="buy" ${tab === "buy" ? "data-focus-home" : ""}>${icon("fa-cart-shopping")} ${Lh("Buy")}</button>
      <button type="button" class="pmk-a pmk-tab ${tab === "sell" ? "active" : ""}" role="tab" id="pmk-tab-sell" aria-selected="${tab === "sell"}" aria-controls="pmk-panel" data-action="pmkTab" data-tab="sell" ${tab === "sell" ? "data-focus-home" : ""}>${icon("fa-hand-holding-dollar")} ${Lh("Sell")}</button>
    </div>` : "";
  const body = tab === "sell" ? sellHTML(app, actor, chosen, conf, cart, pct ?? 0) : await stockHTML(app, actor, rows, trade && pct !== null, pct ?? 0, cart, chosen);
  const sub = [L(rows.length === 1 ? "ItemsOne" : "ItemsMany", { n: rows.length }), level ? L("LevelN", { n: level }) : ""].filter(Boolean).join(" · ");
  return `<div class="pmk-shopview pmk-keeperdrop">
    ${chosen ? tallyHTML(cart, chosen) : ""}
    <header class="pmk-shead">
      ${btn("pmk-back", `data-action="pmkBack"`, `${icon("fa-arrow-left")} ${esc(market.name)}`)}
      <div class="pmk-stitle"><img src="${esc(actor.img)}" alt=""><div><h2>${esc(actor.name)}</h2>
        <div class="pmk-sub">${esc(sub)}${conf.buys || app.isGM ? ` · <span class="pmk-purse"${tipAttr(L("TipPurse"))}>${icon("fa-sack-dollar")} <span class="pmk-sr">${Lh("TipPurse")}: </span>${esc(purse)}</span>` : ""} ${statusChip(app, market, actor)}</div></div>
        ${keeperHTML}</div>
    </header>
    ${gmBar}
    ${marketPriceLine(priceMarket(actor.id, game.user) ?? market)}
    ${staplesOnly ? `<p class="pmk-hint">${Lh("StaplesOnly")}</p>` : ""}
    ${trade && (tradingAs || chosen) ? `<div class="pmk-buyer">${tradingAs}${priceLine(actor, chosen, parts)}<span class="pmk-gap"></span>${haggleHTML(actor, chosen)}</div>` : ""}
    ${tabs}
    <div id="pmk-panel" ${sells ? `role="tabpanel" aria-labelledby="pmk-tab-${tab}"` : ""}>${body}</div>
  </div>`;
}

/** The sort buttons over the Buy list (sortable headings). */
function sortHead(app, key, label, cls = "") {
  const on = (app.view.sort ?? "level") === key;
  const said = on ? L(app.view.desc ? "SortedDown" : "SortedUp", { col: label }) : L("SortBy", { col: label });
  return `<span class="${cls}">${btn("pmk-sort", `data-action="pmkSort" data-key="${key}" aria-label="${esc(said)}"`, `${esc(label)}${on ? ` ${icon(app.view.desc ? "fa-caret-down" : "fa-caret-up")}` : ""}`)}</span>`;
}

/** The Buy tab: the shop's stock (and services), priced for the chosen buyer; sorted and filtered as the user picks. */
async function stockHTML(app, actor, rows, trade, pct, cart, buyer) {
  const inCart = new Map(cart.lines.filter((l) => l.shop === actor.id).map((l) => [l.item, l.qty]));
  const funds = buyer ? fundsCp(buyer) : 0;
  const myLevel = buyer?.type === "character" ? actorLevel(buyer) : null;
  const priced = rows.map((r) => ({ ...r, shown: r.cp === null ? null : buyPrice(r.cp, r.per, r.per, pct, !r.service && r.type === "treasure", r.formula || r.service) }));
  const f = app.view.filters ?? {};
  const filter = (r) => (!f.afford || !trade || (r.shown !== null && r.shown <= funds)) && (!f.level || myLevel === null || r.level <= myLevel);
  const groups = groupStock(priced, app.view.query, { sort: app.view.sort, desc: app.view.desc, filter });
  const list = [];
  for (const [key, items] of groups) {
    list.push(`<div class="pmk-gh">${Lh(`Cat.${key}`)} <span class="pmk-count">${items.length}</span></div>`);
    for (const r of items) list.push(await rowHTML(app, actor, r, trade, inCart.get(r.id) ?? 0, buyer, funds));
  }
  const query = app.view.query;
  const body = rows.length ? (list.length ? list.join("") : `<p class="pmk-none">${query ? Lh("NothingMatches", { q: query }) : Lh("NothingFilter")}</p>`)
    : `<p class="pmk-none">${Lh("NothingInStock")}</p>`;
  const toggles = trade && buyer ? `<div class="pmk-filters" role="group" aria-label="${Lh("ShowOnly")}">
      <button type="button" class="pmk-tog" data-action="pmkFilter" data-key="afford" aria-pressed="${!!f.afford}">${icon("fa-coins")} ${Lh("Affordable")}</button>
      ${myLevel !== null ? `<button type="button" class="pmk-tog" data-action="pmkFilter" data-key="level" aria-pressed="${!!f.level}">${icon("fa-signal")} ${Lh("UpToMyLevel")}</button>` : ""}
    </div>` : "";
  return `<div class="pmk-stocktools"><label class="pmk-search">${icon("fa-magnifying-glass")}<input type="search" name="pmk-q" value="${esc(query)}" placeholder="${Lh("SearchShop")}" aria-label="${Lh("SearchShop")}" autocomplete="off"></label>${toggles}</div>
    <div class="pmk-stock" data-keep-scroll="stock">
      <div class="pmk-rowhead"><span></span>${sortHead(app, "name", L("ColItem"))}${sortHead(app, "level", L("ColLevel"))}<span>${Lh("ColStock")}</span>${sortHead(app, "price", L("ColPrice"))}<span></span></div>
      ${body}
    </div>`;
}

/** One line of the Buy list. */
async function rowHTML(app, actor, r, trade, have, buyer, funds) {
  const open = app.view.open.has(r.id);
  const rar = RARITY.includes(r.rarity) ? `<span class="pmk-rar pmk-${esc(r.rarity)}">${Lh(`Rarity.${r.rarity}`)}</span>` : "";
  // A formula: not for a character who knows it, nor for the party stash.
  const knows = r.formula && buyer && (buyer.type !== "character" || knowsFormula(buyer, r.uuid));
  const note = r.service ? (r.note ? `<span class="pmk-note">${esc(r.note)}</span>` : "")
    : r.holds ? `<span class="pmk-note">${Lh(r.holds === 1 ? "HoldsOne" : "HoldsMany", { n: r.holds })}</span>`
    : knows ? `<span class="pmk-note">${buyer.type === "character" ? Lh("KnowsIt", { name: buyer.name }) : Lh("CharactersOnly")}</span>`
    : r.formula && r.cp === null ? `<span class="pmk-note pmk-warn">${Lh("FormulaNoPrice")}</span>` : "";
  const marks = app.isGM && !r.service ? kindHTML(r) + formulaHTML(r) : "";
  const dear = trade && r.shown !== null && r.shown > funds;
  const was = r.shown !== null && r.shown !== r.cp ? ` <s class="pmk-per">${esc(fmt(r.cp))}</s>` : "";
  const price = r.shown === null ? Lh("NoPrice") : `${esc(fmt(r.shown))}${was}${r.per > 1 ? ` <span class="pmk-per">${Lh("ForN", { n: r.per })}</span>` : ""}`;
  const name = r.service ? `<span class="pmk-rname">${esc(r.name)}</span>`
    : btn("pmk-rname", `data-action="pmkItem" data-id="${esc(r.id)}" aria-expanded="${open}"${tipAttr(L(open ? "TipHideDetails" : "TipShowDetails"))}`, esc(r.name));
  const sheet = r.service ? "" : btn("pmk-rtool", `data-action="pmkItemSheet" data-id="${esc(r.id)}"${labelAttr(L("OpenSheet"))}`, icon("fa-file-lines"));
  const qty = r.service ? Lh("Service") : r.formula ? Lh("Copy") : r.qty ? `×${r.qty}` : Lh("SoldOut");
  const canAdd = trade && !knows && (!r.formula || (!!r.uuid && r.cp !== null));
  const out = [`<div class="pmk-row ${open ? "open" : ""} ${r.qty ? "" : "pmk-out"} ${dear ? "pmk-dear" : ""}" data-id="${esc(r.id)}">
    <img src="${esc(r.img)}" alt="">
    <span class="pmk-rn">${name}${sheet} ${rar}${marks}${note}</span>
    <span class="pmk-lvl">${r.service ? "" : r.level}</span>
    <span class="pmk-qty">${qty}</span>
    <span class="pmk-price"${dear ? tipAttr(L("TipCantAfford", { name: buyer.name })) : ""}>${price}</span>
    ${addHTML(r, canAdd, have)}
  </div>`];
  if (open) out.push(`<div class="pmk-rdesc">${await app.description(actor, r.id) || `<p class="pmk-none">${Lh("NoDescription")}</p>`}</div>`);
  return out.join("");
}

/** The GM's stock mark on a row: staple (and what it restocks to), rotating, or sold (restocks left). The mark swaps
 * staple and rotating; the pencil beside a staple sets what it restocks to. */
function kindHTML(r) {
  const st = cleanStock(r.stock, r.qty);
  const label = st.kind === "staple" ? L("KindStaple", { n: st.qty }) : st.kind === "rotating" ? L("KindRotating") : L("KindSold", { n: st.left });
  const tip = st.kind === "staple" ? L("TipStaple", { n: st.qty }) : st.kind === "rotating" ? L("TipRotating") : L(st.left === 1 ? "TipSoldOne" : "TipSoldMany", { n: st.left });
  const edit = st.kind === "staple" ? btn("pmk-pencil", `data-action="pmkStapleQty" data-id="${esc(r.id)}"${labelAttr(L("SetRestockNumber"))}`, icon("fa-pen")) : "";
  return btn(`pmk-kind pmk-kind-${st.kind}`, `data-action="pmkKind" data-id="${esc(r.id)}"${tipAttr(tip)}`, esc(label)) + edit;
}

/** The GM's formula mark: sells the item as a formula (or not); the pencil beside a formula sets its price. */
function formulaHTML(r) {
  const tip = r.formula ? (r.cp === null ? L("TipFormulaNoPrice") : L("TipFormulaOn", { price: fmt(r.cp) })) : L("TipFormulaOff");
  const mark = btn(`pmk-fmark ${r.formula ? "on" : ""}`, `data-action="pmkFormula" data-id="${esc(r.id)}" aria-pressed="${!!r.formula}" aria-label="${Lh("SellAsFormula")}"${tipAttr(tip)}`, icon("fa-scroll"));
  return mark + (r.formula ? btn("pmk-pencil", `data-action="pmkFormulaPrice" data-id="${esc(r.id)}"${labelAttr(L("SetFormulaPrice"))}`, icon("fa-pen")) : "");
}

/** The add-to-cart buttons for a stock row: only where this user can trade, for something in stock and for sale. Plus
 * adds one (a batch for things sold in batches); minus takes one off. */
function addHTML(r, trade, have) {
  if (!trade || !r.qty || r.holds) return `<span class="pmk-add"></span>`;
  const full = !r.service && have >= r.qty;
  const step = r.per > 1 ? Math.min(r.per, Math.max(1, r.qty - have)) : 1;
  const minus = have ? btn("pmk-addbtn pmk-minus", `data-action="pmkTakeOff" data-id="${esc(r.id)}"${labelAttr(L("TakeOff", { name: r.name, n: r.per > 1 ? r.per : 1 }))}`, icon("fa-minus")) : "";
  return `<span class="pmk-add">${minus}${btn(`pmk-addbtn ${full ? "pmk-full" : ""}`, `data-action="pmkAdd" data-id="${esc(r.id)}" ${full ? `aria-disabled="true"` : ""}${labelAttr(full ? L("AllInCart", { name: r.name }) : L("AddN", { name: r.name, n: step }))}`, `${icon("fa-cart-plus")}${have ? `<span class="pmk-have">${have}</span>` : ""}`)}</span>`;
}

/** The Sell tab: what the chosen character carries, with the shop's offer for each. Choices go into the cart. */
function sellHTML(app, shop, seller, conf, cart, pct) {
  if (!seller) return `<p class="pmk-none">${Lh("NoCharacterSell")}</p>`;
  const rows = sellRows(seller);
  const offer = (r, qty) => offerFor(r.cp, r.per, qty, sellRate(conf, r.treasure, pctFor(pct, r.treasure)));
  const offered = new Map(salesOf(cart, seller).map((l) => [l.item, l]));
  let total = 0;
  const list = rows.map((r) => {
    const line = offered.get(r.id);
    const here = line?.shop === shop.id ? Math.min(line.qty, r.qty) : 0;
    const elsewhere = line && line.shop !== shop.id ? game.actors.get(line.shop) : null;
    if (!r.why) total += offer(r, here);
    const each = offer(r, r.per);
    const worth = !r.cp ? L("WorthNothing") : `${each ? fmt(each) : L("UnderOneCp")} ${r.per > 1 ? L("ForN", { n: r.per }) : L("Each")}`;
    const parts = r.parts ? L("WholeStack") : "";
    const note = r.why ? esc(r.why) : esc([worth, parts, elsewhere ? L("OfferedTo", { shop: elsewhere.name }) : ""].filter(Boolean).join("; "));
    const step = r.per > 1 ? r.per : 1;
    const buttons = r.why ? `<span class="pmk-add"></span>` : `<span class="pmk-add">${here ? btn("pmk-addbtn pmk-minus", `data-action="pmkSellLess" data-id="${esc(r.id)}"${labelAttr(L("OfferFewer", { name: r.name, n: step }))}`, icon("fa-minus")) : ""}${btn(`pmk-addbtn pmk-sellbtn ${here >= r.qty ? "pmk-full" : ""}`, `data-action="pmkSellAdd" data-id="${esc(r.id)}"${labelAttr(here >= r.qty ? L("AllOffered", { name: r.name }) : L("OfferMore", { name: r.name, n: r.parts ? r.qty : step }))}`, `${icon("fa-hand-holding-dollar")}${here ? `<span class="pmk-have">${here}</span>` : ""}`)}</span>`;
    return `<div class="pmk-srow ${r.why ? "pmk-no" : ""}" data-id="${esc(r.id)}">
      <img src="${esc(r.img)}" alt="">
      <span class="pmk-rn">${esc(r.name)}${btn("pmk-rtool", `data-action="pmkOwnSheet" data-id="${esc(r.id)}"${labelAttr(L("OpenSheet"))}`, icon("fa-file-lines"))}<span class="pmk-note">${note}</span></span>
      <span class="pmk-qty">×${r.qty}</span>
      ${r.why ? "<span></span>" : `<input type="number" class="pmk-qtyin" name="pmk-saleqty" data-shop="${esc(shop.id)}" data-item="${esc(r.id)}" value="${here}" min="0" max="${r.qty}" step="${r.parts ? r.qty : 1}" aria-label="${Lh("SellHowMany", { name: r.name })}">`}
      <span class="pmk-price">${r.why || !here ? "" : esc(fmt(offer(r, here), "Nothing"))}</span>
      ${buttons}
    </div>`;
  }).join("");
  const short = !conf.unlimited && total > fundsCp(shop) ? `<p class="pmk-status pmk-warnbox">${Lh("Raw", { text: `${shop.name} ${canPay(shop)}.` })}</p>` : "";
  return `${short}<div class="pmk-stock" data-keep-scroll="sell">
      <div class="pmk-srowhead"><span></span><span>${Lh("ColItem")}</span><span>${Lh("ColHave")}</span><span>${Lh("ColSell")}</span><span>${Lh("ColOffer")}</span><span></span></div>
      ${list || `<p class="pmk-none">${Lh("NothingToSell", { name: seller.name })}</p>`}
    </div>`;
}

/** An item's description, enriched once per version of the item (the window keeps the cache). */
async function describe(app, actor, itemId) {
  const item = actor.items.get(itemId);
  if (!item) return "";
  const key = `${item.uuid}|${item._stats?.modifiedTime ?? 0}`;
  if (!app.descs.has(key)) {
    const html = await TextEditor().enrichHTML(descriptionOf(item), { secrets: app.isGM, rollData: item.getRollData?.(), relativeTo: item });
    if (app.descs.size > 200) app.descs.clear();
    app.descs.set(key, html);
  }
  return app.descs.get(key);
}

export { btn, describe, icon, marketHTML, shopHTML, tallyHTML, treasureOk };
