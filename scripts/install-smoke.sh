#!/usr/bin/env bash
# Smoke-test install.md in a clean ubuntu:24.04 container.
#
# Walks every non-interactive step from install.md and asserts every
# DONE WHEN criterion. No auth is mounted: install.md's automated path
# never needs LLM credentials (the only OMP call is `bunx omp --help`,
# which just prints help). The human-handoff steps (BotFather token,
# user id, optional voice deps) are explicitly out of scope.
#
# IMPORTANT: tests the CURRENT WORKTREE, not whatever's on github main.
# The repo root is mounted read-only into the container and copied to a
# scratch dir there (so `bun install` / `cp .env.example .env` don't
# scribble back into your worktree). Edit install.md, edit this script,
# rerun — you'll be testing exactly your changes.
#
# Usage: bash scripts/install-smoke.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="ubuntu:24.04"

SCRIPT_INSIDE='
set -euo pipefail
trap '\''echo "FAIL at line $LINENO" >&2'\'' ERR

echo "== prereqs =="
apt-get update -qq
apt-get install -qq -y curl ca-certificates unzip >/dev/null

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

echo "== Step 2: copy worktree =="
# install.md says "git clone …" for fresh installs; smoke substitutes a
# local copy so we test THIS commits install.md, not whatever is on main.
cp -a /src /work
cd /work

echo "== Step 3: bun install =="
bun install

echo "== Step 4: confirm OMP resolves =="
bunx --bun omp --help >/dev/null
test -d "$HOME/.omp"
echo "OMP CLI resolves"

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
echo "2. repo present + bun install .. ok"
echo "3. tsc --noEmit ................ ok"
echo "4. .env populated .............. ok"
echo "5. (handoff section printed) ... skipped (out of automation scope)"
echo "ALL CHECKS PASSED"
'

echo ">> pulling $IMAGE (cached if present)"
docker pull -q "$IMAGE" >/dev/null

echo ">> running install.md walkthrough against $REPO_ROOT in clean container"
docker run --rm \
  --network host \
  -e HOME=/root \
  -w /root \
  -v "$REPO_ROOT:/src:ro" \
  "$IMAGE" \
  bash -c "$SCRIPT_INSIDE"
