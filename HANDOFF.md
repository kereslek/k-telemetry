# ARC // LP COMMAND — Session Handoff Brief

**Owner:** Csaba (GitHub: kereslek) · **Live site:** https://kereslek.github.io/k-telemetry/deck-r7k4x9/
**Repo:** kereslek/k-telemetry · single branch `gh-pages` · GitHub Pages serves it as-is.

## What this is
A zero-backend "Jarvis HUD" dashboard tracking Csaba's concentrated-liquidity LP positions.
No API keys, no server: a GitHub Action refreshes on-chain data every 15 min; the static page renders it.

## Architecture (3 pieces)
1. **`deck-r7k4x9/index.html`** — the ENTIRE dashboard (one file, ~4k lines, BUILD tag inside, currently v25.1).
   Secret path on purpose; repo root has a decoy page. noindex + no-referrer everywhere.
2. **`scripts/fetch-data.mjs`** — Node 20, zero deps. Runs in Actions: reads Uniswap V3 positions
   (wallet auto-discovery, multichain: ETH/ARB/BASE/OP/POLY) + Solana (Raydium CLMM + Orca Whirlpools,
   incl. DynamicTickArray), prices via DefiLlama/Chainlink, writes `deck-r7k4x9/data-<profile>.json`.
3. **`.github/workflows/refresh.yml`** — cron */15 + push-trigger on `scripts/**`. Commits data files.

## Persistent ledgers (server-maintained JSON in deck-r7k4x9/)
- `data-main.json` — current snapshot (v:6). `config.json` — profiles/wallets (MAIN profile).
- `hist-main.json` — portfolio value+fees every 15 min (~30 days).
- `fees-main.json` — monthly fee income ledger: per-position month-start baselines (archive-read),
  closed-LP contributions frozen into `closed`, 12-month archive in `months[]`, portfolio IL snapshot.
- `costs-main.json` — monthly cost ledger: gas for every LP op + swap fees (wallet-wide sweep,
  any pool/route, V3+V2), scan cursors in `scan{}`, 12-month archive.
- `ledger-main.json` — Solana harvest detection (snapshot-diff), seeded values.

## Key conventions
- **Reposition handling is autonomous**: wallet discovery finds new NFTs; closed-and-empty positions
  are dropped (server + client). Client `REPOSITIONED` map migrates old pinned ids (history:
  1338795→1344396, 1339457→1344398, 1340170→1344728).
- **LCX has OLD (…85fe41, 2019) and NEW (…8aae7e) contracts** — always badge which one (auto era badges).
  Migration to NEW is ongoing; user watches OLD vs NEW APR on the leaderboard.
- **Display orientation**: pairs with price <0.01 auto-invert (e.g. "98,739 LCX per ETH").
  ALL user-facing range positions/arrows are in DISPLAYED orientation (`dispRangePos`, `dispEdge`).
- **Range positions are LINEAR price-space**, not tick/log (user demand).
- **Income green with +, costs red with −** everywhere. Timeframe switcher (24H/7D/30D/1Y/OPEN)
  standardizes every APR on the page.
- **Never show fake data**: OFFLINE shows nothing; CACHED mode shows last snapshot with amber banner.
  DEMO only behind `?demo`.
- Header: DATA AS OF timestamp (exact second + live age), ticker strip ETH/SOL/LCX/CPOOL with 24h chips.
- **TRUTH PANEL**: per-position IL (vs HODL), LP-vs-HODL verdicts, range coaching, month-over-month table.
- Config changes (wallets/profiles): user tells Claude in chat (primary path). Quick-add drop zone
  saves to browser localStorage only (Layer 1, user's explicit choice).
- User is non-technical-ish, wants PRO analytics, hates clutter, tests on iPhone — always verify ≤430px.

## Workflow for changes
1. Edit locally, test with Playwright against a mock relay JSON (serve /tmp/site with fresh `t`!
   — data older than 120 min is ignored by the client).
2. Bump `const BUILD` in index.html for every user-visible change.
3. Commit to gh-pages, push. `scripts/**` changes trigger an immediate refresh run; HTML alone doesn't
   (cron picks it up ≤15 min; to force, touch the comment on line 1 of fetch-data.mjs).
4. Verify: pull the bot's next "data refresh" commit and inspect data-main.json.

## Open items
- History purge of this repo (user approved; force-push single clean commit) — was blocked in the old
  session; retry: `git push --force origin $(git commit-tree 'HEAD^{tree}' -m "deck"):gh-pages`.
- User should delete old repo `arc-lp-command-v2` (his click).
- Eventually: take repo private (GitHub Pro) — README TODO.
- Solana IL not computable from free RPC (stated on the Truth Panel) — revisit if a free indexer appears.
- PancakeSwap pools rarely pass Global Scope quality filters — venue slugs already include variants.

## Sensitive
Wallets are in `deck-r7k4x9/config.json` (public repo — user accepts, wants obscurity layers only).
Old wallet-bearing git history still exists until the purge runs. No tokens/secrets in the repo.
