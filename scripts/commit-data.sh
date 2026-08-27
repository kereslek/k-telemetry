#!/usr/bin/env bash
# Commit whatever this refresh pass generated. Extracted from the workflow so the job can run
# several passes in one firing — GitHub throttles scheduled workflows hard (gaps of 47, 95, 185
# and 305 minutes observed against a 15-minute cron), so one firing has to do more than one
# refresh or the data on the page is hours old regardless of what the cron says.
#
# Exit 0 means "nothing to do" as well as "pushed": a pass with no changes must not fail the loop.
# Plain `set -e`, matching how this ran as a workflow block. `set -u` would be a behaviour change
# smuggled in by the extraction, and this is not the commit to discover that with.
set -e

git config user.name "lp-hud-bot"
git config user.email "bot@users.noreply.github.com"
# One add per group, each tolerant. A single combined add is fatal if ANY glob matches nothing —
# so a profile that has not produced a ledger yet, or a pass where fetch-data died before writing
# fees, would abort the commit and lose the files that WERE written. Under a four-pass loop that
# turns one unlucky pass into a lost refresh for no reason.
for g in data ledger hist fees costs balances- daily- ; do
  git add deck-r7k4x9/"$g"*.json 2>/dev/null || true
done
# daily-*.json (in the list above) is the per-position day record the attribution is computed
# from. It is cumulative, not regenerated, so a pass that fails to commit it loses that day.
# blockcache.json persists mint blocks + the wallet transfer-scan checkpoint.
# Tolerant add: the script writes it inside a try/catch, so a missing file
# must never fail the data commit.
git add deck-r7k4x9/blockcache.json 2>/dev/null || true
if git diff --cached --quiet; then exit 0; fi
# Do NOT rebase. Every file here is regenerated from chain on each run, and
# hist-main.json is an append-only series: two runs each append a different point
# to the same line, so a rebase hits a textual conflict it can never resolve. The
# retry loop then replayed the identical conflict three times and failed the job,
# which is exactly what happened on run 32285427734.
# Instead: keep what this run produced, reset onto whatever the remote now has, put
# our files back, and commit on top. Our data is the newer read in every case. The
# only loss is a concurrent run's single history point, which the next run replaces.
# Save only what this run generated. config.json is hand-edited and must never be
# copied back over a newer remote version — a reset that restored a stale config
# would silently revert a wallet the owner had just added.
OUT=$(mktemp -d)
# An "if", not "[ x = y ] && continue": Actions runs this under bash -e, where a
# false test as the last command of an && list aborts the whole job.
for f in deck-r7k4x9/*.json; do
  if [ "$(basename "$f")" != "config.json" ]; then cp "$f" "$OUT"/; fi
done
for attempt in 1 2 3; do
  git fetch origin gh-pages
  git reset --hard origin/gh-pages
  cp "$OUT"/*.json deck-r7k4x9/
  git add deck-r7k4x9/*.json
  if git diff --cached --quiet; then echo "nothing new after reset"; exit 0; fi
  git commit -m "data refresh $(date -u +%FT%TZ)"
  if git push origin gh-pages; then exit 0; fi
  echo "push attempt $attempt lost a race — retrying"
  sleep $((attempt * 5))
done
echo "could not push data refresh after 3 attempts"
exit 1
