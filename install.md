# omptg

> Telegram bridge for the OMP coding agent — one Bun process, one AgentSession per chat.

I want you to install omptg for me. Walk every step below in order; for each shell command, confirm it matches what's in this file (no extra flags, no extra commands), then run it without further confirmation. If a command produces unexpected output or non-zero exit, stop and report — do not improvise a fix. Only stop voluntarily at the **HUMAN HANDOFF** section at the end and wait for the user there.

OBJECTIVE: Get an omptg checkout on disk with all dependencies installed, the OMP CLI resolvable, a populated `.env` template, and a one-command boot recipe — so the only thing left for the human is creating the Telegram bot and configuring OMP's LLM provider.

DONE WHEN: All of the following are true:
1. `bun --version` prints `1.3.0` or higher.
2. The repo is checked out and `bun install` completed with exit 0.
3. `bunx tsc --noEmit` (run from the repo root) exits 0.
4. `.env` exists in the repo root, contains every key from `.env.example`, and `TELEGRAM_BOT_TOKEN` / `TELEGRAM_ALLOWED_CHATS` are present as empty placeholders ready for the human to fill in.
5. You have printed the **HUMAN HANDOFF** checklist verbatim and are waiting for the user.

## TODO

- [ ] Verify Bun ≥ 1.3 (install it if missing)
- [ ] Clone the repo (skip if already inside it)
- [ ] `bun install`
- [ ] Confirm the OMP CLI resolves (`bunx omp --help`)
- [ ] Create `.env` from `.env.example` with placeholders ready
- [ ] Typecheck to confirm the tree is sound
- [ ] Print the **HUMAN HANDOFF** checklist and stop

## Step 1 — Bun ≥ 1.3

Check the version:

```bash
bun --version
```

If the command is missing or prints anything below `1.3.0`, install/upgrade:

```bash
curl -fsSL https://bun.sh/install | bash
```

Then re-source the shell rc the installer touched (`~/.bashrc` / `~/.zshrc`) so `bun` resolves in this session. Re-run `bun --version` to confirm.

## Step 2 — Clone the repo

If you are already inside a clone of `5u4/omptg` (i.e. `git remote -v` shows that origin), skip this step.

Otherwise:

```bash
git clone https://github.com/5u4/omptg.git
cd omptg
```

All subsequent commands run from the repo root.

## Step 3 — Install dependencies

```bash
bun install
```

This pulls `grammy`, `@oh-my-pi/pi-coding-agent`, and the rest. Frontend deps under `src/bridge/web/frontend` come along — ignore them, the web UI is not part of this install path.

## Step 4 — Confirm OMP resolves

The agent SDK is pulled in by `bun install`; OMP itself only writes `~/.omp/agent/` the first time a real session runs (which happens when the human DMs the bot, not now). Confirm the CLI resolves:

```bash
bunx --bun omp --help >/dev/null && echo "OMP CLI resolves"
```

This is a sanity check that `node_modules/.bin/omp` was created by Step 3 — it doesn't install or configure anything OMP-side. Provider credentials (OpenAI / Anthropic / GitHub Copilot / etc.) are OMP's concern, not omptg's; they are **not** part of omptg's `.env`. The human handles them in HUMAN HANDOFF step C. Do **not** invent keys or pre-populate `~/.omp/agent/config.yml`.

## Step 5 — Create `.env`

Copy the template:

```bash
cp .env.example .env
```

`.env` now contains every variable with inline docs. The only two that are strictly required for boot are `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_CHATS`. Both must come from the human — do **not** invent placeholder tokens or numeric ids. Leave them as empty assignments (`TELEGRAM_BOT_TOKEN=`) so the human can paste their values in.

Sanity-check the file exists and has both keys:

```bash
grep -E '^(TELEGRAM_BOT_TOKEN|TELEGRAM_ALLOWED_CHATS)=' .env
```

You should see two lines, each ending in `=` with nothing after.

## Step 6 — Typecheck

Confirm nothing in the tree is broken before you hand off:

```bash
bunx tsc --noEmit
```

This must exit 0. (The repo also has `bun run typecheck`, which additionally type-checks the in-progress Svelte web UI — skip it; the web path is not part of this install.)

## HUMAN HANDOFF

Stop here and present the user with this exact checklist (translate to their language if appropriate, but keep the structure). Do not run `bun start` until they have completed steps A and B.

**The repo is installed and the OMP CLI is reachable. Four things need you, the human (A and B are mandatory; C and D are optional, skip-friendly, and reversible):**

**A. Create a Telegram bot.** Open Telegram, message [@BotFather](https://t.me/botfather), send `/newbot`, follow the prompts. Copy the bot token it gives you (looks like `123456:ABC-DEF...`).

**B. Find your Telegram user id.** Message [@userinfobot](https://t.me/userinfobot) once. It replies with your numeric id. (This avoids a chicken-and-egg: the bot's own `/whoami` would also tell you, but you need the id to boot the bot in the first place.)

**C. (Required if you've never used OMP on this machine) Configure your LLM provider.** Run `bunx --bun @oh-my-pi/pi-coding-agent` once — OMP launches its interactive TUI and walks you through picking a provider (OpenAI / Anthropic / GitHub Copilot / etc.) and signing in. Quit it (`Ctrl+C` or `/quit`) when the provider is set. State lands in `~/.omp/agent/config.yml`. Skip if you've used `omp` before — the existing config carries over.

**D. (Optional) Voice input.** If you want to send Telegram voice notes to the bot, install `ffmpeg` and `uv` (<https://github.com/astral-sh/uv>) — that's the whole setup, no config. The first voice message lazily bootstraps a whisper venv under `~/.omptg/whisper-venv/`. Skipping this now costs nothing: install the two binaries any time later and the next voice message just works. Text-only users can ignore.

**E. (Optional) Discord bridge.** omptg can also run on Discord side-by-side with Telegram (separate process, shared `~/.omptg/chats.json`). If you want it:
1. Create an application at <https://discord.com/developers/applications>, add a Bot, click **Reset Token**, copy the token.
2. On the same page enable the **MESSAGE CONTENT INTENT** (privileged).
3. OAuth2 → URL Generator → scopes `bot` + `applications.commands`, permissions `View Channels`, `Send Messages`, `Send Messages in Threads`, `Create Public Threads`, `Read Message History`, `Add Reactions`, `Use Slash Commands`. Open the generated URL, pick your server, authorize.
4. Paste the token into `DISCORD_BOT_TOKEN` in `.env` (and optionally fill `DISCORD_ALLOWED_GUILDS` / `DISCORD_ALLOWED_CHANNELS` / `DISCORD_DEV_GUILDS` — see inline comments). Boot with `bun run start:discord`.

Skip entirely if Discord isn't part of your setup — the Telegram process ignores all `DISCORD_*` vars.

When you return with the values from A and B, paste them and I will:
1. Write them into `.env` (`TELEGRAM_BOT_TOKEN=<from A>`, `TELEGRAM_ALLOWED_CHATS=<from B>`).
2. Start the bot with `bun start`.
3. Wait for the `boot.start` log line, then tell you to DM the bot and send `/start`.

EXECUTE NOW: Complete the TODO list above to achieve: a typechecked omptg checkout with the OMP CLI warmed and `.env` ready for two human-supplied values. Then print the HUMAN HANDOFF section and wait.
