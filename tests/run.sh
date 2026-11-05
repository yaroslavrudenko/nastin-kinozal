#!/bin/zsh
# Runs the behaviour suite (tests/*.test.js) with Node 22's built-in test runner.
# Prints one line per test name (ok / not ok), the counts, and exits non-zero on any failure.
#   tests/run.sh                 the whole suite
#   tests/run.sh --junit FILE    also write a JUnit report (per-test names, for by-name regression diffs)
#   tests/run.sh --browser       also run tests/browser/*.test.mjs (layout in headless Chrome; needs
#                                PUPPETEER_CORE_DIR — they fail, never skip, without it)
# Options combine in any order. The network scripts in tests/e2e/ are run separately.
# N4 (batch 5): started by another shell (sh tests/run.sh, bash tests/run.sh), it runs itself again under zsh, before set -u
# and the cd (under sh the zsh-only ${0:A:h} stopped it with no test run and exit 0). A run that reports no tests exits 2
# (NO TESTS RAN); an emptied test file still counts as one passing test in Node 22: the by-name diff catches that.
[ -n "${ZSH_VERSION:-}" ] || exec zsh "$0" "$@"
set -u
cd "${0:A:h}/.."
NODE="${NODE:-/Users/yaroslavr/.nvm/versions/node/v22.22.0/bin/node}"
[[ -x "$NODE" ]] || NODE="$(command -v node)"

junit="" browser=0
while (( $# )); do
  case "$1" in
    --junit) junit="${2:-}"; shift 2 ;;
    --browser) browser=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

files=(tests/*.test.js)
(( browser )) && files+=(tests/browser/*.test.mjs)
if (( ${#files} == 0 )); then echo "no test files found in tests/" >&2; exit 2; fi
echo "node $("$NODE" --version) · ${#files} test files$( (( browser )) && echo ' (with browser layout)')"

reporters=(--test-reporter=tap --test-reporter-destination=stdout)
[[ -n "$junit" ]] && reporters+=(--test-reporter=junit "--test-reporter-destination=$junit")

out="$("$NODE" --test --test-concurrency=4 "${reporters[@]}" "${files[@]}" 2>&1)"
rc=$?
# Per-test lines (top-level tests only) and the summary.
print -r -- "$out" | grep -E '^(not )?ok [0-9]+ - ' | sed -E 's/^(not ok|ok) [0-9]+ - /\1 · /'
print -r -- "$out" | grep -E '^# (tests|pass|fail|cancelled|skipped|todo|duration_ms) '
# Collected nothing = not a pass.
tests="$(print -r -- "$out" | sed -nE 's/^# tests ([0-9]+)$/\1/p')"
if [[ -z "$tests" || "$tests" == "0" ]]; then echo "NO TESTS RAN" >&2; exit 2; fi
if (( rc != 0 )); then
  echo "--- failure details ---"
  print -r -- "$out" | grep -E -A12 '^not ok [0-9]+ - ' | grep -E '^not ok|error:|expected|actual|^\s+[A-Za-z].*: ' | head -200
fi
exit $rc
