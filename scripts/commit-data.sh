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

# The lock's salt and check (written once, on the first locked pass) and the relay's sealed log.
git add deck-r7k4x9/lock.json deck-r7k4x9/relay-log.json 2>/dev/null || true
# how long the pass took and its slowest steps (names and seconds only)
git add deck-r7k4x9/relay-timing.json 2>/dev/null || true
# The fee seeds beside the relay, once the first locked pass has sealed them (never in the clear).
for f in scripts/fee-*.json; do grep -q '"lock":1' "$f" 2>/dev/null && git add "$f" || true; done

# The inbox is emptied by the pass that merges it: stage its removal (it is never written here).
git add -A deck-r7k4x9/inbox.json 2>/dev/null || true

# config.json is the owner's (edited from the dashboard) and is never committed from here, with one
# exception: the first locked pass seals it, and only a sealed config.json may be committed.
if grep -q '"lock":1' deck-r7k4x9/config.json 2>/dev/null; then git add deck-r7k4x9/config.json 2>/dev/null || true
else git reset -q deck-r7k4x9/config.json 2>/dev/null || true; fi

if git diff --cached --quiet; then echo "nothing changed this pass"; exit 0; fi

git commit -q -m "data refresh $(date -u +%FT%TZ)"
if git push -q origin gh-pages; then echo "pushed"; exit 0; fi
# A lost race used to cost a whole pass (~18 minutes of stale data), even when all the remote had
# gained was a dashboard deploy that touches none of these files. If only the dashboard page moved
# on the remote, this pass's output is still exactly right on top of it: rebase and push. If
# anything else moved, regenerating from the new state is the only safe answer, as before.
for attempt in 1 2 3; do
  git fetch -q origin gh-pages
  base=$(git merge-base HEAD origin/gh-pages)
  # Only the dashboard page (or notes) may be stepped over. Anything else — data, the generator,
  # the seed and restatement files it reads, workflows — means this pass's output may no longer be
  # what the remote would produce, so it must be regenerated from the new state.
  if git diff --name-only "$base" origin/gh-pages | grep -qvE '^(deck-r7k4x9/index\.html|.*\.md)$'; then
    echo "push lost a race to a change this pass depends on — the next pass will regenerate from the updated remote"
    exit 1
  fi
  if git rebase -q origin/gh-pages && git push -q origin gh-pages; then
    echo "pushed after stepping over a non-data commit"; exit 0
  fi
  git rebase --abort 2>/dev/null || true
  sleep 3
done
echo "push lost a race — the next pass will regenerate from the updated remote"
exit 1
