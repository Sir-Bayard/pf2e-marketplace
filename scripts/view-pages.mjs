import { canAccept, cleanLogEntry, coinsCp, esc } from "./helpers.mjs";
import { fundsCp, realItem, tradeRows } from "./pf2e.mjs";
import { labelAttr } from "./kit/safe-text.mjs";
import { L, Lh, MOD, fmt, listOf } from "./constants.mjs";
import { buyerChoices, cartState, marketById, tradeState } from "./data.mjs";
import { isRequest, offerProblem, offerTargets, offers, tradersFor } from "./post.mjs";
import { busy, posting, trading, waitingFor } from "./requests.mjs";
import { vaultOf, vaultUsersFor, vaultsAt } from "./vault.mjs";
import { canTrade } from "./helpers.mjs";
import { btn, icon } from "./view-shop.mjs";

/* The cart, the Trade Post, the trade log and the vault pages of the window. */

const back = (key = "BackToMarket") => btn("pmk-back", `data-action="pmkCartBack"`, `${icon("fa-arrow-left")} ${Lh(key)}`);
const said = (p) => (p ? L(p.key, p.data) : "");
const named = (name, qty) => (qty > 1 ? L("NameTimes", { name, n: qty }) : name);

/** A quantity with minus and plus buttons, for a cart line. */
function stepperHTML(kind, l, max, name) {
  const keys = `data-kind="${kind}" data-shop="${esc(l.shop)}" data-item="${esc(l.item)}"`;
  return `<span class="pmk-step">
    ${btn("pmk-stepbtn", `data-action="pmkStep" data-dir="-1" ${keys}${labelAttr(L("OneFewer", { name }))}`, icon("fa-minus"))}
    <input type="number" class="pmk-qtyin" name="${kind === "buy" ? "pmk-qty" : "pmk-saleqty"}" ${kind === "buy" ? "" : `data-cart="1"`} data-shop="${esc(l.shop)}" data-item="${esc(l.item)}" value="${l.qty}" min="1" max="${Math.max(1, max)}" step="1" aria-label="${Lh("HowMany", { name })}">
    ${btn("pmk-stepbtn", `data-action="pmkStep" data-dir="1" ${keys}${labelAttr(L("OneMore", { name }))}`, icon("fa-plus"))}
  </span>`;
}

/** The cart: who's trading, what they buy and sell by shop, how it settles, and what's left after. */
function cartHTML(app, cart) {
  const { list, chosen } = buyerChoices(cart);
  const t = chosen ? tradeState(cart, chosen) : { empty: !cart.lines.length, buys: cartState(cart.lines, null), sales: [], buy: 0, sell: 0, net: 0, short: new Map() };
  if (t.empty) return `<div class="pmk-cartview"><header class="pmk-shead">${back()}<h2>${Lh("Cart")}</h2></header><p class="pmk-none">${Lh("CartEmpty")}</p></div>`;
  const byShop = (lines) => {
    const groups = new Map();
    for (const l of lines) groups.set(l.shop, [...(groups.get(l.shop) ?? []), l]);
    return [...groups.values()];
  };
  const head = (lines) => {
    const shop = lines[0].shopDoc;
    const where = lines[0].market ? ` <span class="pmk-dim">${esc(lines[0].market.name)}</span>` : "";
    const short = t.short.get(lines[0].shop);
    return `<div class="pmk-gh">${esc(shop?.name ?? L("ShopGoneName"))}${where}</div>${short ? `<p class="pmk-status pmk-warnbox">${esc(short)}</p>` : ""}`;
  };
  const remove = (kind, l, name) => btn("pmk-x", `data-action="pmkCartRemove" data-kind="${kind}" data-shop="${esc(l.shop)}" data-item="${esc(l.item)}"${labelAttr(L("TakeOutOfCart", { name }))}`, icon("fa-xmark"));
  const buying = byShop(t.buys).map((lines) => head(lines) + lines.map((l) => {
    const real = l.service ? { name: l.service.name, img: "icons/svg/coins.svg" } : l.itemDoc ? realItem(l.itemDoc) : { name: L("Gone"), img: "" };
    const name = l.formula ? L("FormulaOf", { name: real.name }) : real.name;
    return `<div class="pmk-crow ${l.problem ? "pmk-bad" : ""}">
      <img src="${esc(real.img)}" alt="">
      <span class="pmk-rn">${esc(name)}${l.problem ? `<span class="pmk-note pmk-warn">${esc(l.problem)}</span>` : ""}</span>
      ${stepperHTML("buy", l, l.service ? 999 : l.stock, name)}
      <span class="pmk-price">${esc(fmt(l.price))}</span>
      ${remove("buy", l, name)}
    </div>`;
  }).join("")).join("");
  const selling = byShop(t.sales).map((lines) => head(lines) + lines.map((l) => {
    const name = l.row?.name ?? L("Gone");
    return `<div class="pmk-crow ${l.problem ? "pmk-bad" : ""}">
      <img src="${esc(l.row?.img ?? "")}" alt="">
      <span class="pmk-rn">${esc(name)}${l.problem ? `<span class="pmk-note pmk-warn">${esc(l.problem)}</span>` : ""}</span>
      ${stepperHTML("sale", l, l.row?.qty ?? 1, name)}
      <span class="pmk-price">${esc(fmt(l.offer, "Nothing"))}</span>
      ${remove("sale", l, name)}
    </div>`;
  }).join("")).join("");
  const have = chosen ? fundsCp(chosen) : 0;
  const traders = list.map((a) => `<option value="${esc(a.id)}" ${a.id === chosen?.id ? "selected" : ""}>${esc(a.type === "party" ? L("PartyStash", { name: a.name }) : a.name)}: ${esc(fmt(fundsCp(a), "NoMoney"))}</option>`).join("");
  const short = chosen && t.net > have;
  const bad = [...t.buys, ...t.sales].some((l) => l.problem) || t.short.size;
  const noGM = !app.isGM && !game.users.activeGM;
  const why = !chosen ? L("NoCharacter") : noGM ? L("NeedGM") : bad ? L("FixLinesFirst") : short ? L("IsShort", { name: chosen.name, amount: fmt(t.net - have) }) : "";
  const label = t.net > 0 ? L("PayN", { amount: fmt(t.net) }) : t.net < 0 ? L("TradeAndGet", { amount: fmt(-t.net) }) : L("Trade");
  const name = chosen?.name ?? "";
  return `<div class="pmk-cartview">
    <header class="pmk-shead">${back()}<h2>${Lh("Cart")}</h2></header>
    <label class="pmk-buyer">${Lh("TradingAs")} ${list.length ? `<select name="pmk-buyer">${traders}</select>` : `<em>${Lh("NoCharacterShort")}</em>`}</label>
    ${t.buys.length ? `<h3 class="pmk-h">${icon("fa-cart-shopping")} ${Lh("Buying")}</h3><div class="pmk-stock" data-keep-scroll="cartbuy">${buying}</div>` : ""}
    ${t.sales.length ? `<h3 class="pmk-h">${icon("fa-hand-holding-dollar")} ${Lh("Selling")}</h3><div class="pmk-stock" data-keep-scroll="cartsell">${selling}</div>` : ""}
    <div class="pmk-total">
      ${t.buys.length ? `<div><span>${Lh("Buying")}</span><span>${esc(fmt(t.buy))}</span></div>` : ""}
      ${t.sales.length ? `<div><span>${Lh("Selling")}</span><span>${t.buys.length ? "− " : ""}${esc(fmt(t.sell, "Nothing"))}</span></div>` : ""}
      <div><span>${t.net > 0 ? Lh("NamePays", { name }) : t.net < 0 ? Lh("NameGets", { name }) : Lh("Even")}</span><strong>${t.net ? esc(fmt(Math.abs(t.net))) : ""}</strong></div>
      ${chosen ? `<div class="pmk-dim"><span>${Lh("NameHas", { name })}</span><span>${esc(fmt(have, "NoMoney"))}</span></div>
      <div class="${short ? "pmk-warn" : "pmk-dim"}"><span>${Lh("After")}</span><span>${short ? Lh("NotEnough") : esc(fmt(have - t.net, "Nothing"))}</span></div>` : ""}
    </div>
    ${why ? `<p class="pmk-status" role="status">${esc(why)}</p>` : ""}
    <div class="pmk-checkout">${busy() ? `<button type="button" disabled>${icon("fa-hourglass-half")} ${Lh(trading ? "Trading" : "WaitingForGM")}</button>`
      : `<button type="button" data-action="pmkCheckout" data-buy="${t.buy}" data-sell="${t.sell}" ${why ? "disabled" : ""}>${icon("fa-coins")} ${esc(label)}</button>`}</div>
  </div>`;
}

/** The Trade Post: offers between players' characters. */
function postHTML(app) {
  // A GM watches the Trade Post: no character of their own, so they remove offers but never accept or post for one.
  const traders = app.isGM ? [] : tradersFor(game.user);
  const me = traders.find((a) => a.id === app.view.postAs) ?? traders[0] ?? null;
  if (app.view.draft && me) return draftHTML(app, me);
  const list = offers();
  const mine = new Set(traders.map((a) => a.id));
  const chip = (l) => `<span class="pmk-chip"><img src="${esc(l.img)}" alt="">${esc(named(l.name, l.qty))}</span>`;
  const side = (s) => [...s.items.map(chip), s.cp ? `<span class="pmk-chip pmk-coins">${icon("fa-coins")}${esc(fmt(s.cp))}</span>` : ""].join("") || `<span class="pmk-dim">${Lh("NothingLower")}</span>`;
  const wait = posting() || waitingFor("accept");
  const card = (o) => {
    const from = game.actors.get(o.from);
    const to = o.to ? game.actors.get(o.to) : null;
    const own = mine.has(o.from);
    const canTake = !!me && canAccept(o, me.id);
    const problem = canTake ? offerProblem(o, me) : offerProblem(o, null);
    const act = own || app.isGM ? `<button type="button" data-action="pmkWithdraw" data-id="${esc(o.id)}">${icon("fa-xmark")} ${Lh(own ? "TakeDown" : "Remove")}</button>` : "";
    const take = canTake ? (wait ? `<button type="button" disabled>${icon("fa-hourglass-half")} ${Lh("Waiting")}</button>`
      : `<button type="button" data-action="pmkAccept" data-id="${esc(o.id)}" ${problem ? "disabled" : ""}>${icon("fa-handshake")} ${Lh(isRequest(o) ? "Give" : "Accept")}</button>`) : "";
    const whom = isRequest(o) ? (o.to ? L("AsksName", { name: to?.name ?? L("GoneCharacter") }) : L("AsksAnyone")) : (o.to ? L("ForName", { name: to?.name ?? L("GoneCharacter") }) : L("ForAnyone"));
    return `<div class="pmk-offer ${problem ? "pmk-stale" : ""}">
      <div class="pmk-ohead"><img src="${esc(from?.img ?? "")}" alt=""><strong>${esc(from?.name ?? L("Gone"))}</strong>
        <span class="pmk-dim">${esc(whom)}</span><span class="pmk-gap"></span>${take}${act}</div>
      ${isRequest(o) ? "" : `<div class="pmk-oside"><span class="pmk-olabel">${Lh("Gives")}</span>${side(o.give)}</div>`}
      <div class="pmk-oside"><span class="pmk-olabel">${Lh("Wants")}</span>${side(o.want)}</div>
      ${o.note ? `<p class="pmk-onote">${esc(o.note)}</p>` : ""}
      ${problem && (canTake || own) ? `<p class="pmk-note pmk-warn">${esc(said(problem))}</p>` : ""}
    </div>`;
  };
  // Each offer once: for the character trading, open to them, theirs or another of the user's, or (for the GM) others.
  const forMe = list.filter((o) => me && o.to === me.id);
  const open = list.filter((o) => !o.to && o.from !== me?.id && !mine.has(o.from));
  const own = list.filter((o) => mine.has(o.from) && !forMe.includes(o));
  const others = app.isGM ? list.filter((o) => !forMe.includes(o) && !open.includes(o) && !own.includes(o)) : [];
  const section = (title, items) => (items.length ? `<h3 class="pmk-h">${Lh(title)}</h3><div class="pmk-offers">${items.map(card).join("")}</div>` : "");
  const as = traders.length ? `<label class="pmk-buyer">${Lh("TradingAs")} <select name="pmk-postas">${traders.map((a) => `<option value="${esc(a.id)}" ${a.id === me?.id ? "selected" : ""}>${esc(a.name)}: ${esc(fmt(fundsCp(a), "NoMoney"))}</option>`).join("")}</select></label>` : "";
  const body = section("ForYou", forMe) + section("OpenOffers", open) + section("BetweenOthers", others) + section("YourOffers", own);
  return `<div class="pmk-postview">
    <header class="pmk-shead">${back()}<h2>${Lh("TradePost")}</h2></header>
    <div class="pmk-gmbar">${as}<span class="pmk-gap"></span>${me ? `<button type="button" data-action="pmkNewOffer">${icon("fa-plus")} ${Lh("NewOffer")}</button>` : ""}</div>
    ${body || `<p class="pmk-none">${Lh("NoOffers")}</p>`}
  </div>`;
}

/** A new offer: what the character gives, who it's for, and what they want. A stack with attached parts goes whole. */
function draftHTML(app, me) {
  const d = app.view.draft;
  const targets = offerTargets().filter((a) => a.id !== me.id);
  const to = targets.find((a) => a.id === d.to) ?? null;
  const rows = (actor, key, picked) => tradeRows(actor).map((r) => {
    const note = r.why ?? (r.parts ? L("WholeStack") : "");
    return `<div class="pmk-srow ${r.why ? "pmk-no" : ""}">
      <img src="${esc(r.img)}" alt=""><span class="pmk-rn">${esc(r.name)}${note ? `<span class="pmk-note">${esc(note)}</span>` : ""}</span>
      <span class="pmk-qty">×${r.qty}</span>
      ${r.why ? "<span></span>" : `<input type="number" class="pmk-qtyin" name="${key}" data-item="${esc(r.id)}" value="${picked[r.id] ?? 0}" min="0" max="${r.qty}" step="${r.parts ? r.qty : 1}" aria-label="${Lh("HowMany", { name: r.name })}">`}
      <span></span><span></span></div>`;
  }).join("") || `<p class="pmk-none">${Lh("NothingToTrade")}</p>`;
  const coins = (key, cp) => {
    const c = { gp: Math.floor(cp / 100), sp: Math.floor((cp % 100) / 10), cp: cp % 10 };
    return `<span class="pmk-coinsin">${["gp", "sp", "cp"].map((k) => `<label><input type="number" name="${key}-${k}" value="${c[k] || ""}" min="0" step="1" placeholder="0"> ${Lh(`Coin.${k}`)}</label>`).join("")}</span>`;
  };
  const wait = posting() || waitingFor("post");
  return `<div class="pmk-postview">
    <header class="pmk-shead">${btn("pmk-back", `data-action="pmkOfferCancel"`, `${icon("fa-arrow-left")} ${Lh("TradePost")}`)}<h2>${Lh("NewOfferFrom", { name: me.name })}</h2></header>
    <label class="pmk-buyer">${Lh("For")} <select name="d-to"><option value="">${Lh("Anyone")}</option>${targets.map((a) => `<option value="${esc(a.id)}" ${a.id === to?.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label>
    <h3 class="pmk-h">${Lh("NameGives", { name: me.name })} <span class="pmk-dim">${Lh("EmptyForRequest")}</span></h3>
    <div class="pmk-stock">${rows(me, "d-give", d.give)}</div>
    <div class="pmk-buyer">${Lh("Coins")} ${coins("d-gcp", d.giveCp)}</div>
    <h3 class="pmk-h">${to ? Lh("NameGives", { name: to.name }) : Lh("AskingFor")}</h3>
    ${to ? `<div class="pmk-stock">${rows(to, "d-want", d.want)}</div>` : `<p class="pmk-hint">${Lh("AnyoneCoinsOnly")}</p>`}
    <div class="pmk-buyer">${Lh("Coins")} ${coins("d-wcp", d.wantCp)}</div>
    <label class="pmk-buyer pmk-wide">${Lh("Note")} <input type="text" name="d-note" value="${esc(d.note)}" maxlength="300" placeholder="${Lh("Optional")}"></label>
    <div class="pmk-checkout"><button type="button" data-action="pmkOfferCancel">${Lh("Cancel")}</button>
      ${wait ? `<button type="button" disabled>${icon("fa-hourglass-half")} ${Lh("Waiting")}</button>` : `<button type="button" data-action="pmkOfferPost">${icon("fa-thumbtack")} ${Lh("PostOffer")}</button>`}</div>
  </div>`;
}

/** Read the new offer's form into the view (only while the form is on screen: a redraw from elsewhere mustn't wipe it). */
function readDraft(app) {
  const d = app.view.draft;
  if (!d || !app.element?.querySelector('[name="d-note"]')) return;
  const el = app.element;
  const v = (name) => el.querySelector(`[name="${name}"]`)?.value ?? "";
  const qtys = (key) => Object.fromEntries([...el.querySelectorAll(`input[name="${key}"]`)].map((i) => [i.dataset.item, Math.max(0, Math.floor(Number(i.value)) || 0)]).filter(([, n]) => n > 0));
  if (el.querySelector('[name="d-to"]')) d.to = v("d-to") || null;
  d.give = qtys("d-give");
  d.want = qtys("d-want");
  d.giveCp = coinsCp({ gp: v("d-gcp-gp"), sp: v("d-gcp-sp"), cp: v("d-gcp-cp") });
  d.wantCp = coinsCp({ gp: v("d-wcp-gp"), sp: v("d-wcp-sp"), cp: v("d-wcp-cp") });
  d.note = v("d-note").slice(0, 300);
}

/** One log entry as a sentence: who did what, where. */
function logLine(e) {
  const what = listOf(e.items.map((i) => named(i.name, i.qty)));
  const got = listOf((e.got ?? []).map((i) => named(i.name, i.qty)));
  const data = { actor: e.actor, shop: e.shop, what: what || L("CoinsLower"), got: got || L("CoinsLower") };
  if (e.kind === "buy") return L("LogBought", data);
  if (e.kind === "sell") return L("LogSold", data);
  if (e.kind === "deposit") return L(what ? "LogDeposited" : "LogDepositedCoins", { ...data, amount: fmt(e.cp) });
  if (e.kind === "withdraw") return L(what ? "LogWithdrew" : "LogWithdrewCoins", { ...data, amount: fmt(e.cp) });
  if (!what && e.net >= 0) return L("LogGot", { ...data, got: listOf([got, e.net ? fmt(e.net) : ""].filter(Boolean)) || L("NothingLower") });
  if (!got && e.net <= 0) return L("LogGave", data);
  return L(e.net && what && got ? (e.net > 0 ? "LogTradedGot" : "LogTradedPaid") : "LogTraded", { ...data, amount: fmt(Math.abs(e.net)) });
}

/** The GM's trade log, newest first. */
function logHTML() {
  const log = (game.settings.get(MOD, "log") ?? []).map(cleanLogEntry).filter(Boolean);
  const lang = game.i18n?.lang || undefined;
  const rows = log.map((e) => {
    const who = e.user && e.user !== e.actor ? ` <span class="pmk-dim">(${esc(e.user)})</span>` : "";
    const money = e.kind === "trade" && !e.cp ? Lh("EvenLower") : esc(fmt(e.cp, "Nothing"));
    return `<div class="pmk-logrow"><span class="pmk-dim">${esc(new Date(e.t).toLocaleString(lang))}</span>
      <span>${esc(logLine(e))}${who}${e.market ? ` <span class="pmk-dim">${esc(e.market)}</span>` : ""}</span>
      <span class="pmk-price ${e.kind === "buy" ? "pmk-in" : "pmk-outc"}">${money}</span>
      ${e.note ? `<span class="pmk-lognote">${icon("fa-triangle-exclamation")} ${esc(e.note)}</span>` : ""}</div>`;
  }).join("");
  return `<div class="pmk-logview"><header class="pmk-shead">${back()}<h2>${Lh("TradeLog")}</h2></header>
    <div class="pmk-gmbar"><span class="pmk-dim">${Lh(log.length === 1 ? "TradesOne" : "TradesMany", { n: log.length })}</span><span class="pmk-gap"></span>
    ${log.length ? `<button type="button" data-action="pmkClearLog">${icon("fa-trash")} ${Lh("ClearLog")}</button>` : ""}</div>
    <div data-keep-scroll="log">${rows || `<p class="pmk-none">${Lh("NoTrades")}</p>`}</div></div>`;
}

/** A market's vault page: the chosen character's vault and their own things, to deposit and withdraw; the GM sees
 * every character's vault here. */
function vaultHTML(app, market) {
  if (!market?.vaults) return `<div class="pmk-vaultview"><header class="pmk-shead">${back()}</header><p class="pmk-none">${Lh("NoVaultsHere")}</p></div>`;
  const head = `<header class="pmk-shead">${btn("pmk-back", `data-action="pmkBack"`, `${icon("fa-arrow-left")} ${esc(market.name)}`)}<h2>${Lh("VaultsAt", { market: market.name })}</h2></header>`;
  const fee = market.vaultFee ? `<p class="pmk-hint">${Lh("VaultFeeEach", { amount: fmt(market.vaultFee) })}</p>` : "";
  if (app.isGM) {
    const all = vaultsAt(market.id);
    const cards = all.map((v) => {
      const owner = game.actors.get(v.flags[MOD].vault.owner);
      const items = tradeRows(v).map((r) => named(r.name, r.qty));
      return `<div class="pmk-offer"><div class="pmk-ohead"><img src="${esc(owner?.img ?? v.img)}" alt=""><strong>${esc(owner?.name ?? v.name)}</strong><span class="pmk-dim">${esc(fmt(fundsCp(v), "NoMoney"))}</span><span class="pmk-gap"></span>
        <button type="button" data-action="pmkVaultSheet" data-id="${esc(v.id)}">${icon("fa-file-invoice")} ${Lh("OpenSheet")}</button></div>
        <p>${esc(items.length ? listOf(items) : L("VaultNoItems"))}</p></div>`;
    }).join("");
    return `<div class="pmk-vaultview">${head}${fee}${cards || `<p class="pmk-none">${Lh("NoVaultsYet")}</p>`}</div>`;
  }
  const users = vaultUsersFor(game.user);
  const me = users.find((a) => a.id === app.view.vaultAs) ?? users.find((a) => a.id === game.user.character?.id) ?? users[0] ?? null;
  if (!me) return `<div class="pmk-vaultview">${head}<p class="pmk-none">${Lh("NoCharacter")}</p></div>`;
  const vault = vaultOf(market.id, me.id);
  const open = canTrade(market, false);
  const wait = posting() || waitingFor("vault");
  const picked = app.view.vaultPick ?? { dep: {}, wd: {}, depCp: 0, wdCp: 0 };
  const rows = (actor, key, chosen) => (actor ? tradeRows(actor) : []).map((r) => `<div class="pmk-srow ${r.why ? "pmk-no" : ""}">
      <img src="${esc(r.img)}" alt=""><span class="pmk-rn">${esc(r.name)}${r.why || r.parts ? `<span class="pmk-note">${esc(r.why ?? L("WholeStack"))}</span>` : ""}</span>
      <span class="pmk-qty">×${r.qty}</span>
      ${r.why || !open ? "<span></span>" : `<input type="number" class="pmk-qtyin" name="${key}" data-item="${esc(r.id)}" value="${chosen[r.id] ?? 0}" min="0" max="${r.qty}" step="${r.parts ? r.qty : 1}" aria-label="${Lh("HowMany", { name: r.name })}">`}
      <span></span><span></span></div>`).join("");
  const coinsIn = (name, value) => `<label class="pmk-buyer">${Lh("CoinsGp")} <input type="number" name="${name}" value="${value ? value / 100 : ""}" min="0" step="0.01" placeholder="0"></label>`;
  const as = users.length > 1 ? `<label class="pmk-buyer">${Lh("TradingAs")} <select name="pmk-vaultas">${users.map((a) => `<option value="${esc(a.id)}" ${a.id === me.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label>` : "";
  return `<div class="pmk-vaultview">${head}${as}${fee}
    ${open ? "" : `<p class="pmk-status">${icon("fa-store-slash")} ${Lh("VaultClosedNow")}</p>`}
    <h3 class="pmk-h">${icon("fa-vault")} ${Lh("InVault", { name: me.name })} <span class="pmk-dim">${esc(fmt(vault ? fundsCp(vault) : 0, "NoMoney"))}</span></h3>
    <div class="pmk-stock">${rows(vault, "v-wd", picked.wd) || `<p class="pmk-none">${Lh("VaultNoItems")}</p>`}</div>
    ${open && vault ? `${coinsIn("v-wdcp", picked.wdCp)}<div class="pmk-checkout">${wait ? `<button type="button" disabled>${icon("fa-hourglass-half")} ${Lh("Waiting")}</button>` : `<button type="button" data-action="pmkVaultGo" data-op="withdraw">${icon("fa-upload")} ${Lh("Withdraw")}</button>`}</div>` : ""}
    <h3 class="pmk-h">${icon("fa-user")} ${Lh("NameCarries", { name: me.name })} <span class="pmk-dim">${esc(fmt(fundsCp(me), "NoMoney"))}</span></h3>
    <div class="pmk-stock">${rows(me, "v-dep", picked.dep) || `<p class="pmk-none">${Lh("NothingToTrade")}</p>`}</div>
    ${open ? `${coinsIn("v-depcp", picked.depCp)}<div class="pmk-checkout">${wait ? `<button type="button" disabled>${icon("fa-hourglass-half")} ${Lh("Waiting")}</button>` : `<button type="button" data-action="pmkVaultGo" data-op="deposit">${icon("fa-download")} ${Lh(market.vaultFee ? "DepositFee" : "Deposit", { amount: fmt(market.vaultFee) })}</button>`}</div>` : ""}
  </div>`;
}

/** Read the vault page's choices into the view. */
function readVault(app) {
  const el = app.element;
  if (!el?.querySelector(".pmk-vaultview")) return;
  const qtys = (key) => Object.fromEntries([...el.querySelectorAll(`input[name="${key}"]`)].map((i) => [i.dataset.item, Math.max(0, Math.floor(Number(i.value)) || 0)]).filter(([, n]) => n > 0));
  const cp = (name) => Math.max(0, Math.round((Number(el.querySelector(`[name="${name}"]`)?.value) || 0) * 100));
  app.view.vaultPick = { dep: qtys("v-dep"), wd: qtys("v-wd"), depCp: cp("v-depcp"), wdCp: cp("v-wdcp") };
}

export { cartHTML, draftHTML, logHTML, postHTML, readDraft, readVault, vaultHTML, marketById };
