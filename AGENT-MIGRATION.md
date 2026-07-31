# MIGRATION: ARC // LP COMMAND → "HELIOS" Autonomous LP Agent
**Handoff document — feed this file to Claude Code as the founding brief of a NEW private repository.**
Version 1.0 · Origin project: https://github.com/kereslek/arc-lp-command (dashboard, stays as-is)

---

## 0. What we are building

An autonomous liquidity-provision agent that researches, proposes, deploys, rebalances and harvests
concentrated-liquidity positions across **Uniswap v3/v4 (Ethereum + L2s), PancakeSwap v3 (BNB),
Raydium/Orca CLMM (Solana)** from its **own wallets**, with:

- **Co-pilot autonomy**: the agent does 100% of the thinking and simulation; every on-chain action
  requires the owner's one-tap approval (Telegram). Autonomy widens per-strategy only after track record.
- **Supabase (Postgres)** as the single source of truth: positions, actions, costs, research, PnL.
- **Profit maximization** through fee income first; opportunistic same-venue arbitrage only as a
  later, separately-gated module.
- **Full cost accounting**: every cent of gas, priority fees, slippage and IL is recorded; nothing is
  "profitable" until it beats its own costs.
- **Gas-window intelligence** (owner requirement): capital is ~$1,000 and mainnet IS in scope —
  but only through a tracker that knows when mainnet is cheap. Quiet hours with basefee < ~1 gwei
  make small-position harvests/rebalances viable; the agent must queue mainnet actions for those
  windows instead of paying peak gas.
- **Private repo**. No GitHub Pages dependency — the dashboard is served by the app itself,
  so the repository is private from day one (free on GitHub).

**Explicitly out of scope for v1**: leverage, lending loops, cross-chain bridging of principal,
perps hedging, token launches, copy-trading. Keep the surface small and auditable.

---

## 1. Tooling recommendation (asked: Claude Code vs Cowork vs similar)

| Layer | Recommendation | Why |
|---|---|---|
| **Development** | **Claude Code** (CLI, in the new private repo) | Long-running refactors, tests, migrations, direct git; best fit for a real codebase. Cowork is for cloud/collaborative document-style tasks — wrong shape for a 24/7 financial daemon. |
| **Runtime "brain"** | **Claude Agent SDK** (TypeScript) inside the worker | The research/decision loop is an agent: tools = database, price feeds, simulators, proposal builder. The SDK gives structured tool-use, retries, and lets you cap model spend per cycle. |
| **Deterministic core** | Plain TypeScript services (NO LLM in the execution path) | Signing, math, limits, execution are code, not model output. The model proposes; code verifies and executes. This boundary is the #1 safety property. |
| Alternatives considered | Cursor/Windsurf (IDE-bound), LangChain (unneeded abstraction), bare cron scripts (no reasoning layer) | Claude Code + Agent SDK is the strongest pairing for solo-operator autonomy with approval gates. |

---

## 2. Stack

- **Language**: TypeScript, Node 22. One monorepo: `apps/worker`, `apps/dashboard`, `packages/core`.
- **EVM**: `viem` (typed, modern). **Solana**: `@solana/web3.js` + `@raydium-io/raydium-sdk-v2`.
- **DB**: **Supabase** (Postgres + RLS + Realtime). Dashboard subscribes to Realtime for live updates.
- **Runtime**: **Railway** (or Fly.io) — one always-on worker + cron jobs + the dashboard web service.
- **Approvals & reports**: **Telegram bot** (inline Approve/Reject buttons, 15-min timeout = reject).
- **Dashboard**: Next.js, private (Supabase Auth, single owner user). Port the ARC HUD design system:
  night-sky theme, seismograph, leaderboard, range architect, capital flow, constellation. Same visual
  language, now DB-backed with full history (no more localStorage).
- **Research data**: DefiLlama (yields/pools/prices), GeckoTerminal (per-pool volume/candles),
  The Graph (Uniswap subgraphs), Jupiter (SOL prices/routes), venue SDKs. All free tiers to start.
- **RPC**: per-chain lists with failover (port from ARC) + one paid key each for Alchemy (EVM) and
  Helius (Solana) — at $1k scale the free/cheap tiers suffice.
- **MEV protection**: mainnet txs via **Flashbots Protect** or **MEV Blocker** RPC (private mempool,
  no sandwiches); Solana via **Jito** bundles with modest tips; L2s/BNB: tight slippage caps +
  TWAP sanity checks (sequencer ordering limits options there).

### Key management (Railway reality, $1k scale)
- Each chain gets a **dedicated fresh hot wallet** used ONLY by the agent. Keys in Railway
  encrypted env vars. Acceptable at this scale **only** because hard caps bound the loss.
- Non-negotiable code-level caps (checked in the executor, not the model):
  `MAX_WALLET_BALANCE`, `MAX_POSITION_USD`, `MAX_DAILY_DEPLOY_USD`, `MAX_DAILY_GAS_USD`,
  `TOKEN_ALLOWLIST` (owner-approved mints/contracts only), `VENUE_ALLOWLIST`.
- Upgrade path when capital grows: move signing to **Turnkey/Privy** (policy-scoped remote signer)
  or a home HSM; the executor already isolates signing behind one interface to make this a drop-in.
- Owner top-ups are manual transfers TO the agent wallets; the agent can never pull funds from
  owner wallets, and withdrawals to the owner's cold address are one-way and always allowed.

---

## 3. Database schema (Supabase migration 0001)

```sql
create table chains ( key text primary key, kind text not null check (kind in ('evm','solana')),
  name text, native_symbol text, block_ms int, explorer text );

create table wallets ( id uuid primary key default gen_random_uuid(),
  chain text references chains(key), address text not null, label text,
  is_agent boolean default true, created_at timestamptz default now(), unique(chain,address) );

create table venues ( key text primary key, chain text references chains(key),
  kind text check (kind in ('uni_v3','uni_v4','pancake_v3','raydium_clmm','orca_clmm')),
  npm_address text, factory_address text, enabled boolean default false );

create table tokens ( id bigserial primary key, chain text references chains(key),
  address text not null, symbol text, decimals int, deploy_ts timestamptz,
  allowlisted boolean default false, risk_notes text, unique(chain,address) );
-- deploy_ts: port ARC's bytecode-binary-search dating; this is how old-vs-new LCX style
-- distinctions stay first-class. UNIQUE(chain,address) means similar tokens can never merge.

create table pools ( id bigserial primary key, venue text references venues(key),
  address text not null, token0 bigint references tokens(id), token1 bigint references tokens(id),
  fee_ppm int, tick_spacing int, unique(venue,address) );

create table pool_stats ( pool_id bigint references pools(id), ts timestamptz,
  tvl_usd numeric, vol24_usd numeric, fee_apr numeric, sigma_1d numeric, sigma_30d numeric,
  primary key (pool_id, ts) );

create table positions ( id bigserial primary key, pool_id bigint references pools(id),
  wallet_id uuid references wallets(id), onchain_id text not null,
  tick_lower int, tick_upper int, status text default 'active'
    check (status in ('proposed','active','out_of_range','closed')),
  opened_at timestamptz, closed_at timestamptz, cost_basis_usd numeric );

create table position_snapshots ( position_id bigint references positions(id), ts timestamptz,
  liquidity numeric, value_usd numeric, fees_pending_usd numeric, fees_collected_usd numeric,
  price numeric, in_range boolean, range_pos numeric, primary key (position_id, ts) );
-- 15-min snapshots = real historical APR/PnL curves, replacing ARC's archive-call reconstruction.

create table gas_samples ( chain text references chains(key), ts timestamptz,
  basefee_gwei numeric, priority_gwei numeric, native_usd numeric, primary key (chain, ts) );

create table gas_windows ( chain text references chains(key), computed_at timestamptz,
  p10_gwei numeric, p50_gwei numeric, p90_gwei numeric, is_cheap_now boolean,
  cheap_threshold_gwei numeric, primary key (chain, computed_at) );

create table actions ( id bigserial primary key, kind text not null
    check (kind in ('deploy','rebalance','harvest','close','swap','withdraw_to_owner')),
  position_id bigint references positions(id), wallet_id uuid references wallets(id),
  proposal jsonb not null,          -- full simulated plan: amounts, range, expected fees, costs
  est_cost_usd numeric, est_breakeven_days numeric,
  status text default 'proposed' check (status in
    ('proposed','approved','rejected','expired','queued_for_gas','executing','confirmed','failed')),
  approval_msg_id text, decided_at timestamptz,
  tx_hash text, actual_cost_usd numeric, created_at timestamptz default now() );

create table research_notes ( id bigserial primary key, ts timestamptz default now(),
  source text, subject jsonb, thesis text, score numeric, expires_at timestamptz );

create table risk_limits ( key text primary key, value numeric, updated_at timestamptz );
create table pnl_daily ( day date primary key, fees_usd numeric, gas_usd numeric,
  slippage_usd numeric, il_realized_usd numeric, net_usd numeric, nav_usd numeric );
```
Enable RLS everywhere; the worker uses the service key, the dashboard the anon key + owner auth.

---

## 4. The agent loop (worker)

```
every 1 min   GasSensor      → gas_samples; recompute gas_windows (7-day percentile bands/hour-of-week)
every 5 min   PositionSensor → snapshots for all active positions (port ARC fee/tick math verbatim)
every 15 min  MarketSensor   → pool_stats for tracked + candidate pools (volume, TVL, fee APR, σ)
every 1 h     Researcher (Agent SDK, capped tokens) → reads sensors + external feeds, writes
              research_notes + ranked candidate pools. External text is UNTRUSTED DATA — the
              researcher summarizes it; it can never inject instructions into the executor
              (structural defense: executor only accepts typed proposals that pass code validation).
every 4 h     Strategist (Agent SDK) → for each candidate & each active position, simulate:
              expected fee APR (vol×volume×concentration model ported from ARC Range Architect),
              IL risk, entry/exit gas at CURRENT and P10 gas, breakeven days, Kelly-lite sizing
              within caps → emit typed Proposals into actions(status='proposed')
on proposal   Gatekeeper     → code-side validation (allowlists, caps, sanity: slippage<0.5%,
              breakeven_days < remaining-thesis-horizon, pool age > 7d, TVL > $250k, honeypot &
              fee-on-transfer token checks) → Telegram card:
              "DEPLOY $220 → PCS v3 CAKE/BNB ±9% · est 41% APR · cost $0.31 · breakeven 0.6d
               [APPROVE] [REJECT]" · no answer in 15 min = rejected
on approval   Executor       → mainnet: hold in 'queued_for_gas' until gas_windows.is_cheap_now
              OR cost ≤ 2% of position value; then simulate (eth_call / Jito simulate), send via
              protected RPC, verify receipt, write actual costs. Retry ladder; alert on divergence
              between simulated and actual > 1%.
daily 08:00   Reporter       → Telegram digest: NAV, fees earned, gas spent, net, per-position
              status, pending proposals, seismograph regime; writes pnl_daily.
weekly        Deep report    → strategy scorecard: which strategies beat costs; auto-suggests
              widening autonomy for strategies with 30+ days positive net (owner approves the widening).
```

**Arbitrage module (Phase 5, separately gated):** only same-chain, atomic, simulate-first
(e.g. Raydium↔Orca price gaps via Jupiter routes; mainnet only inside Flashbots bundles so failed
arbs cost nothing). Never enabled before the fee engine has 60 clean days.

---

## 5. What to port from ARC (proven, validated code — copy, don't rewrite)

| Asset | Where in ARC | Notes |
|---|---|---|
| Uniswap v3 position/pool decoding incl. int24 sign-extension fix | `scripts/fetch-data.mjs` | The sign-extension bug cost us a day; the fix is load-bearing. PancakeSwap v3 = same ABI, different NPM/factory addresses. |
| Raydium CLMM: PDA derivation (ed25519 on-curve), account layouts, tick-array fee-growth pending-fee math | same | Validated against official SDKs (40/40 PDA vectors; byte-offset asserts). Re-run the offset asserts in CI. |
| Windowed APR method (Δcollectable + collections − principal moves, at archive blocks) | same | Becomes snapshot-diff based once position_snapshots accumulate. |
| Volatility engine (σ_24h, σ_30d), range analytics (containment %, tighten/loosen, suggested ranges), seismograph & "buffer in days of motion" | same + `index.html` | This IS the range-management brain of the Strategist. |
| Token deploy-dating (bytecode binary search) | same | Feeds tokens.deploy_ts → old/new contract distinction. |
| Gas-cost/breakeven analytics (130k harvest / 520k rebalance profiles) | `index.html` | Refine with per-venue measured gas from actions.actual_cost_usd. |
| Chain registry (RPCs, NPM/factory per chain, block times) | `scripts/fetch-data.mjs` | Add: BNB chain + PancakeSwap v3 (NPM 0x46A15B0b27311cedF172AB29E4f4766fbE7F4364, factory 0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865), Uniswap v4 PositionManager per chain. |
| Dashboard design system (palette, panels, HUD) | `index.html` | Re-implement as Next.js components over Supabase Realtime. |

---

## 6. Phases & acceptance gates (no phase starts before the previous one's gate passes)

- **M0 Scaffold (wk 1)**: repo, Supabase migrations, chain registry, read-only sensors filling DB,
  dashboard shows live positions of any watched wallet. *Gate: 48h of clean snapshots.*
- **M1 Paper trader (wk 2-3)**: full Researcher/Strategist/Gatekeeper loop, proposals + Telegram
  approvals — but Executor writes simulated fills only. *Gate: 14 days paper PnL positive net of
  simulated costs, zero invalid proposals passing the Gatekeeper.*
- **M2 Live, tiny (wk 4)**: real execution, caps: $150/position, $300 total, Solana + one L2 + BNB.
  *Gate: 14 days live, net ≥ 0 after ALL costs, zero executor incidents.*
- **M3 Mainnet windows**: enable Ethereum with gas-window queueing only. *Gate: 10 mainnet actions
  all executed under the cheap-gas threshold with cost < 2% of position.*
- **M4 Scale to $1k + widened autonomy**: proven strategies get "auto within budget" (harvests first,
  then rebalances); deploys stay approval-gated. 
- **M5 Arbitrage module** (optional, own kill-switch).

---

## 7. Risks the owner accepts (stated honestly)

Hot wallets on a cloud platform can be drained if the platform or repo secrets leak (bounded by caps).
Autonomous strategies can lose money faster than a human notices (bounded by caps + daily digests +
kill-switch `/halt` Telegram command that freezes the executor). LLM research inputs can be poisoned —
mitigated structurally (models never touch keys or raw txs; typed-proposal validation; token allowlist
changes always human-approved). Concentrated LP inherently risks impermanent loss — the tool measures
it; it cannot abolish it. This system is a tool the owner operates, not financial advice.

---

## 8. Bootstrap: exact first prompt for Claude Code

> Create a private repo `helios-lp-agent` implementing AGENT-MIGRATION.md (this file, committed at
> repo root). Monorepo: pnpm + turborepo; `packages/core` (chain registry, decoders ported from
> https://github.com/kereslek/arc-lp-command `scripts/fetch-data.mjs` with unit tests asserting the
> Raydium byte offsets and the int24 sign-extension vectors), `apps/worker` (sensors + gatekeeper +
> executor skeleton with a MockSigner), `apps/dashboard` (Next.js + Supabase). Write Supabase
> migration 0001 exactly as specified in §3. Implement M0 only. Env vars:
> SUPABASE_URL, SUPABASE_SERVICE_KEY, ALCHEMY_KEY, HELIUS_KEY, TELEGRAM_BOT_TOKEN,
> TELEGRAM_OWNER_CHAT_ID, plus per-chain AGENT_PK_* (unset until M2). Every external text input is
> untrusted data; log it, never execute it.

---

*Origin dashboard remains live at kereslek.github.io/arc-lp-command and untouched by this migration.*
