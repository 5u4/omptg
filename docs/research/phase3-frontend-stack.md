# Phase 3 frontend stack decision

## Stack

- **Framework**: Preact 10.29.2 + @preact/signals (~6.5kb gz). No build step (esm.sh / importmap). Signals fit streaming token deltas — only the subscribing DOM subtree updates.
- **Markdown**: marked 18.0.4 (12.1kb gz, sync GFM, zero deps). Use `marked.parse()`; v5+ default `marked()` is async — avoid.
- **Sanitization**: DOMPurify on EVERY render of the streaming bubble, not just final.
- **Highlighting**: Shiki 1.x with `createJavaScriptRegexEngine()` — avoids the 231kb WASM blob; same grammars as VS Code; highlight.js/prism have TS/JSX gaps.
- **CSS**: hand-rolled with CSS variables. ~10 components doesn't earn Tailwind.
- **WebSocket**: reconnecting-websocket 4.4.0 (2.6kb gz). Cap `maxEnqueuedMessages: 10` — default Infinity is a footgun.

**Total bundle**: ~55-60kb gz (Preact 4.7 + signals 1.8 + marked 12.1 + DOMPurify ~21 + RWS 2.6 + Shiki core ~34 + app ~5).

## Streaming UX patterns

- Detect manual scroll → pause auto-scroll until user re-anchors (Claude/Cursor).
- Reserve layout for detected code blocks/tables so finalize doesn't reflow.
- Sanitize partial markdown on every delta (incomplete fences are a marked gotcha — guard with column-0 check for triple-backtick).

## Risks

- Shiki's JS regex engine doesn't cover all langs the WASM engine does → silently falls back to plaintext.
- marked's fence heuristic breaks for backticks mid-sentence; guard with column-0 check.
- reconnecting-websocket default `maxEnqueuedMessages: Infinity` will buffer indefinitely during long disconnects.
