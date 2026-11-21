# Working rules for this repository

## A sudden drop is a reading error until proven otherwise

If the total value, the total position value or the total portfolio value drops suddenly by about 30% or more
(between two readings, or overnight with no market move to match), assume the reading went wrong, not the money,
and start a self-audit at once. Do not explain it away as market moves, or as another figure the owner may have
mixed up, before the audit says so.

1. `value-drop-probe` (development branch): the positions now against yesterday's copies, split into prices,
   changes inside the positions, positions no longer read and positions left without a price.
2. `price-feed-probe` (development branch): whether Jupiter and DefiLlama answer, and whether the price tiles are in
   the relay file.
3. `daily-audit` on gh-pages: whether the page agrees with the relay.
4. The last day's own changes (`git log`), first: say plainly if one of them is the cause.

21 Nov 2026: Jupiter refused one relay pass (HTTP 429), five Solana positions were left without a price and counted
as nothing (−39%), and CPOOL showed by its address, while nothing had moved on the chain. A token Jupiter does not
price now takes DefiLlama's (v40.47).

## Public logs

The repository is public, so every Actions log is too. Logs, commits and comments carry only pass/fail, counts,
ratios, dates and market data: never an address, amount, position ID, a ticker or pool tied to the owner's
holdings, or anything that fingerprints a position or a trade.
