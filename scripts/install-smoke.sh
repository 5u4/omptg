#!/usr/bin/env bash
# Smoke-test install.md in a clean ubuntu container.
#
# Walks every non-interactive step from install.md and asserts every
# DONE WHEN criterion. No auth is mounted: install.md's automated path
# never needs LLM credentials (the only OMP call is `bunx omp --help`,
# which just prints help). The human-handoff steps (BotFather token,
# user id, optional voice deps) are explicitly out of scope and not
# exercised — they're what the human does after this passes.
#
# Usage: bash scripts/install-smoke.sh
# Exits 0 on success, non-zero on the first failed assertion.

set -euo pipefail

IMAGE="ubuntu:24.04"
SCRIPT_INSIDE='
set -euo pipefail
trap '\''echo "FAIL at line $LINENO" >&2'\'' ERR

echo "== prereqs =="
apt-get update -qq
apt-get install -qq -y curl git ca-certificates unzip >/dev/null

echo "== Step 1: install Bun =="
curl -fsSL https://bun.sh/install | bash >/dev/null
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
bun_version=$(bun --version)
echo "bun --version => $bun_version"
# DONE WHEN #1: bun >= 1.3.0
major=${bun_version%%.*}
minor=${bun_version#*.}; minor=${minor%%.*}
if [ "$major" -lt 1 ] || { [ "$major" -eq 1 ] && [ "$minor" -lt 3 ]; }; then
  echo "FAIL: bun $bun_version < 1.3.0" >&2; exit 1
fi

echo "== Step 2: clone =="
git clone --depth 1 https://github.com/5u4/omptg.git /work/omptg
cd /work/omptg

echo "== Step 3: bun install =="
bun install

echo "== Step 4: warm OMP CLI =="
bunx --bun @oh-my-pi/pi-coding-agent --help >/dev/null
test -d "$HOME/.omp"
echo "OMP CLI reachable"

echo "== Step 5: .env from template =="
cp .env.example .env
grep -E "^(TELEGRAM_BOT_TOKEN|TELEGRAM_ALLOWED_CHATS)=$" .env >/dev/null || {
  echo "FAIL: required keys missing or non-empty in .env" >&2; exit 1
}
# Every key in the template must survive into .env
diff <(grep -oE "^[A-Z_]+=" .env.example | sort -u) \
     <(grep -oE "^[A-Z_]+=" .env         | sort -u)

echo "== Step 6: typecheck =="
bunx tsc --noEmit

echo "== DONE WHEN summary =="
echo "1. bun >= 1.3 .................. ok ($bun_version)"
echo "2. repo cloned + bun install ... ok"
echo "3. tsc --noEmit ................ ok"
echo "4. OMP CLI reachable ........... ok"
echo "5. .env populated .............. ok"
echo "6. (handoff section printed) ... skipped (out of automation scope)"
echo "ALL CHECKS PASSED"
'

echo ">> pulling $IMAGE (cached if present)"
docker pull -q "$IMAGE" >/dev/null

echo ">> running install.md walkthrough in clean container"
docker run --rm \
  --network host \
  -e HOME=/root \
  -w /root \
  "$IMAGE" \
  bash -c "$SCRIPT_INSIDE"
