#!/bin/bash
# Real-git interop matrix: drive the forge with the stock git CLI (2.43) over
# smart HTTP, both protocol v2 and v0, and check the observable history shapes.
# The kit's sealed suite speaks its own client; this script proves the wire
# also satisfies git itself — empty-repo pushes, shallow clones, deepen
# (relative), unshallow, annotated tags and pull-request creation included.
#
# Usage: bash tests/interop.sh [port]     (default port 18799)
# Exit code is 0 only when every line below prints ok.
set -u
PORT="${1:-18799}"
TOKEN=probe-token
BASE="http://127.0.0.1:$PORT"
export GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0

cd "$(dirname "$0")/.."
FORGE_PORT=$PORT FORGE_TOKEN=$TOKEN node tests/serve.ts >/tmp/forge-interop.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT
for i in $(seq 1 40); do curl -s "$BASE/healthz" >/dev/null 2>&1 && break; sleep 0.25; done

fail=0
expect() { # expect <label> <actual> <wanted>
  if [ "$2" = "$3" ]; then echo "ok   $1 ($2)"; else echo "FAIL $1: got $2, want $3"; fail=1; fi
}
g()  { git -c "http.extraHeader=Authorization: Bearer $TOKEN" "$@"; }
g0() { git -c protocol.version=0 -c "http.extraHeader=Authorization: Bearer $TOKEN" "$@"; }
count() { git -C "$1" log --oneline 2>/dev/null | wc -l | tr -d ' '; }

curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -X POST "$BASE/api/v3/user/repos" -d '{"name":"interop"}' >/dev/null

W=$(mktemp -d); cd "$W" || exit 1; export HOME=$W
git init -b main -q seed; cd seed
git config user.email probe@example.invalid; git config user.name probe
for i in 1 2 3 4 5; do echo "line $i" >> f.txt; git add .; git commit -qm "c$i"; done
git remote add origin "$BASE/adaiversen/interop.git"
g push -q origin main 2>/dev/null
expect "push first commit to an empty repo (v2 advertisement + receive-pack)" "$?" "0"
git tag -a v1 -m "version one"; g push -q origin v1 2>/dev/null
git checkout -qb feature; echo feat > feat.txt; git add .; git commit -qm fc; g push -q origin feature 2>/dev/null
cd "$W"
PR=$(curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -X POST \
  "$BASE/api/v3/repos/adaiversen/interop/pulls" -d '{"title":"t","body":"b","head":"feature","base":"main"}')
case "$PR" in *'"number":1'*) echo "ok   pull request created over REST";; *) echo "FAIL pull request: $PR"; fail=1;; esac

g clone -q "$BASE/adaiversen/interop.git" full 2>/dev/null;   expect "v2 full clone commits" "$(count full)" "5"
g clone -q --depth 1 "$BASE/adaiversen/interop.git" sh 2>/dev/null; expect "v2 shallow depth-1 commits" "$(count sh)" "1"
(cd sh; g fetch -q --deepen 2 origin 2>/dev/null);            expect "v2 deepen 2 (relative)" "$(count sh)" "3"
(cd sh; g fetch -q --unshallow origin 2>/dev/null);           expect "v2 unshallow" "$(count sh)" "5"
g0 clone -q "$BASE/adaiversen/interop.git" v0full 2>/dev/null; expect "v0 full clone commits" "$(count v0full)" "5"
g0 clone -q --depth 2 "$BASE/adaiversen/interop.git" v0sh 2>/dev/null; expect "v0 shallow depth-2 commits" "$(count v0sh)" "2"
(cd v0sh; g0 fetch -q --deepen 1 origin 2>/dev/null);         expect "v0 deepen 1 (relative)" "$(count v0sh)" "3"
(cd v0sh; g0 fetch -q --deepen 2 origin 2>/dev/null);         expect "v0 deepen 2 (relative)" "$(count v0sh)" "5"
PEEL=$(g ls-remote "$BASE/adaiversen/interop.git" 'refs/tags/v1^{}' | awk '{print $1}')
TIP=$(g ls-remote "$BASE/adaiversen/interop.git" refs/heads/main | awk '{print $1}')
expect "annotated tag peels to the main tip" "$PEEL" "$TIP"

echo; if [ $fail = 0 ]; then echo "interop: all ok"; else echo "interop: FAILURES"; fi
exit $fail
