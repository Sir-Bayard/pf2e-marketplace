import { esc } from "./kit/safe-text.mjs";
import { storage } from "./kit/storage.mjs";
import { formatCp as formatCoins, listOf as listWords } from "./helpers.mjs";

/**
 * PF2e Marketplace: what every part of the module shares. A marketplace window over PF2e's own merchants: markets
 * (a name, picture, description and the shops in them), browsed without opening merchant sheets. Shops stay ordinary
 * PF2e merchant loot actors, so they keep working as merchant sheets without the module.
 */

const MOD = "pf2e-marketplace";
const SOCKET = `module.${MOD}`;
/** PF2e Campaign Trackers, whose reputation trackers can move a market's prices. */
const TRACKERS = "pf2e-campaign-trackers";
const DialogV2 = () => foundry.applications.api.DialogV2;
const TextEditor = () => foundry.applications.ux.TextEditor.implementation;
/** Browser storage, per world and user. */
const store = storage(MOD);

/** Display text from lang/<language>.json: L("Key") or L("Key", { name }) with {name} in the text. Values aren't
 * escaped: escape what goes into HTML or a notice. Before Foundry's translations are loaded it gives the key back. */
const L = (key, data) => {
  const i18n = globalThis.game?.i18n;
  const k = `PMK.${key}`;
  if (!i18n?.translations || !Object.keys(i18n.translations).length) return k;
  return data ? i18n.format(k, data) : i18n.localize(k);
};

/** L with every value escaped, for HTML and notices (Foundry's notices keep markup). */
const Lh = (key, data) => (data ? L(key, Object.fromEntries(Object.entries(data).map(([k, v]) => [k, esc(v)]))) : esc(L(key)));

/** A notice: "Marketplace: " and the text for `key`, its values escaped. */
const notice = (level, key, data, opts) => ui.notifications[level](`${esc(L("Prefix"))}${Lh(key, data)}`, opts);

/** Coin names as the PF2e system writes them in this language. */
const coinUnits = () => {
  const i18n = globalThis.game?.i18n;
  const one = (c) => {
    const k = `PF2E.CurrencyAbbreviations.${c}`;
    const v = i18n?.localize?.(k);
    return v && v !== k ? v : c;
  };
  return { gp: one("gp"), sp: one("sp"), cp: one("cp") };
};
const lang = () => globalThis.game?.i18n?.lang || "en";

/** Copper as coins for showing, in this language ("12 gp 5 sp"); `zero` when there's none (a key of this module). */
const fmt = (cp, zero = "Free") => formatCoins(cp, L(zero), { units: coinUnits(), locale: lang() });
/** "Longsword, arrows and chain mail", in this language. */
const listOf = (names) => listWords(names, lang());

export { MOD, SOCKET, TRACKERS, DialogV2, TextEditor, store, L, Lh, notice, fmt, listOf };
