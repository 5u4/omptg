# Phase 2 code review (commit 1f45ab6) — verdict: BLOCK on P1s

Reviewer-agent output. Bugs against the web-bridge backend before phase 3 lands.

## P1 (block before merge)

1. **CSWSH on /ws** — Bun.serve accepts any Origin; drive-by webpages can open ws://127.0.0.1:7878 and drive the agent. 127.0.0.1 binding does NOT prevent this (WS is exempt from same-origin policy). Fix: Origin allowlist + cwd allowlist.
2. **Concurrent session.send drops finalize** — second handler overwrites `chat.streamer`; first turn's WebStreamer never finalizes. Multi-tab story broken.
3. **turnActive never backfilled** — late subscriber sees `false` even mid-turn (hardcoded in listSessions, not stored in ring). Fix: track per-route turn state in bridge, include in summary.
4. **Turn errors swallowed** — log.error only, no `replace` envelope. Frontend can't tell failure from success.

## P2 (same cycle, cheap)

5. Non-atomic persist → torn write wipes session list. Fix: temp+rename.
6. Ring overflow silent gap → protocol needs `earliestSeq` in backfill.
7. ui.response from one client leaves siblings on stale dialog → broadcast `ui.cancel` on resolve.
8. cwd from client unvalidated.
9. patchSession { title: "" } clobbers existing titles → filter empty fields.

## P3 (hygiene)

10. message_update cast bypasses SDK discriminator.
11. chatStore parameter dead-wired.
12. Subscriber.subs map value never read.
13. toolEnd(toolName) accepted then voided.
14. SessionSummary.modelId never populated.
15. Test gaps: ring overflow, two subscribers mid-stream, unknown-key, interleave.
