#!/bin/bash
# Prints Sterio Server usage: active servers, versions, platforms.
# Needs `npx wrangler login` once on this Mac.
cd "$(dirname "$0")"
q() {
  npx --yes wrangler@4 d1 execute sterio-stats --remote --json --command "$1" 2>/dev/null | python3 -c '
import json, sys
rows = json.load(sys.stdin)[0]["results"]
if not rows: print("  (none)"); sys.exit()
cols = list(rows[0]); width = [max(len(str(c)), *(len(str(r[c])) for r in rows)) for c in cols]
for line in [cols] + [[r[c] for c in cols] for r in rows]: print("  " + "  ".join(str(v).ljust(w) for v, w in zip(line, width)))'
}
echo "Active servers (today, last 7 days, last 30 days, ever)"
q "SELECT (SELECT count(*) FROM days WHERE day = date('now')) AS today,
  (SELECT count(DISTINCT id) FROM days WHERE day > date('now','-7 days')) AS week,
  (SELECT count(DISTINCT id) FROM days WHERE day > date('now','-30 days')) AS month,
  (SELECT count(*) FROM installs) AS ever"
echo "Active in the last 7 days, by version, platform and architecture"
q "SELECT version, platform, arch, count(*) AS servers FROM installs WHERE last_seen > date('now','-7 days') GROUP BY 1,2,3 ORDER BY 1 DESC, 4 DESC"
echo "New servers per day (last 14 days)"
q "SELECT first_seen AS day, count(*) AS new FROM installs WHERE first_seen > date('now','-14 days') GROUP BY 1 ORDER BY 1"
