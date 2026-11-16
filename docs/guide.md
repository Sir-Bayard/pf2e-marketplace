# PF2e Marketplace: the guide

Everything the module does, for the GM and for players. The [README](../README.md) is the short version.

## Opening it

Click **Marketplace** at the top of the Actors tab. There's also a hotkey with no key set (**Open the Marketplace** in **Configure Controls**). The window remembers its size and place in each browser.

Players can also open a shop straight from the map: double-clicking a merchant's token (one linked to the merchant actor), or opening its sheet another way, shows its shop in the Marketplace when the shop is in a market they can see (a world setting, on by default; players need at least Limited permission on the merchant to open it at all, and New shop gives them Observer). GMs always get the sheet; a button on the token's HUD opens the shop for them.

The window's menu (⋮ in its title bar) has three looks, each user's own choice, remembered in their browser: **Dark**; **Dark and parchment**, with markets and shops on parchment; and **Pathfinder sheet**, drawn with the system's own character sheet art (its parchment, red sidebar and frames). The same menu picks the Pathfinder sheet look's color: Red, Green, Blue, Purple, Brown or Black.

Everything in the window works from the keyboard: Tab moves between controls, Enter and Space press them, and the arrow keys move along the Buy and Sell tabs. Every drag has a button that does the same (Add item, Add a merchant, the shopkeeper in a shop's Settings, Copy link).

## For the GM

### Markets

**New market** asks for a name, a picture, a level, a merchant folder and a description. Every PF2e merchant in the market's folder, and in the folders inside it, is one of its shops; pick an existing Actor folder or let the module make one named after the market. To add a merchant from elsewhere, use **Add a merchant**, or drag it from the Actors tab onto the market; the small x on its card takes it out again (the merchant itself stays). **Edit** changes all of this later, and **Delete** removes the market but leaves its merchants and folder alone.

Two switches on each market decide what players get:

- **Visible**: players see the market and can browse its shops, for planning.
- **Open**: players can buy and sell there. Opening a market makes it visible; hiding it closes it.

A market starts hidden and closed.

**Prices at a market.** Edit sets a price change for every shop in it (a festival, a siege, a port with high duties), in percent, with a line saying why that players see. It's on top of each shopkeeper's attitude, for buying (as with attitude, a shop never pays more for goods than it would charge).

**Reputation.** With [PF2e Campaign Trackers](https://github.com/Sir-Bayard/pf2e-campaign-trackers) on, a market can be tied to one of its reputation trackers, and each tier of it moves prices there by a percent you set (Admired 10% off, Distrusted 10% more, say). It adds to attitude and the market's own change. With Campaign Trackers off, it does nothing.

**Vaults.** A market can keep a vault for each character: their own storage there, reached only from that market while it's open, with a fee for each deposit if you set one. Players use **Your vault** on the market page to put items and coins in and take them out; a character's vault is made the first time they deposit. You see every character's vault at the market from the same button, and each vault is a loot actor in the "Marketplace vaults" folder.

### Shops

**New shop** makes a PF2e merchant in the market's folder, at the market's level, with a full purse; pick a **kind of shop** (blacksmith, alchemist, general store, magic shop, temple, fence, jeweler) to start it with rotating stock lines that fit. Drag items onto the shop's page (from a compendium, the Items tab or a sheet), or use **Add item** to find one in the system's equipment by name; one the shop already has as a staple adds to that stack and its number. Any merchant you already have works too: put it in the folder.

On a shop's page:

- **Shown**: a hidden shop doesn't appear to players even in a visible market (a fence, a back room).
- **Open**: players can browse a closed shop but not trade there, even in an open market (closed for the night, sold out until the caravan comes). The market's own switches come first: players can't trade anywhere in a closed market, so opening (or showing) a shop in a closed (or hidden) market offers to open (or show) the market too.
- **The purse** is the merchant's own coins, the money buyers pay in and the money it pays for what players sell. **Fill purse** tops it up to one level's party treasure for the shop's level, read from the PF2e system (100 gp below level 1). It only adds coins, never takes any away, and you can always change the coins on the sheet.
- **Settings**: the shop's level (at 0 it takes its market's), whether it buys from players, what it pays (50% of an item's price and 100% of treasure's value by default), an unlimited purse for a shop that never runs out, how many restocks it keeps what players sold, its shopkeeper and attitude (see below), its rotating stock lines (a kind of shop fills them in), and its services. **Copy settings from** fills the form from another shop (what it pays, its purse, its lines and services; never its shopkeeper or attitude).
- **Merchant sheet** opens the PF2e sheet.

Shops sell identified goods: an item put in a shop unidentified is identified there.

**Copy link** on a shop's card (or dragging the card into a journal) makes a link like `@Shop[id]{Edric's Arms}`. Clicking it opens the shop in the Marketplace for anyone who can see it. `@Market[id]{Harbor Market}` links a market the same way.

### Services

A shop's **Services** (in its Settings) are things it does rather than sells: a night's lodging, a bath, a crossing, a repair. Each has a name, a price and a note. Players add them to the cart like goods, as many as they want; they're paid in coins, priced like everything else for the buyer (attitude, market, reputation, haggling), and written in the trade log.

### Stock and restocks

Each item in a shop is one of three kinds, shown to you on its line (click the mark to swap staple and rotating):

- **Staples** come back to their number on every restock (the pencil beside the mark sets it; a quantity changed on the merchant's sheet doesn't change it, and the next restock sets it back). Anything you drag onto a shop is a staple, and a staple that sells out stays on the list as sold out.
- **Rotating** stock is cleared on a restock and drawn again.
- **Sold** items are what players sold the shop. They're for sale at full price and stay for two restocks by default (gone at the second; a shop setting), so selling the day before market day still leaves a chance to buy back.

Merchants you stocked before installing the module become staples of what they have, the first time a GM loads the world.

A shop's **Settings** take its rotating stock lines, such as "Some Weapons", "Few Scrolls" or "4 Potions and oils", from 20 ready filters, each common only, up to uncommon or up to rare. Few, Some, Many and Lots draw a number in a range (1-3, 3-6, 6-10, 10-20 by default; module settings). Items are drawn from the system's compendium up to the shop's level, most of them near that level; consumables (not wands), bombs and ammunition come in stacks of one to four (a setting); scrolls and some wands get a random spell of a rank that fits. Nothing the shop already stocks is drawn again (for scrolls and wands, the same spell); Draw adds to what's there, a restock replaces the rotating stock.

- **Draw** shows a draw from the lines to look over, with Draw again, and adds it as rotating stock.
- **Restock** puts staples back, clears and redraws rotating stock, counts sold items down and fills the purse; you can skip the draw or keep sold items that once. **Restock all** on a market does every shop.
- A market can **restock every so many days** of game time (Edit): when that much time has passed on the world clock, every shop restocks once, however long it's been. Restock all starts the count again.

While a shop is browse only, players see its staples, plus the rest of its stock if they saw it open since its last restock ("the stock has changed since your last visit" otherwise).

### Formulas

Click the scroll mark on an item's line to sell its formula instead of the item. It shows as "Formula: Alchemist's Fire" under Formulas, priced by item level, times 2 for uncommon and 10 for rare (settings). The price for a level is worked out from the party treasure table in the PF2e system (a tenth of the currency each additional character gets at that level, in whole gold; level 0 costs half of level 1). The pencil beside the mark sets your own price. An item needs a compendium or Items-tab entry for its formula to point to. The shop keeps it and sells a copy to each buyer: the formula goes into the character's Crafting tab, with a parchment of it that weighs nothing. A character who already knows it can't buy it, and the party stash can't. The stock lines **Formulas: alchemical** and **Formulas: any** draw formulas, one copy each. A basic crafter's book is an ordinary item.

### Shopkeepers and prices

Pick a shopkeeper in a shop's Settings, or drag an NPC onto the shop; players see their token name and picture. The shopkeeper's attitude changes what players pay when they buy:

| Attitude | Price change |
|---|---|
| Hostile | won't trade |
| Unfriendly | 20% more |
| Indifferent | normal |
| Friendly | 10% off |
| Helpful | 20% off |

- These are settings, as is whether hostile shopkeepers trade at all. Treasure (gems, art objects) is never discounted, since shops buy it back at its full value; a markup still applies.
- Attitude doesn't change what a shop pays, except that a shop never pays a character more for something than it would charge them for it (with a discount of over 50%, say, it pays less than half for goods).
- With [PF2e NPC Attitudes](https://github.com/Sir-Bayard/pf2e-npc-attitudes) installed, the shopkeeper's attitude there counts, toward each character where you've set one. If the party is shown a different attitude from the true one (a merchant posing as a friend, or Unknown), prices are normal, so a disguise isn't given away and a secretly hostile merchant still trades; your view of the shop says when that's happening. Without NPC Attitudes, or for a shopkeeper with no attitude there, the shop's own attitude setting counts.

A market's price change, its reputation tier and a character's haggle add to the attitude's change. The line beside Trading as shows each part.

### Haggling

A character can haggle once at each shop until its next restock: **Haggle** beside Trading as rolls their Diplomacy against the DC for the shop's level, read from the PF2e system. A critical success takes 20% off what that character pays there, a success 10%, a failure changes nothing and a critical failure adds 10%, until the restock (world settings; for buying, and as with attitude a shop never pays more for goods than it would charge). The roll is the player's own, made openly in chat; the GM's client records the first haggle roll for that character at that shop (one Hero Point reroll of it replaces it) and ignores any after it until the restock. Assurance works too. A GM must be logged in. Haggling can be turned off in the settings.

### Receipts

After each trade at a shop, a receipt goes to chat: what was bought and sold, at what price, and what changed hands. By default it's whispered to the trader's owners and the GMs; a world setting makes it public or turns it off.

### The trade log

**Trade log** (shown only to you) lists every purchase, sale, Trade Post trade and vault deposit or withdrawal, newest first: who made it, for which character, where, what changed hands and for how much. It keeps the last 300. A sale of an item whose price doesn't match its compendium entry (a price edited on the sheet), or that has none (homebrew), is marked there and in your notice, with both prices; runes and materials added to an item don't count, since the system adds them on top of the item's own price.

### Rules read from the system

Two tables come from the PF2e system itself, read from its GM Screen journal each time the world loads: the party treasure by level (for purses and formula prices) and the DCs by level (for haggling). The module keeps no copy. If a system update moves them so they can't be read, you're told once, and Fill purse, prices worked out for formulas (your own prices still work, and drawn formula lines are skipped with a notice) and haggling switch themselves off until the module is updated. Everything else carries on.

## For players

Open the **Marketplace**, pick a market and a shop. Click an item's name for its description; the page button beside it opens its full sheet. **Trading as** chooses which of your characters is shopping (or the party stash, if you own the party); prices are for that character, and the line beside it says what makes them up.

**Buying.** The cart button on a line adds one, or one batch for things sold in batches (10 arrows), never more than the shop has; the minus beside it takes one (or one batch) off. Sort the list by name, level or price with the headings, and show only what that character can afford, or what's up to their level. Prices they can't afford are dimmed. A formula is one copy: buying it puts it in your character's Crafting tab, with a parchment of it. An item's price includes anything attached to it (spikes on a shield, loaded ammunition), as the character sheet counts its worth, when buying and selling; a stack of such items trades all at once.

**Selling.** A shop's **Sell** tab lists what your character carries, with the shop's offer for each. The offer button on a line offers one more (or one batch), the minus one fewer, or type how many. Unidentified items have to be identified first, and containers emptied. Something worth nothing sells for nothing, a way to get rid of it.

**The cart and checkout.** Purchases and sales go into one cart, from any open shop. The bar at the top of a shop page keeps a running tally (what you're buying, what you're selling, and what you pay or get) with a **Checkout** button that opens the cart. The cart lists everything by shop, with minus and plus buttons for each quantity, and one button makes the whole trade. Sales are settled with purchases: at each shop only the difference changes hands, so selling your old armor can pay for the new, and a shop with an empty purse can still take a trade-in against what you buy from it. The GM's client checks the stock, the prices, your goods and your money, moves the coins (making change from bigger coins as the system does) and the items; what you buy arrives identified and stacked with what you have. If anything changed since you looked, nothing happens and you're told why. If the cart changed after the total you saw (a quantity typed a moment before), the button asks you to look again first.

### The Trade Post

**Trade Post** at the foot of the market list is where characters trade with each other. **New offer** puts up what your character gives (items and coins) and what they want: coins from anyone, or, for an offer to one character, coins and items of theirs. Give nothing and it's a request (5 sp from anyone, say), which another character fills with **Give**. Other players see it under Open offers or For you, and **Accept** makes the swap at once: both sides' items and only the difference in coins change hands, and the item goes as it is (an unidentified item stays unidentified). Nothing is held while an offer is up, so it's checked again when someone accepts; an item used or changed since it went up (a charge spent, damage, an edit) holds the offer until it's posted again. An item with something attached goes as its whole stack (the form says which). Take it down any time. The party stash doesn't trade here, and a character can have up to 10 offers up. The GM sees every offer, can remove any, and finds each trade in the trade log.

A GM has to be logged in for any trade, vault or haggle: Foundry only lets a GM's client change the merchants. Browsing works without one.

## Privacy

As with everything in Foundry, every actor and every world setting reaches every player's browser. Players don't see hidden markets, hidden shops or GM notes in the window, but a player who opens the browser console can read the markets, every merchant's stock, every vault and the trade log. Don't keep real secrets there. Dice rolls are made on each player's own computer, as everywhere in Foundry, so a haggle is as trustworthy as any other roll.

## Settings

- **Players open shops from tokens** (world, on): a player's double-click on a merchant's linked token, or its sheet, opens its shop.
- **Chat receipts** (world, to the trader's owners and the GMs): or to everyone, or off.
- **Stock line size: Few, Some, Many, Lots** (world, 1-3, 3-6, 6-10, 10-20): how many a rotating stock line of that size draws.
- **Drawn consumables per stack** (world, 1-4): how many of each consumable, bomb or ammunition a draw gives, in batches.
- **Shop purse size (%)** (world, 100): how full Fill purse and new shops make a purse. Lower it for a poor region, raise it for a rich one.
- **Formula price: uncommon, rare** (world, ×2, ×10): what an uncommon or rare formula costs, as a multiple of a common one.
- **Hostile shopkeepers won't trade** (world, on): off lets them trade at the Hostile price change.
- **Price change** for each attitude (world): in percent, positive costs more, negative is a discount. Buying only; treasure is never discounted.
- **Haggling** (world, on), and **Haggle** for each degree of success (world, -20, -10, 0, 10): what a haggle does to that character's prices at that shop until its next restock.
- **Open the Marketplace** in **Configure Controls**: the hotkey, unset.

The looks and the Pathfinder sheet look's color are in the window's menu.

## API

`game.modules.get("pf2e-marketplace").api`:

- `open(marketId, shopId)`: opens the window, on a market and shop if given. Resolves to the window.
- `markets()`: the markets as stored.
- `trades({ from, to })`: the trade log from `from` to `to` (times as `Date.now()` gives them; either may be left out), oldest first. GMs only; others get an empty list.
- `refresh()`: redraws any open Marketplace window.
