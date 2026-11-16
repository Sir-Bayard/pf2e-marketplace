/**
 * PF2e Marketplace: the entry point. Settings, hooks, the API, journal links, and opening a shop from its token.
 * A marketplace window over PF2e's own merchants: markets (a name, picture, description and the shops in them),
 * browsed without opening merchant sheets. Shops stay ordinary PF2e merchant loot actors, so they keep working as
 * merchant sheets without the module.
 */
import { AMOUNTS, AMOUNT_DEFAULTS, ATTITUDES, FORMULA_MULT_DEFAULTS, HAGGLE_DEFAULTS, HAGGLE_DEGREES, PRICE_DEFAULTS, canSee, logBetween } from "./helpers.mjs";
import { isMerchant, sellable } from "./pf2e.mjs";
import { esc } from "./kit/safe-text.mjs";
import { L, MOD, SOCKET, notice, store } from "./constants.mjs";
import { marketById, shopsFor, store as markets, syncReputation } from "./data.mjs";
import { openMarket } from "./app.mjs";
import { refresh, showsActor, showsLog } from "./refresh.mjs";
import { onSocket, tabs } from "./requests.mjs";
import { haggleTag, recordHaggle } from "./haggle.mjs";
import { queued } from "./trade.mjs";
import { dcsOk, rules, treasureOk } from "./rules.mjs";
import { checkSchedules, markStaples } from "./stock.mjs";

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

function registerSettings() {
  const world = (key, data) => game.settings.register(MOD, key, { scope: "world", config: true, onChange: () => refresh(), ...data });
  game.settings.register(MOD, "store", { scope: "world", config: false, type: Object, default: { markets: [] }, onChange: () => refresh() });
  game.settings.register(MOD, "log", { scope: "world", config: false, type: Array, default: [], onChange: () => refresh(showsLog) });
  game.settings.register(MOD, "offers", { scope: "world", config: false, type: Array, default: [], onChange: () => refresh() });
  // Picked in the window's menu, beside the looks.
  game.settings.register(MOD, "sheetColor", { scope: "client", config: false, type: String, default: "red", onChange: () => refresh() });
  world("openFromToken", { name: "PMK.Setting.OpenFromToken", hint: "PMK.Setting.OpenFromTokenHint", type: Boolean, default: true });
  world("receipts", { name: "PMK.Setting.Receipts", hint: "PMK.Setting.ReceiptsHint", type: String, default: "whisper",
    choices: { off: "PMK.Setting.ReceiptsOff", whisper: "PMK.Setting.ReceiptsWhisper", public: "PMK.Setting.ReceiptsPublic" } });
  for (const a of AMOUNTS) world(`amount-${a}`, { name: `PMK.Setting.Amount.${a}`, hint: a === "few" ? "PMK.Setting.AmountHint" : "", type: String, default: AMOUNT_DEFAULTS[a] });
  world("stackRange", { name: "PMK.Setting.StackRange", hint: "PMK.Setting.StackRangeHint", type: String, default: "1-4" });
  world("purseScale", { name: "PMK.Setting.PurseScale", hint: "PMK.Setting.PurseScaleHint", type: Number, default: 100, range: { min: 10, max: 500, step: 10 } });
  for (const r of ["uncommon", "rare"]) world(`formula-${r}`, { name: `PMK.Setting.Formula.${r}`, hint: `PMK.Setting.Formula.${r}Hint`, type: Number, default: FORMULA_MULT_DEFAULTS[r], range: { min: 1, max: 20, step: 1 } });
  world("hostileRefuses", { name: "PMK.Setting.HostileRefuses", hint: "PMK.Setting.HostileRefusesHint", type: Boolean, default: true });
  for (const a of ATTITUDES) world(`price-${a}`, { name: `PMK.Setting.Price.${a}`, hint: a === "indifferent" ? "PMK.Setting.PriceHintFirst" : "PMK.Setting.PriceHint", type: Number, default: PRICE_DEFAULTS[a], range: { min: -90, max: 200, step: 5 } });
  world("haggling", { name: "PMK.Setting.Haggling", hint: "PMK.Setting.HagglingHint", type: Boolean, default: true });
  for (const d of HAGGLE_DEGREES) world(`haggle-${d}`, { name: `PMK.Setting.Haggle.${d}`, hint: d === "criticalSuccess" ? "PMK.Setting.HaggleHint" : "", type: Number, default: HAGGLE_DEFAULTS[d], range: { min: -50, max: 50, step: 5 } });
}

/* ------------------------------------------------------------------ */
/* Opening a shop                                                     */
/* ------------------------------------------------------------------ */

/** A market this user can see that holds the shop, or null. */
function marketHolding(shopId) {
  return markets().markets.find((m) => canSee(m, game.user.isGM) && shopsFor(m).some((s) => s.id === shopId)) ?? null;
}

/** Open the window at a shop, from a token, a sheet or a link. False when the user can't see it in any market. */
function openShop(actor) {
  const market = actor && isMerchant(actor) ? marketHolding(actor.id) : null;
  if (!market) return false;
  openMarket(market.id, actor.id).then((app) => app?.focusWindow?.());
  return true;
}

/** Does a double-click on this merchant open its shop rather than its sheet (players, with the world setting on)? */
const opensShop = (actor) => !game.user.isGM && game.settings.get(MOD, "openFromToken") && isMerchant(actor) && !actor.isToken && !!marketHolding(actor.id);

/** Players: a merchant's token or sheet opens the shop (the world setting, on by default). */
function wireOpenFromToken() {
  const Tok = CONFIG.Token?.objectClass;
  const orig = Tok?.prototype?._onClickLeft2;
  if (typeof orig === "function") {
    Tok.prototype._onClickLeft2 = function (event) {
      // Only a token that is the world's merchant (linked): an unlinked copy has its own stock.
      if (this.document?.actorLink && opensShop(this.actor)) return void openShop(this.actor);
      return orig.call(this, event);
    };
  }
  // The sheet opened another way (the Actors tab, a link): close it and show the shop.
  Hooks.on("renderActorSheet", (sheet) => {
    const actor = sheet.actor ?? sheet.document;
    if (!opensShop(actor)) return;
    // After the render that fired this hook: a close asked for during it is ignored.
    setTimeout(() => sheet.close(), 0);
    openShop(actor);
  });
}

/** A button on a merchant token's HUD that opens its shop (in practice the GM's: players rarely control a merchant). */
function addHudButton(hud, html) {
  const actor = hud.object?.actor ?? hud.document?.actor;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || !isMerchant(actor) || actor.isToken || !marketHolding(actor.id)) return;
  const col = root.querySelector(".col.right") ?? root.querySelector(".col.left");
  if (!col || col.querySelector(".pmk-hud")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "control-icon pmk-hud";
  btn.setAttribute("aria-label", L("OpenShop"));
  btn.dataset.tooltipText = L("OpenShop");
  btn.innerHTML = `<i class="fa-solid fa-store" aria-hidden="true"></i>`;
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openShop(actor);
  });
  col.append(btn);
}

/** A Marketplace button at the top of the Actors tab. */
function addDirectoryButton(app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector(".pmk-open")) return;
  const bar = root.querySelector(".header-actions") ?? root.querySelector(".directory-header");
  if (!bar) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pmk-open";
  btn.innerHTML = `<i class="fa-solid fa-store" aria-hidden="true"></i> ${esc(L("Title"))}`;
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    openMarket().then((app) => app?.focusWindow?.());
  });
  bar.append(btn);
}

/* ------------------------------------------------------------------ */
/* Journal links: @Shop[id]{label} and @Market[id]{label}             */
/* ------------------------------------------------------------------ */

const LINK = /@(Shop|Market)\[([A-Za-z0-9]{1,32})\](?:\{([^}]{1,120})\})?/g;

function registerEnricher() {
  CONFIG.TextEditor.enrichers.push({
    id: `${MOD}-links`,
    pattern: LINK,
    enricher: async (match) => {
      const [, kind, id, label] = match;
      const name = label || (kind === "Shop" ? game.actors.get(id)?.name : marketById(id)?.name) || L(kind === "Shop" ? "UnknownShop" : "UnknownMarket");
      const a = document.createElement("a");
      a.className = "pmk-link";
      a.dataset.pmkKind = kind;
      a.dataset.pmkId = id;
      a.setAttribute("role", "button");
      a.tabIndex = 0;
      a.innerHTML = `<i class="fa-solid ${kind === "Shop" ? "fa-shop" : "fa-landmark"}" aria-hidden="true"></i> ${esc(name)}`;
      return a;
    },
  });
  const follow = (link) => {
    const id = link.dataset.pmkId;
    if (link.dataset.pmkKind === "Market") {
      const m = marketById(id);
      if (!m || !canSee(m, game.user.isGM)) return void notice("info", "LinkNotVisible");
      return void openMarket(m.id).then((app) => app?.focusWindow?.());
    }
    if (!openShop(game.actors.get(id))) notice("info", "LinkNotVisible");
  };
  document.addEventListener("click", (ev) => {
    const link = ev.target?.closest?.("a.pmk-link[data-pmk-id]");
    if (!link) return;
    ev.preventDefault();
    follow(link);
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const link = ev.target?.closest?.("a.pmk-link[data-pmk-id]");
    if (!link) return;
    ev.preventDefault();
    follow(link);
  });
}

/* ------------------------------------------------------------------ */
/* Hooks                                                              */
/* ------------------------------------------------------------------ */

Hooks.once("init", () => {
  registerSettings();
  registerEnricher();
  game.keybindings.register(MOD, "open", {
    name: "PMK.Setting.Hotkey",
    hint: "PMK.Setting.HotkeyHint",
    editable: [],
    onDown: () => {
      openMarket().then((app) => app?.focusWindow?.());
      return true;
    },
  });
});

Hooks.once("setup", () => {
  // The look was kept as a bare word before the kit's storage (which keeps JSON): carry it over once.
  try {
    const key = store.key("look");
    const raw = key ? globalThis.localStorage?.getItem(key) : null;
    if (raw && ["dark", "hybrid", "pf2e"].includes(raw)) store.set("look", raw);
  } catch {
    /* storage off */
  }
});

Hooks.once("ready", () => {
  game.modules.get(MOD).api = {
    /** Open the window, at a market and a shop if given. Resolves to the window. */
    open: (marketId = null, shopId = null) => openMarket(marketId, shopId),
    /** The markets, as stored. */
    markets: () => markets().markets,
    /** Redraw any open Marketplace window. */
    refresh: () => refresh(),
    /** The GM tab election, for checking from the console. */
    gmTabInfo: () => tabs.info(),
    /** The trade log from `from` to `to` (Date.now milliseconds, either may be left out), oldest first. GMs only. */
    trades: ({ from = null, to = null } = {}) => (game.user.isGM ? logBetween(game.settings.get(MOD, "log"), from, to) : []),
  };
  // The socket handler first, so no answer is missed, then the tab election.
  game.socket.on(SOCKET, onSocket);
  tabs.start();
  // The rules tables: once read, anything priced from them is drawn again.
  Promise.resolve(rules.load()).then(() => {
    refresh();
    // The kit tells only GMs; a player whose read failed tells the GM, whose own read may have worked.
    if (!game.user.isGM && (!treasureOk() || !dcsOk())) game.socket.emit(SOCKET, { type: "rulesfail", treasure: !treasureOk(), dcs: !dcsOk() });
  }).catch((err) => console.error(`${MOD} | reading the rules tables failed`, err));
  wireOpenFromToken();
  const dir = ui.actors;
  if (dir?.element) addDirectoryButton(dir, dir.element);
  // Merchants stocked elsewhere or while the module was off: every unmarked shop item becomes a staple. Then timed
  // restocks catch up. Only the lead GM tab (leadNow waits out its first moments).
  tabs.leadNow().then(async (lead) => {
    if (!lead) return;
    const shops = [...new Set(markets().markets.flatMap((m) => shopsFor(m).map((s) => s.id)))].map((id) => game.actors.get(id)).filter(isMerchant);
    await markStaples(shops).catch((err) => console.error(`${MOD} | marking staples failed`, err));
    await syncReputation().catch((err) => console.warn(`${MOD} | couldn't read a reputation`, err));
    checkSchedules();
  });
});

Hooks.on("renderActorDirectory", addDirectoryButton);
Hooks.on("renderTokenHUD", addHudButton);

/* Anything that changes what a shop or market shows redraws the window. */
const lootActor = (a) => a?.type === "loot";
for (const hook of ["createActor", "updateActor", "deleteActor"]) Hooks.on(hook, (a) => {
  if (lootActor(a)) refresh();
});

// An item change redraws only windows that show its actor (the shop on screen, the chosen trader, the cart's shops).
for (const hook of ["createItem", "updateItem", "deleteItem"]) Hooks.on(hook, (item) => {
  const a = item.parent;
  if (a && (lootActor(a) || ((a.type === "character" || a.type === "party") && a.isOwner))) refresh(showsActor(a.id));
});

// Anything put in a merchant without a stock mark (the GM dragging it in, or PF2e's own sheet) is a staple that comes
// back to its quantity on a restock. Set on the creating client, before the item exists.
Hooks.on("preCreateItem", (item, data) => {
  if (!isMerchant(item.parent)) return;
  // Shops sell identified goods: an unidentified item put in a shop is identified there.
  if (data?.system?.identification?.status && data.system.identification.status !== "identified") item.updateSource({ "system.identification.status": "identified" });
  if (data?.flags?.[MOD]?.stock || !sellable(item)) return;
  item.updateSource({ [`flags.${MOD}.stock`]: { kind: "staple", qty: Math.max(0, Number(data?.system?.quantity ?? item.quantity ?? 1) || 0) } });
});

// A shopkeeper's attitude changing (PF2e NPC Attitudes) changes prices.
Hooks.on("updateActor", (a, change) => {
  if (a?.type === "npc" && change?.flags?.["pf2e-npc-attitudes"]) refresh();
});

// A reputation changing in PF2e Campaign Trackers can change a market's prices (its data lives on a journal entry):
// the lead GM tab copies each linked market's tier onto the market, which every client prices from.
Hooks.on("updateJournalEntry", (j, change) => {
  if (change?.flags?.["pf2e-campaign-trackers"] && tabs.isLead()) syncReputation().catch((err) => console.warn(`${MOD} | couldn't read a reputation`, err));
});

// A haggle roll reaching chat is recorded by the lead GM tab (the first one at that shop until its next restock).
Hooks.on("createChatMessage", (message) => {
  if (!game.user.isGM || !haggleTag(message)) return;
  // leadNow waits out a hand-over between tabs; two tabs recording the same first roll write the same thing.
  tabs.leadNow().then((lead) => lead && queued(() => recordHaggle(message))).catch((err) => console.error(`${MOD} | a haggle couldn't be recorded`, err));
});

// Players logging in or out changes whether a GM is there to trade with.
Hooks.on("userConnected", () => refresh());
Hooks.on("updateWorldTime", () => checkSchedules());
for (const hook of ["createFolder", "updateFolder", "deleteFolder"]) Hooks.on(hook, (f) => {
  if (f.type === "Actor") refresh();
});
