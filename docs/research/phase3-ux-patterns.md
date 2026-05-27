# Phase 3 UX patterns to steal from comparable UIs

## open-webui (SvelteKit + Tailwind)

- **Sidebar**: resizable 220-480px, persisted to localStorage; collapses to icon strip.
- **Tool calls**: collapsible display, spinner → checkmark state transition; `RESULT_PREVIEW_LIMIT = 10000` cap with show-more.

## chainlit (React)

- **Tool steps**: accordion with left border indent (`border-l-2 pl-2`).
- **BlinkingCursor**: shown while tool runs but no assistant message yet.
- **Inline AskActionButton**: rendered next to the message that asked, not in the input.

## continue.dev (React, VS Code webview)

- **ThinkingBlockPeek**: thinking content collapsed by default, expand to peek.
- Caveat: ~300px webview → patterns don't translate to wide layouts without adaptation.

## OpenHands

- **Action/observation pairs**: bordered list items, left-border tinted by success/error.

## LibreChat

- `scrollbar-gutter-stable` on message column — no horizontal-jiggle when scrollbar appears/disappears.

## Patterns to steal (concrete)

1. Sidebar resizable + persisted to localStorage (open-webui)
2. Tool call: collapsible card, icon transitions running → done → error (open-webui + chainlit)
3. Left border indent for nested traces (chainlit + OpenHands)
4. Thinking block: collapsed peek (continue.dev)
5. Inline ui.request rendered next to triggering message, not in input (chainlit AskActionButton)
6. `scrollbar-gutter-stable` (LibreChat)
7. BlinkingCursor while waiting for first token (chainlit)
8. Auto-scroll with manual-scroll pause (Claude/Cursor — universal)
9. Sidebar collapse to icons on narrow viewport (open-webui)
10. Tool result preview limit + "show more" (open-webui)
