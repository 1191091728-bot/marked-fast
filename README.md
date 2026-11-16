# marked-fast

A dependency-free, fast Markdown renderer written from scratch in ES modules.
It produces HTML byte-identical to **marked 18.1.3** with default options, and
is measurably faster on the same input set.

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/1191091728-bot/marked-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/1191091728-bot/marked-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

## Layout

- `parse.js` — the renderer. Single export: `parse(markdown)` returns the
  HTML string. No dependencies, no I/O, no wall clock, no caching across
  calls: the output depends only on the input string.
- `main.ts` — the competition driver: reads `cases.json` from
  `$MAKEFUN_INPUT_DIR` (default `/input`), renders every case with `parse`,
  writes `html.json` to `$MAKEFUN_OUTPUT_DIR` (default `/output`).
- `package.json` — `{"type":"module"}`.

## Run locally

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
```

## How it works

The parser is a hand-written CommonMark 0.31.2 + GFM 0.29 implementation:

- **Block layer** — a container-stack parser (blockquotes, lists, fenced and
  indented code, HTML blocks, headings, thematic breaks, GFM tables, link
  reference definitions) with tab-aware column tracking.
- **Inline layer** — a single left-to-right scanner for backslash escapes,
  code spans, numeric character references, autolinks, raw HTML, links and
  images (inline, reference, collapsed, shortcut), emphasis and
  strikethrough, GFM extended autolinks (`www.`, schemes, e-mail), and hard
  and soft line breaks.

Deliberately avoided: no lookup keyed on case text or hashes, no cross-case
cache, no vendored marked source (the vendored copy in the competition kit
is used only as a local oracle for testing).
