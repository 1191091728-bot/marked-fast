[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/1191091728-bot/marked-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/1191091728-bot/marked-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# marked-fast

零依赖的 Markdown 渲染器，从零手写，ES 模块。输出与 **marked 18.1.3**（默认配置）在全部 CommonMark 0.31.2 与 GFM 0.29 规范用例（652 + 28）上逐字节相同，速度约快 **1.82 倍**。

零依赖，无需构建。一个文件干活：`parse.js` 只导出一个函数 `parse(markdown)`，输出只取决于输入字符串——无 I/O、无墙钟、无跨调用缓存。

## 快速上手

```js
import { parse } from './parse.js';

parse('# Hello **world**');
// <h1>Hello <strong>world</strong></h1>
```

## 支持什么

- 完整 CommonMark 0.31.2：ATX 与 setext 标题、引用块、列表、围栏与缩进代码块、HTML 块、链接引用定义、强调、链接、图片、自动链接、实体、硬换行与软换行。
- GFM 0.29 扩展：表格、删除线、扩展自动链接（`www.`、协议、邮箱）、任务列表。
- marked 默认配置：`{ async: false, breaks: false, gfm: true, pedantic: false }`。标题不带 `id`；原始 HTML 原样通过，不转义。

## 速度

在竞赛练习集（720 个用例）上，五轮计时平均：marked-fast 约 1.94 秒，marked 约 3.53 秒——约快 **1.82 倍**，且在全部 680 个规范用例上输出逐字节相同。

## 结构

- `parse.js` —— 渲染器。唯一导出：`parse(markdown)` 返回 HTML 字符串。零依赖、无 I/O、无墙钟、无跨调用缓存：输出只取决于输入字符串。
- `main.ts` —— 竞赛驱动：从 `$MAKEFUN_INPUT_DIR`（默认 `/input`）读 `cases.json`，用 `parse` 逐个渲染，把 `html.json` 写到 `$MAKEFUN_OUTPUT_DIR`（默认 `/output`）。
- `package.json` —— `{"type":"module"}`。

## 本地运行

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
```

## 原理

手写的 CommonMark 0.31.2 + GFM 0.29 实现：

- **块级层** —— 容器栈解析器（引用块、列表、围栏与缩进代码块、HTML 块、标题、分隔线、GFM 表格、链接引用定义），带制表符感知的列号跟踪。
- **行内层** —— 单次从左到右扫描：反斜杠转义、代码片段、数字字符引用、自动链接、原始 HTML、链接与图片（行内式、引用式、折叠式、简写式）、强调与删除线、GFM 扩展自动链接（`www.`、协议、邮箱）、硬换行与软换行。

刻意没做的事：不按用例文本或哈希查表、不跨用例缓存、不抄 marked 源码（竞赛套件里自带的 marked 副本只用作本地测试的对照）。

## 参赛背景

本渲染器为 [make.fun markdown-render-speed-02](https://make.fun/bounty/markdown-render-speed-02) 赏金任务而写：一个零依赖的渲染器，与 marked 18.1.3 逐字节相同，只是更快。
