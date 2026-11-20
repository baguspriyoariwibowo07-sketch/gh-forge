#!/bin/bash
# Noise-resistant benchmark: server-process CPU for identical fixed work.
#
# Total wall-clock scores swing under VM load (observed 885-995 for identical
# code), so this measures the forge process's own CPU (utime+stime from
# /proc/<pid>/stat) across a fixed workload, run the same way for any two
# builds: 300 shallow clones of one tip, 500 REST issue-list reads and 500
# GraphQL issue queries. Seeding is identical and happens before the meter
# starts.
#
# Usage: bash tests/bench-cpu.sh <entry-dir> <port> <label>
set -u
ENTRY_DIR="$1"; PORT="$2"; LABEL="$3"
TOKEN=probe-token
BASE="http://127.0.0.1:$PORT"
export GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0

WORK=$(mktemp -d)
cat > "$WORK/serve.ts" <<EOF
process.env.MAKEFUN_SHOP_TOKEN = '$TOKEN';
const { createApp } = await import('$ENTRY_DIR/app.ts');
const server = createApp();
await new Promise((r) => server.listen($PORT, '127.0.0.1', r));
EOF
node "$WORK/serve.ts" > "$WORK/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null; rm -rf "$WORK"' EXIT
for i in $(seq 1 40); do curl -s "$BASE/healthz" >/dev/null 2>&1 && break; sleep 0.25; done

# ---- seed (not measured): one repo, 30 commits, 30 issues -------------------
# Seeding goes through the REST contents API (one commit per created file) so
# the exact same history exists no matter which build is measured — a git-push
# seed would silently leave the old build's repo empty, because that build
# cannot take a real git push to an empty repository at all.
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -X POST "$BASE/api/v3/user/repos" -d '{"name":"bench"}' >/dev/null
for i in $(seq 1 30); do
  B64=$(printf 'line %s' "$i" | base64 -w0)
  curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -X PUT \
    "$BASE/api/v3/repos/adaiversen/bench/contents/f$i.txt" \
    -d "{\"message\":\"c$i\",\"content\":\"$B64\"}" >/dev/null
done
export HOME=$WORK
for i in $(seq 1 30); do
  curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -X POST "$BASE/api/v3/repos/adaiversen/bench/issues" -d "{\"title\":\"issue $i\",\"body\":\"body $i\"}" >/dev/null
done

cpu_ticks() { awk '{print $14 + $15}' "/proc/$SERVER_PID/stat"; }
CLK=$(getconf CLK_TCK)

# ---- measured workload -------------------------------------------------------
START=$(cpu_ticks)
cd "$WORK"
for i in $(seq 1 300); do
  git -c "http.extraHeader=Authorization: Bearer $TOKEN" clone -q --depth 1 "$BASE/adaiversen/bench.git" "c$i" 2>/dev/null
  rm -rf "c$i"
done
for i in $(seq 1 500); do
  curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/v3/repos/adaiversen/bench/issues?state=all&per_page=30" >/dev/null
done
for i in $(seq 1 500); do
  curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -X POST "$BASE/api/graphql" \
    -d '{"query":"{ repository(owner: \"adaiversen\", name: \"bench\") { issues(first: 30, states: [OPEN, CLOSED]) { totalCount nodes { number title } } } }"}' >/dev/null
done
END=$(cpu_ticks)

python3 -c "
ticks = $END - $START
print(f'$LABEL: server CPU {ticks / $CLK:.2f}s over 300 shallow clones + 500 REST reads + 500 GraphQL queries')
"
