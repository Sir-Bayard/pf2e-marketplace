import { pf2eRules } from "./kit/pf2e-rules.mjs";
import { MOD } from "./constants.mjs";
import { formulaPrice as formulaFrom, purseFor as purseFrom } from "./helpers.mjs";

/**
 * The rules numbers this module uses, read from the PF2e system at run time (the kit's reader): the party treasure
 * table for shop purses and formula prices, and the DCs by level for haggling. No copy of any table is kept in the
 * module: when the system can't be read, the GM is told once and the features that need it switch themselves off
 * (Fill purse, prices worked out for formulas, haggling); everything else goes on as before.
 */
const rules = pf2eRules({ module: MOD, title: "PF2e Marketplace", tables: ["partyTreasure", "dcsByLevel"] });

/** Party treasure for a level (1 to 20), total value in gp, or null. */
const treasureGp = (level) => rules.partyTreasure(level)?.total ?? null;
/** The currency each additional character gets at a level (1 to 20), in gp, or null. */
const perPCGp = (level) => rules.partyTreasure(level)?.perPC ?? null;

/** Can shop purses and formula prices be worked out (the treasure table was read)? */
const treasureOk = () => rules.get("partyTreasure").ok;
/** Can haggling find its DC (the DCs by level table was read)? */
const dcsOk = () => rules.get("dcsByLevel").ok;

/** A shop's full purse in copper for its level and the world's purse setting, or null when the table can't be read. */
const purseFor = (level, scalePct) => purseFrom(level, treasureGp, scalePct);
/** A formula's price in copper, or null when the table can't be read. */
const formulaPrice = (level, rarity, mults) => formulaFrom(level, rarity, mults, perPCGp);
/** The DC for a level (the system's table runs from 0: a level -1 shop uses 0's), or null. */
const dcFor = (level) => rules.dcByLevel(Math.max(0, Math.min(25, Math.round(Number(level) || 0))));

export { rules, treasureOk, dcsOk, purseFor, formulaPrice, dcFor };
