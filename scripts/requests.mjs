import { gmTabs } from "./kit/gm-tabs.mjs";
import { esc } from "./helpers.mjs";
import { fundsCp } from "./pf2e.mjs";
import { L, MOD, SOCKET, notice } from "./constants.mjs";
import { buyerChoices, loadCart, salesOf, tradeState } from "./data.mjs";
import { processAccept, processPost, processWithdraw } from "./post.mjs";
import { openApps, refresh } from "./refresh.mjs";
import { Refused, clearTraded, gmNotice, processTrade, queued, tradeText } from "./trade.mjs";
import { processVault } from "./vault.mjs";

/* How long things wait, in one place. */
const TIMES = {
  /** A request the GM's client hasn't answered: the button stops waiting and the user is told. */
  answer: 30000,
  /** An answer that comes after that still counts this long. */
  late: 600000,
  /** After a timed-out trade, Checkout stays off this long (a second click could be the same trade twice). */
  busyAfter: 120000,
  /** Requests already handled are remembered this long, so a repeated message isn't done twice. */
  handled: 600000,
};

/* One GM in two tabs must not handle a request twice: the kit's tab election. */
const tabs = gmTabs(MOD);
const isPrimaryGM = () => game.user.isGM && game.users.activeGM?.id === game.user.id;

/** Requests waiting for the GM's answer (rid: { kind, gm, timer }). While one is out, that button waits: a second
 * click would be a second trade. An answer that comes after the timeout still counts (`late`). */
const pending = new Map();
const late = new Map();
const waitingFor = (kind) => [...pending.values()].some((p) => p.kind === kind);

/** Send a request to the active GM's client. Returns its id, or false when no GM is there. */
function askGM(msg) {
  if (!game.users.activeGM) {
    notice("warn", "NeedGM");
    return false;
  }
  const rid = foundry.utils.randomID(16);
  const gm = game.users.activeGM.id;
  pending.set(rid, { kind: msg.type, gm, timer: setTimeout(() => {
    pending.delete(rid);
    late.set(rid, { kind: msg.type, gm, t: Date.now() });
    setTimeout(() => {
      late.delete(rid);
      refresh();
    }, TIMES.late);
    notice("warn", "GMNotAnswered");
    refresh();
  }, TIMES.answer) });
  game.socket.emit(SOCKET, { ...msg, rid });
  refresh();
  return rid;
}

/** Is this an answer to one of this client's requests, from the GM who was asked or the primary GM now? (The primary
 * GM can change while a request is in hand; the asked GM's client still answers it.) */
function answered(rid, from) {
  const p = rid ? (pending.get(rid) ?? late.get(rid)) : null;
  if (!p || (from !== p.gm && from !== game.users.activeGM?.id)) return false;
  if (pending.has(rid)) {
    clearTimeout(p.timer);
    pending.delete(rid);
  } else late.delete(rid);
  return true;
}

/** Requests already taken (sender.rid: this tab's mark, or when another tab claimed it), so a repeated message isn't a
 * second trade. */
const handled = new Map();
const CLIENT = globalThis.foundry?.utils?.randomID?.(8) ?? String(Math.random()).slice(2, 10);
async function takeRequest(msg, sender) {
  const rid = typeof msg.rid === "string" ? msg.rid.slice(0, 40) : "";
  if (!rid) return;
  const key = `${sender.id}.${rid}`;
  const now = Date.now();
  for (const [k, t] of handled) if (now - (typeof t === "number" ? t : Number(String(t).split(".")[1])) > TIMES.handled) handled.delete(k);
  if (handled.has(key)) return;
  // The lead tab of the active GM takes it (waiting out a hand-over between tabs).
  if (!(await tabs.leadNow())) return;
  // Another of this GM's tabs may have taken it while this one waited, or while it was stalled: its claim may still
  // be among the messages this tab hasn't handled yet, so give them a moment before looking again.
  if (handled.has(key)) return;
  const mine = `${CLIENT}.${now}`;
  handled.set(key, mine);
  game.socket.emit(SOCKET, { type: "claim", key });
  await new Promise((r) => setTimeout(r, 250));
  if (handled.get(key) !== mine) return;
  onRequest(msg, sender);
}

/* What each kind of request runs on the GM's client, in the trade queue. */
const POST_TYPES = new Set(["post", "withdraw", "accept"]);
const RUN = {
  post: processPost,
  withdraw: processWithdraw,
  accept: processAccept,
  vault: processVault,
};
const KINDS = new Set(["trade", ...Object.keys(RUN)]);

/** A refusal's words, for a notice: what the key names in the language file, values escaped by notice(). */
const refusedNotice = (err) => notice("warn", err.key, err.data);

/** A request run on this client because it's the primary GM's (Trade Post, vault): no message needed. */
let working = false;
async function localRequest(msg) {
  if (working || waitingFor(msg.type)) return;
  if (isPrimaryGM()) {
    working = true;
    refresh();
    try {
      const r = await queued(() => RUN[msg.type](msg, game.user));
      if (r?.say) notice("info", r.say.key, r.say.data);
      if (r?.posted) for (const app of openApps) app.view.draft = null;
    } catch (err) {
      if (err instanceof Refused) refusedNotice(err);
      else {
        console.error(`${MOD} | the ${msg.type} request failed`, err);
        notice("error", "DidntWork");
      }
    } finally {
      working = false;
      refresh();
    }
    return;
  }
  askGM(msg);
}
/** The Trade Post or a vault: the primary GM acts at once; anyone else asks the GM's client. */
const postRequest = localRequest;

/** The active GM's client acts on a player's request. */
async function onRequest(msg, sender) {
  const reply = (extra) => game.socket.emit(SOCKET, { users: [sender.id], rid: typeof msg.rid === "string" ? msg.rid : null, ...extra });
  try {
    if (RUN[msg.type]) {
      const r = await queued(() => RUN[msg.type](msg, sender));
      reply({ type: "done", what: msg.type, say: r?.say ?? null, unpaid: !!r?.unpaid });
      if (msg.type === "accept" && r?.say) {
        const text = `${L("Prefix")}${sender.name}: ${L(r.say.key, r.say.data)}${r.unpaid ? ` ${L("CheckMoney", { note: r.unpaid })}` : ""}`;
        ui.notifications[r.unpaid ? "warn" : "info"](esc(text), r.unpaid ? { permanent: true } : {});
      }
      return;
    }
    if (msg.type !== "trade") return;
    const r = await queued(() => processTrade(msg, sender));
    const { lines, sales, note, ...result } = r;
    reply({ type: "done", result: { ...result, unpaid: !!r.unpaid }, lines, sales });
    gmNotice(r, `${sender.name}: `);
  } catch (err) {
    if (err instanceof Refused) return reply({ type: "fail", key: err.key, data: err.data });
    console.error(`${MOD} | a player's request failed`, err);
    reply({ type: "fail", key: "FailedPartway", data: { error: String(err?.message ?? err) } });
    notice("error", "PlayerTradeFailed", { name: sender.name });
  }
}

/** Socket messages: the GM's lead tab takes players' requests; a player's client takes the GM's answers. Foundry
 * passes the sender's id. */
function onSocket(msg, senderId) {
  if (!msg?.type) return;
  if (tabs.handle(msg, senderId)) return;
  const sender = game.users.get(senderId);
  if (game.user.isGM) {
    // A tab of the same GM took a request: this one won't take it too.
    if (msg.type === "claim" && sender?.id === game.user.id && typeof msg.key === "string") return void handled.set(msg.key, Date.now());
    // A player's client couldn't read the system's rules tables: tell the GM (who may have read them fine).
    if (msg.type === "rulesfail" && sender && !sender.isGM && tabs.isLead()) return void notice("warn", msg.treasure && msg.dcs ? "PlayerRulesFailed" : msg.treasure ? "PlayerTreasureFailed" : "PlayerDCsFailed", { name: sender.name });
    if (sender && sender.id !== game.user.id && KINDS.has(msg.type)) takeRequest(msg, sender);
    // An assistant GM's own trades go through the primary GM's client too, and come back like a player's.
    if (msg.type !== "done" && msg.type !== "fail" && msg.type !== "notice") return;
  }
  if (!sender?.isGM) return;
  if (Array.isArray(msg.users) && !msg.users.includes(game.user.id)) return;
  // Requests are handled on the primary GM's client, so notices come only from it.
  if (msg.type === "notice") {
    if (sender.id === game.users.activeGM?.id && msg.say?.key) notice("info", String(msg.say.key), msg.say.data ?? {});
    return;
  }
  if (msg.type !== "done" && msg.type !== "fail") return;
  // Only answers to this client's own requests (a GM answers the user, who may have two windows open).
  if (!answered(msg.rid, sender.id)) return;
  refresh();
  if (msg.type === "fail") return void notice("warn", String(msg.key ?? "DidntWork"), msg.data ?? {});
  if (msg.what === "post") for (const app of openApps) app.view.draft = null;
  if (msg.result) {
    clearTraded(msg.lines, msg.sales);
    const text = tradeText(msg.result) + (msg.result.unpaid ? ` ${L("MoneyDidntArrive")}` : "");
    notice("info", "Raw", { text });
  } else if (msg.say?.key) notice("info", String(msg.say.key), { ...(msg.say.data ?? {}) });
  if (msg.unpaid) notice("warn", "MoneyDidntArrive");
}

/** A trade from this client is under way. */
let trading = false;

/**
 * Make the trade in the cart: a GM at once; a player asks the GM's client. `seen` is { buy, sell } as the Pay button
 * showed them: a cart changed since (a quantity typed a moment ago) isn't traded until the player has seen the new
 * total.
 */
async function checkout(seen = null) {
  if (busy()) return;
  const cart = loadCart();
  const { chosen } = buyerChoices(cart);
  if (!chosen) return void notice("warn", "NoCharacter");
  const t = tradeState(cart, chosen);
  if (t.empty) return;
  const bad = [...t.buys, ...t.sales].find((l) => l.problem);
  if (bad) return void notice("warn", "FixCartFirst", { problem: bad.problem });
  if (t.short.size) return void notice("warn", "Raw", { text: [...t.short.values()][0] });
  if (t.net > fundsCp(chosen)) return void notice("warn", "NotEnoughMoney", { name: chosen.name });
  if (seen && (seen.buy !== t.buy || seen.sell !== t.sell)) {
    refresh();
    return void notice("info", "CartChanged");
  }
  const msg = { type: "trade", trader: chosen.id, lines: cart.lines, sales: salesOf(cart, chosen), buy: t.buy, sell: t.sell };
  // Only the primary GM trades on their own client; an assistant GM's trade goes through it like a player's, in its queue.
  if (isPrimaryGM()) {
    trading = true;
    refresh();
    try {
      const r = await queued(() => processTrade(msg, game.user));
      clearTraded(r.lines, r.sales);
      gmNotice(r);
    } catch (err) {
      if (err instanceof Refused) refusedNotice(err);
      else {
        console.error(`${MOD} | the trade failed`, err);
        notice("error", "TradeFailedPartway");
      }
    } finally {
      trading = false;
      refresh();
    }
    return;
  }
  askGM(msg);
}

/** A trade is under way: this client's own, one still waiting for the GM, or one that timed out a short while ago (a
 * second click then could be the same trade twice). */
const busy = () => trading || waitingFor("trade") || [...late.values()].some((l) => l.kind === "trade" && Date.now() - l.t < TIMES.busyAfter);
/** A Trade Post or vault request from this client is under way. */
const posting = () => working;

export { POST_TYPES, TIMES, busy, checkout, isPrimaryGM, onSocket, postRequest, posting, tabs, trading, waitingFor };
