#!/usr/bin/env bash
# No-fake-data scan (SPEC §1.2, part of `make check`): production code must not generate values.
# Fails on random/faker/mock/simulated-data patterns outside tests. Allowed on purpose:
#   server/ndx_server/demo.py   DEMO fixtures (deterministic, hash-based, DEMO-badged)
#   app/src/perf/               synthetic rows for the perf smoke (dev-only route, DEMO-labelled)
# Token generation (secrets.token_*, os.urandom, /dev/urandom) is not data and is not matched.
# Self-test: `scripts/no-fake-data.sh --self-test` checks the pattern against known forms.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Python: random module in any import/call form, numpy RNGs, secrets.rand*/choice;
# JS: Math.random, crypto.getRandomValues; any language: faker, mock data, "simulated".
PATTERN='Math\.random|getRandomValues|\brandom\.[A-Za-z_]+|\b(from|import) +random\b|numpy\.random|np\.random|default_rng|\brng\.(random|normal|uniform|integers|choice)|secrets\.(randbelow|randbits|choice)|\b[Ff]aker\b|[Ss]imulat(e|ed|ion)\b|\bmock(Data|Quote|Price|Bars?)\b|\bfake(Data|_?[Pp]rices?|_?[Qq]uotes?)\b'

if [[ "${1:-}" == "--self-test" ]]; then
  bad=0
  while IFS= read -r s; do
    grep -qE "$PATTERN" <<<"$s" || { echo "MISS: $s" >&2; bad=1; }
  done <<'CASES'
from random import uniform
import random
random.sample(x, 2)
random.Random(1).random()
numpy.random.default_rng()
from numpy.random import default_rng
x = rng.random()
crypto.getRandomValues(a)
price = secrets.randbelow(100)
Simulated quote
const v = Math.random()
fake_price = 1
CASES
  while IFS= read -r s; do
    grep -qE "$PATTERN" <<<"$s" && { echo "FALSE HIT: $s" >&2; bad=1; }
  done <<'CASES'
token = secrets.token_hex(32)
os.urandom(32)
randomBytes(32).toString("hex")
CASES
  [[ $bad == 0 ]] && echo "no-fake-data self-test: OK"
  exit $bad
fi

set +e
HITS="$(grep -rnE "$PATTERN" server/ndx_server server/run_server.py app/src app/src-tauri/src)"
status=$?
set -e
if [[ $status -gt 1 ]]; then
  echo "no-fake-data scan: grep failed (status $status)" >&2
  exit 2
fi
HITS="$(grep -vE '\.test\.(ts|tsx):|/tests/|^server/ndx_server/demo\.py:|^app/src/perf/' <<<"$HITS" || true)"
if [[ -n "$HITS" ]]; then
  echo "no-fake-data scan: FAIL — value generation outside DEMO/tests:" >&2
  echo "$HITS" >&2
  exit 1
fi
echo "no-fake-data scan: OK"
