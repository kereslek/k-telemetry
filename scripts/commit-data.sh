#!/usr/bin/env bash
# Commit whatever this refresh pass generated.
#
# The caller resets onto the current remote BEFORE generating, so by the time we get here the
# working tree is "latest remote plus this pass's output" and a plain add/commit/push is correct.
#
# It used to be the other way round: generate, snapshot the files, reset onto the remote, copy the
# snapshot back, commit. That copy-back overwrote whatever the remote had gained in the meantime.
# For files regenerated from chain every pass that was harmless, but ledger, daily and hist are
# cumulative — and a pass holding a forty-minute-old copy would put it back over newer state. With
# single runs the window was a few minutes; the four-pass loop stretched it to most of an hour, and
# it silently reverted a hand-repaired fee balance. Reset first, generate second, and the window
# closes: the script always reads current state, and a lost race just fails this pass so the next
# one regenerates from whatever the remote now holds.
#
# Exit 0 means "nothing to do" as well as "pushed": a pass with no changes must not fail the loop.
# Plain `set -e`, matching how this ran as a workflow block.
set -e

git config user.name "lp-hud-bot"
git config user.email "bot@users.noreply.github.com"

# One add per group, each tolerant. A single combined add is fatal if ANY glob matches nothing —
# so a profile that has not produced a ledger yet, or a pass where fetch-data died before writing
# fees, would abort the commit and lose the files that WERE written.
# daily-*.json is the per-position day record the attribution is computed from; it is cumulative,
# not regenerated, so a pass that fails to commit it loses that day.
for g in data ledger hist fees costs balances- daily- ; do
  git add deck-r7k4x9/"$g"*.json 2>/dev/null || true
done
# blockcache.json persists mint blocks + the wallet transfer-scan checkpoint. Tolerant: the script
# writes it inside a try/catch, so a missing file must never fail the data commit.
git add deck-r7k4x9/blockcache.json 2>/dev/null || true

# config.json is hand-edited and is never committed from here.
git reset -q deck-r7k4x9/config.json 2>/dev/null || true

if git diff --cached --quiet; then echo "nothing changed this pass"; exit 0; fi

git commit -q -m "data refresh $(date -u +%FT%TZ)"
if git push -q origin gh-pages; then echo "pushed"; exit 0; fi
echo "push lost a race — the next pass will regenerate from the updated remote"
exit 1
