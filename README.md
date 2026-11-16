[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/1191091728-bot/marked-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/1191091728-bot/marked-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# marked-fast

A dependency-free Markdown renderer, written from scratch in ES modules. It renders HTML byte-identical to **marked 18.1.3** with default options on every CommonMark 0.31.2 and GFM 0.29 spec example (652 + 28), and runs about **1.82× faster** than marked on the same inputs.

Zero dependencies, no build step. One file does the work: `parse.js` exports a single function, `parse(markdown)`, and the output depends only on the input string — no I/O, no wall clock, no caching across calls.

## Quick start

```js
import { parse } from './parse.js';

parse('# Hello **world**');
// <h1>Hello <strong>world</strong></h1>
```

## What it supports

- Full CommonMark 0.31.2: ATX and setext headings, blockquotes, lists, fenced and indented code, HTML blocks, link reference definitions, emphasis, links, images, autolinks, entities, hard and soft line breaks.
- GFM 0.29 extensions: tables, strikethrough, extended autolinks (`www.`, schemes, e-mail), task lists.
- marked defaults: `{ async: false, breaks: false, gfm: true, pedantic: false }`. Headings carry no `id`; raw HTML passes through unescaped.

## Speed

On the competition practice set (720 cases), five timed rounds average ~1.94 s for marked-fast against ~3.53 s for marked — about **1.82× faster**, with byte-identical output on all 680 spec examples.

## Layout

- `parse.js` — the renderer. Single export: `parse(markdown)` returns the HTML string. No dependencies, no I/O, no wall clock, no caching across calls: the output depends only on the input string.
- `main.ts` — the competition driver: reads `cases.json` from `$MAKEFUN_INPUT_DIR` (default `/input`), renders every case with `parse`, writes `html.json` to `$MAKEFUN_OUTPUT_DIR` (default `/output`).
- `package.json` — `{"type":"module"}`.

## Run locally

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
```

## How it works

The parser is a hand-written CommonMark 0.31.2 + GFM 0.29 implementation:

- **Block layer** — a container-stack parser (blockquotes, lists, fenced and indented code, HTML blocks, headings, thematic breaks, GFM tables, link reference definitions) with tab-aware column tracking.
- **Inline layer** — a single left-to-right scanner for backslash escapes, code spans, numeric character references, autolinks, raw HTML, links and images (inline, reference, collapsed, shortcut), emphasis and strikethrough, GFM extended autolinks (`www.`, schemes, e-mail), and hard and soft line breaks.

Deliberately avoided: no lookup keyed on case text or hashes, no cross-case cache, no vendored marked source (the vendored copy in the competition kit is used only as a local oracle for testing).

## Built for

This renderer was built for the [make.fun markdown-render-speed-02](https://make.fun/bounty/markdown-render-speed-02) bounty: a dependency-free renderer matching marked 18.1.3 byte-for-byte, only faster.
