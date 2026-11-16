# Changelog

## 1.0.0

Features, keyboard access, translations, and rules read from the system.

- **Rules read from the PF2e system**: the party treasure by level (for shop purses) and the DCs by level (for haggling) come from the system's GM Screen journal each time the world loads; the module keeps no copy. Formula prices are worked out from the same treasure table (a tenth of the currency per additional character at that level, in whole gold; half of level 1 at level 0). If a system update moves them, the GM is told once and Fill purse, prices worked out for formulas and haggling switch off; drawn formula lines are skipped with a notice.
- **Haggling**: once per shop until its next restock, a character rolls Diplomacy against the DC for the shop's level; the GM's client records the first such roll. A critical success takes 20% off what they pay there, a success 10%, a critical failure adds 10% (world settings; for buying, and as with attitude a shop never pays more for goods than it would charge).
- **Market prices**: a price change for every shop in a market, with a line saying why.
- **Reputation**: a market can follow a reputation tracker in PF2e Campaign Trackers, each tier moving prices there by a percent.
- **Vaults**: each character's own storage at a market, reached only from that market while it's open, with an optional fee per deposit.
- **Services**: things a shop does rather than sells (lodging, a crossing), bought with coins like goods.
- **Kinds of shop** (blacksmith, alchemist, general store, magic shop, temple, fence, jeweler) fill in a new shop's rotating stock lines, and **Copy settings from** takes another shop's.
- **Chat receipts** after each trade at a shop: whispered to the trader's owners and the GMs, public, or off.
- **Sort and filter the Buy list**: by name, level or price; only what the character can afford, or up to their level. Prices they can't afford are dimmed.
- **Open a shop from its token**: a player's double-click on a merchant's linked token, or its sheet, opens its shop (a world setting, on by default); a button on the token's HUD does the same for the GM.
- **Journal links**: `@Shop[id]{name}` and `@Market[id]{name}` open a shop or market. Copy link on a shop's card, or drag the card into a journal.
- **Keyboard**: every control is a button, with focus kept across redraws, and every drag has a button that does the same (Add item, Add a merchant, the shopkeeper in Settings, Copy link).
- Visible controls for what right-click did: a sheet button beside each item, a minus beside each add button, a pencil on the GM's stock and formula marks. Right-click still works.
- The Pathfinder sheet look's color is in the window's menu with the looks (no longer a module setting).
- The status and price lines are shorter: "Open for trade" sits in the header, and what makes up a character's prices (attitude, market, reputation, haggle) sits beside Trading as.
- The Trade Post's new-offer form says which items go as their whole stack; the Draw preview prices an entry with parts as its whole stack.
- An API for the trade log by time: `api.trades({ from, to })`.
- Every word the window shows can be translated (`lang/en.json`).
- Under the hood: the code is split into files by job; the window opens once however fast it's asked; it remembers its place with each world and user; the GM's tabs agree on which one answers players; item changes redraw only windows that show that actor; each draw and request works out the shops once. A test runs the trade steps with a failure at each one. The README is shorter, with the whole of it in `docs/guide.md`.
- Needs a server restart after updating (new files and the language file).

## 0.5.1

Fixes.

- **Attached parts are priced in**: an item's price includes what's attached to it (a shield's spikes, a crossbow's attachment, loaded ammunition), as the character sheet counts its worth, when buying and selling. An item that carries parts trades as its whole stack, in shops and at the Trade Post, and is never stacked onto another. A part priced by hand is flagged for the GM like the item itself.
- A Trade Post offer whose item was used or changed after it went up (a charge spent, damage, an edit) can't be accepted until it's posted again. Offers posted before a PF2e update fall back to the earlier check.
- A staple's restock number changes only when the GM sets it (right-click its mark) or drags more onto the shop; a quantity changed on the merchant's sheet, or items moved onto it by other means, no longer raise it.
- A trade writes the trade log once, and only a GM's window showing the log redraws for it.
- Fill purse's amount follows a change to the purse size setting at once.
- Trade answers are taken only from the GM's client that was asked, or the primary GM's.

## 0.5.0

Requests.

- **Requests at the Trade Post**: an offer can give nothing and only ask, for coins from anyone or for coins and items of one character. Another character fills it with Give.
- Opening a shop in a closed market, or showing one in a hidden market, offers to open or show the market too.

## 0.4.0

Formulas.

- **Formulas**: the GM marks a shop item to sell its formula instead. It's priced by item level from the Formula Price table, times 2 for uncommon and 10 for rare (world settings), or at the GM's own price. The shop keeps it; a buyer learns it in the Crafting tab and gets a parchment that weighs nothing. Not for a character who already knows it, nor for the party stash.
- Two new stock lines, **Formulas: alchemical** and **Formulas: any**, draw formulas, one copy each.
- **Drag items onto a shop's page** to stock them, from a compendium, the Items tab or a sheet. One the shop already has as a staple adds to that stack and its number.

## 0.3.0

The Trade Post.

- **Offers between characters**: a character puts up items and coins for coins from anyone, or for coins and items of one character. Accepting swaps everything at once through the GM's client: the items, as they are, and only the difference in coins. Offers aren't held in escrow; they're checked again when accepted, and can be taken down any time. Up to 10 offers per character; the party stash doesn't trade here.
- The GM sees every offer, can remove any, and the trade log lists trades between characters.

## 0.2.0

Stock tools.

- **Staples, rotating stock and sold items**: each item in a shop has a kind, shown to the GM on its line. Staples come back to their number on a restock (anything dragged into a shop is one, existing stock becomes one, and one that sells out stays as sold out); rotating stock is cleared and drawn again; items players sold stay for two restocks by default (a shop setting) and don't stack with the shop's own stock.
- **Rotating stock lines** per shop, from 18 ready filters (weapons, armor, potions, scrolls, runes, worn items, gems and more), each Few, Some, Many, Lots (ranges in the module settings) or an exact number, common only, up to uncommon or up to rare, drawn from the system's compendium up to the shop's level and mostly near it, never something the shop already has. Consumables come in stacks (a setting, 1 to 4 by default). Scrolls and some wands get a random spell. **Draw** shows a draw to look over before adding it.
- **Restock** a shop or every shop in a market: staples back, rotating stock redrawn, sold items counted down, purses filled. A market can restock every so many days of game time.
- A browse-only shop shows players its staples, plus the rest if they saw it open since its last restock.
- Anything put in a shop unidentified is identified there.
- Right-click an item in a shop for its full sheet (read-only for players), or one of your own on the Sell tab.
- Things worth nothing can be sold, for nothing: a way to get rid of them while shopping.

## 0.1.0

First release.

- **The Marketplace window**, opened from the Actors tab: markets with a picture, description and level, each holding the PF2e merchants in its folder (and any added by dragging them onto it); shop cards; each shop's stock by group (weapons, armor and shields, consumables, runes, gear, treasure) with level, rarity, stock and price, and descriptions on a click. Shops sell identified goods: an item the merchant has unidentified shows as the real item.
- **Visible and Open** on each market: players can browse a visible market and trade in an open one. Each shop can also be hidden from players, or closed (browse only) inside an open market.
- **One cart for buying and selling**, for one of your characters or the party stash. On a shop's Buy tab a click adds one (a batch for things sold in batches) and a right-click takes one (or a batch) off; on its Sell tab the same offers what the character carries. A running tally at the top of the shop page shows what's being bought and sold and what the character pays or gets, with a Checkout button. In the cart, minus and plus buttons change quantities. One button makes the whole trade: sales are settled with purchases, so at each shop only the difference changes hands.
- **The GM's client makes every trade**, so a GM must be logged in. It checks the stock, the prices, the character's goods and the money first, then moves the coins (making change) and the items: bought items arrive identified and stacked. If anything changed, nothing happens and the player is told why. If a step fails partway, what moved is put back, and the GM is told to check.
- **Selling**: what a shop pays is half an item's price and full value for treasure by default, set per shop. Unidentified items have to be identified first. What a shop buys goes into its stock, and it pays from its purse, the coins on its merchant sheet, unless the GM gives it an unlimited purse. An item whose stored price doesn't match its compendium entry, or that has none (homebrew), still sells, but the GM's notice and the trade log say so.
- **Purses**: the New shop button makes a merchant at the market's level with a full purse: one level's party treasure for its level (GM Core's table; 100 gp below level 1). Fill purse tops any shop up to that, and a world setting scales it.
- **Shopkeepers**: drag an NPC onto a shop. Their attitude changes what players pay when buying (Friendly 10% off, Helpful 20% off, Unfriendly 20% more by default, all settings; a hostile shopkeeper won't trade unless that setting is off). With PF2e NPC Attitudes, it's the attitude the party sees, toward each character where set; if the party is shown a different attitude from the true one, prices are normal. Without it, a setting on the shop. Treasure is never discounted, since shops buy it back at full value. A shop never pays a character more for something than it would charge them for it.
- **The trade log**, shown only to the GM: every purchase and sale, who made it, the shop and the money.
- **Three looks**, each user's choice from the window's menu (kept in their browser): Dark; Dark and parchment (markets and shops on parchment); and Pathfinder sheet, drawn with the system's own character sheet art.
