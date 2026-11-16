// A fast CommonMark 0.31.2 + GFM renderer, written from scratch to match
// marked 18.1.3's default output (gfm on, breaks off) byte for byte.
// Dependency-free ES module. Only export: parse(markdown) -> string.
// No state is kept between calls; every call depends only on its input.

const NEWLINE = 10; // \n
const SPACE = 32;
const TAB = 9;
const BACKSLASH = 92;
const BACKTICK = 96;
const STAR = 42;
const UNDER = 95;
const TILDE = 126;
const LT = 60;
const GT = 62;
const AMP = 38;
const LBRACKET = 91;
const RBRACKET = 93;
const BANG = 33;
const HASH = 35;

// ---- character classes (ASCII fast paths; Unicode via cached regex) ----
const PUNCT_TABLE = new Uint8Array(128);
for (const ch of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') PUNCT_TABLE[ch.charCodeAt(0)] = 1;
const SPACE_TABLE = new Uint8Array(128);
for (const ch of ' \t\n\v\f\r') SPACE_TABLE[ch.charCodeAt(0)] = 1;

const _punctRe = /[\p{P}]/u;
const _punctCache = new Map();
function isPunct(code) {
  return code < 128 && PUNCT_TABLE[code] === 1;
}
const _spaceRe = /\s/u;
const _spaceCache = new Map();
function isSpace(code) {
  if (code < 128) return SPACE_TABLE[code] === 1;
  const ch = String.fromCodePoint(code);
  let v = _spaceCache.get(ch);
  if (v === undefined) { v = _spaceRe.test(ch); _spaceCache.set(ch, v); }
  return v;
}
function isDigit(code) { return code >= 48 && code <= 57; }
function isAlpha(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}
function isAlnum(code) { return isAlpha(code) || isDigit(code); }

// Unicode letter/number (word char for the emphasis-blocking rule),
// excluding '_' (which does not block). ASCII is covered by \p{L}/\p{N}
// too, but keep the fast path.
const WORD_RE = /[\p{L}\p{N}]/u;
function isWordChar(code) {
  return code !== 0 && (isAlnum(code) || WORD_RE.test(String.fromCharCode(code)));
}

// ---- escaping ----
// Text / attribute escaping (marked's "noEncode" mode): escape < > " ' always,
// and & only when it does not start a valid entity reference
// (&...; with word chars, or &#digits; / &#xhex;).
function escapeText(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) { // &
      // valid entity? &word;  &#1-7digits;  &#x1-6hex;
      let j = i + 1;
      if (s.charCodeAt(j) === 35) { // #
        j++;
        let hex = false;
        if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) { hex = true; j++; } // x/X
        const d0 = j;
        const maxD = hex ? 6 : 7;
        while (j < s.length && j - d0 < maxD) {
          const dc = s.charCodeAt(j);
          const ok = dc >= 48 && dc <= 57 || hex && (dc >= 97 && dc <= 102 || dc >= 65 && dc <= 70);
          if (!ok) break;
          j++;
        }
        if (j > d0 && s.charCodeAt(j) === 59) { i = j; continue; }
      } else {
        while (j < s.length && (isAlnum(s.charCodeAt(j)))) j++;
        if (j > i + 1 && s.charCodeAt(j) === 59) { i = j; continue; }
      }
      rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (i > start) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  if (start === 0) return s;
  if (start < s.length) out += s.slice(start);
  return out;
}
// Code content escaping (marked's "encode" mode): escape every & < > " '.
function escapeCode(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (i > start) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  if (start === 0) return s;
  if (start < s.length) out += s.slice(start);
  return out;
}

// Decode a numeric character reference starting at s[i] === '&'.
// Returns [decodedChar, endIndex] or null when it is not one.
function decodeNumericRef(s, i) {
  if (s.charCodeAt(i + 1) !== 35) return null; // #
  let j = i + 2;
  let hex = false;
  if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) { hex = true; j++; }
  const d0 = j;
  const maxDigits = hex ? 6 : 7;
  let v = 0;
  while (j < s.length && j - d0 < maxDigits) {
    const c = s.charCodeAt(j);
    let d = -1;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (hex && c >= 97 && c <= 102) d = c - 87;
    else if (hex && c >= 65 && c <= 70) d = c - 55;
    if (d < 0) break;
    v = v * (hex ? 16 : 10) + d;
    if (v > 0x10FFFF) v = 0x110000; // clamp: will become U+FFFD
    j++;
  }
  if (j === d0) return null;
  if (s.charCodeAt(j) !== 59) return null; // ;
  if (v === 0 || v > 0x10FFFF || (v >= 0xD800 && v <= 0xDFFF)) v = 0xFFFD;
  return [String.fromCodePoint(v), j + 1];
}

// href encoding: encodeURI, exactly as marked applies it.
function encodeHref(s) {
  // marked does not percent-encode '%' at all (a bare '%' stays '%', and
  // a valid sequence like %2F stays as-is); encodeURI would turn a bare
  // '%' into %25, so encode the '%' separated parts instead
  return s.split('%').map(encodeURI).join('%');
}

// HTML block start tags (type 6), from the CommonMark spec.
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup ' +
  'dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 ' +
  'head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param ' +
  'search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// Link label normalization: collapse whitespace runs to one space, trim, lowercase.
function normalizeLabel(s) {
  let out = '';
  let pendingSpace = false;
  let started = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12) {
      if (started) pendingSpace = true;
    } else {
      if (pendingSpace) { out += ' '; pendingSpace = false; }
      const lc = s[i].toLowerCase();
      // full Unicode case folding: ẞ/ß both fold to "ss" (cm-540: [ẞ]
      // matches the definition [SS]: /url)
      out += (lc === 'ß') ? 'ss' : lc;
      started = true;
    }
  }
  return out;
}

// ============================================================
// Block parsing
// ============================================================

function newNode(t, parent) {
  const n = { t, ch: [], parent: parent || null, open: true, lb: false };
  if (parent) parent.ch.push(n);
  return n;
}

// Line cursor: text (mutable when a tab is partially consumed), off (string
// index), col (visual column, tabs advance to the next multiple of 4).
function lineInit(P, text) {
  P.ltext = text;
  P.loff = 0;
  P.lcol = 0;
  P.llen = text.length;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c !== 32 && c !== 9) break;
    i++;
  }
  P.lblank = i >= text.length;
}
// columns of indentation from the current position (spaces/tabs only)
function peekIndent(P) {
  let col = P.lcol;
  let i = P.loff;
  while (i < P.llen) {
    const c = P.ltext.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  return col - P.lcol;
}
// advance n columns (handles a partially consumed tab by rewriting it)
function advanceCols(P, n) {
  while (n > 0 && P.loff < P.llen) {
    const c = P.ltext.charCodeAt(P.loff);
    if (c === 32) { P.loff++; P.lcol++; n--; }
    else if (c === 9) {
      const w = 4 - (P.lcol % 4);
      if (n >= w) { P.loff++; P.lcol += w; n -= w; }
      else {
        P.ltext = P.ltext.slice(0, P.loff) + ' '.repeat(w) + P.ltext.slice(P.loff + 1);
        P.llen = P.ltext.length;
        P.loff += n; P.lcol += n; n = 0;
      }
    } else break;
  }
}
// advance while the current char is a space or tab (fully)
function advanceSpaces(P) {
  while (P.loff < P.llen) {
    const c = P.ltext.charCodeAt(P.loff);
    if (c === 32) { P.loff++; P.lcol++; }
    else if (c === 9) { P.lcol += 4 - (P.lcol % 4); P.loff++; }
    else break;
  }
}
function curChar(P) {
  return P.loff < P.llen ? P.ltext.charCodeAt(P.loff) : 10;
}
// remaining text of the line from the current position
function rest(P) { return P.ltext.slice(P.loff); }

// Is the line (from the current position) blank?
function restBlank(P) {
  for (let i = P.loff; i < P.llen; i++) {
    const c = P.ltext.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// last open child of a container, or null
function lastOpenChild(n) {
  if (!n.ch.length) return null;
  const c = n.ch[n.ch.length - 1];
  return c.open ? c : null;
}

// Try to continue an open block with the current line. Advances the line
// cursor past the block's marker/indent on success. Returns false when the
// block cannot contain this line.
function continueBlock(P, b) {
  switch (b.t) {
    case 'doc': case 'list': case 'heading':
      return true;
    case 'para':
      // a blank line ends a paragraph
      return !P.lblank;
    case 'quote': {
      // up to 3 spaces, then '>', then at most one space/tab column.
      // A blank line with no '>' marker ends the blockquote; a line that
      // is just '>' (or '> ' ) continues it.
      const ind = peekIndent(P);
      if (ind > 3) {
        // a fenced code block's content lines are protected by the fence
        if (P.tip.t === 'code' && P.tip.fenced) return true;
        return false;
      }
      advanceCols(P, ind);
      if (curChar(P) !== 62) return false; // >
      P.loff++; P.lcol++;
      if (curChar(P) === 32 || curChar(P) === 9) advanceCols(P, 1);
      return true;
    }
    case 'item': {
      const relPad = b.pad - (b.baseCol || 0);
      // blank after the outer container markers were consumed (a line of
      // just quote markers counts as blank here)
      if (/^[ \t]*$/.test(rest(P))) {
        // a blank line continues an item that already has content; an
        // empty item is closed by a blank line. Consume only the item's
        // own indent (relPad), not all whitespace: a tab straddling the
        // indent boundary leaves its remainder as spaces (marked keeps
        // 2 spaces for a lone tab in a relPad-2 item), which the
        // blank-line branch then strips by the fence indent.
        if (b.ch.length > 0) { advanceCols(P, relPad); return true; }
        return false;
      }
      const ind = peekIndent(P);
      if (ind >= relPad) { advanceCols(P, relPad); return true; }
      // A fenced code block's content lines are protected by the fence
      // ONLY once the fence has at least one content line: if the FIRST
      // content line does not reach the item's content column, the fence
      // ends empty (marked) and the item closes. (doc-13: a ` ````sh `
      // fence whose first content line is at column 0 produces an empty
      // code block; doc-02: the first content line is indented, so later
      // column-0 lines stay protected.)
      if (P.tip.t === 'code' && P.tip.fenced) {
        if (P.tip.str.length === 0) return false;
        return true;
      }
      return false;
    }
    case 'code': {
      if (b.fenced) return true;
      // indented code: blank line, or indent >= 4
      if (P.lblank) return true;
      if (peekIndent(P) >= 4) { advanceCols(P, 4); return true; }
      return false;
    }
    case 'html': {
      if (b.ended) return false;
      if (b.kind === 7) return !P.lblank;
      return true;
    }
    case 'table': {
      // a table continues on non-blank lines; a line of only spaces
      // plus a single tab is a table row of empty cells, not a blank line
      if (!P.lblank) return true;
      return /^ *\t$/.test(P.ltext);
    }
  }
  return true;
}

// Close (finalize) a block. Paragraphs lose their link reference
// definitions here; lists get their tight/loose flag.
function finalize(P, b) {
  b.open = false;
  if (b.t === 'html' && !P.atEof && !b.ended &&
      b.str.length > 0 && b.str.charCodeAt(b.str.length - 1) === 10) {
    // closed by a blank line or interrupted by a new block: drop the
    // trailing newline; a block that ended at its terminator keeps it
    b.str = b.str.slice(0, -1);
  }
  if (b.t === 'para') {
    b.str = parseLinkDefs(P, b.str);
    if (b.str.length === 0) {
      // remove the paragraph from its parent
      const sibs = b.parent.ch;
      const i = sibs.indexOf(b);
      if (i >= 0) sibs.splice(i, 1);
    }
  } else if (b.t === 'list') {
    let loose = false;
    for (let it = 0; it < b.ch.length; it++) {
      const item = b.ch[it];
      if (item.lb && it < b.ch.length - 1) { loose = true; break; }
      for (let k = 0; k < item.ch.length; k++) {
        const sub = item.ch[k];
        if (sub.lb && k < item.ch.length - 1) { loose = true; break; }
      }
      if (loose) break;
    }
    b.tight = !loose;
  }
}

// Close every open block from the tip down to (but not including) `stop`.
function closeTo(P, stop) {
  while (P.tip !== stop && P.tip) {
    const b = P.tip;
    P.tip = b.parent;
    finalize(P, b);
  }
}

// ---- block start checks (at the current line position) ----
// Scan the leading spaces/tabs from the current position: returns the string
// index just past them and how many columns they span.
function indentEnd(P) {
  let off = P.loff, col = P.lcol;
  while (off < P.llen) {
    const c = P.ltext.charCodeAt(off);
    if (c === 32) { col++; off++; }
    else if (c === 9) { col += 4 - (col % 4); off++; }
    else break;
  }
  return { off, cols: col - P.lcol };
}
// ATX heading: indent 0-3, 1-6 #, then space/tab or end of line.
// Returns the level, or 0.
function matchAtx(P) {
  const ie = indentEnd(P);
  if (ie.cols > 3) return 0;
  const i = ie.off;
  let n = 0;
  while (i + n < P.llen && P.ltext.charCodeAt(i + n) === 35 && n < 6) n++;
  if (n === 0) return 0;
  if (n === 6 && i + 6 < P.llen && P.ltext.charCodeAt(i + 6) === 35) return 0;
  const after = i + n;
  if (after < P.llen) {
    const c = P.ltext.charCodeAt(after);
    if (c !== 32 && c !== 9) return 0;
  }
  return n;
}
// Fenced code: indent 0-3, then 3+ backticks or 3+ tildes.
function matchFence(P) {
  const ie = indentEnd(P);
  if (ie.cols > 3) return null;
  const i = ie.off;
  if (i >= P.llen) return null;
  const c = P.ltext.charCodeAt(i);
  if (c !== 96 && c !== 126) return null;
  let n = 0;
  while (i + n < P.llen && P.ltext.charCodeAt(i + n) === c) n++;
  if (n < 3) return null;
  let info = P.ltext.slice(i + n);
  if (c === 96 && info.indexOf('`') >= 0) return null;
  // backslash escapes are processed in the info string
  info = info.replace(/\\([!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~])/g, '$1').trim();
  return { ch: c, len: n, off: i, cols: ie.cols, info };
}
// Thematic break: indent 0-3, then 3+ of -, _, or * with only spaces/tabs between.
function matchHr(P) {
  const ie = indentEnd(P);
  if (ie.cols > 3) return false;
  let i = ie.off;
  if (i >= P.llen) return false;
  const c = P.ltext.charCodeAt(i);
  if (c !== 45 && c !== 95 && c !== 42) return false;
  let n = 0;
  while (i < P.llen) {
    const d = P.ltext.charCodeAt(i);
    if (d === c) { n++; i++; }
    else if (d === 32 || d === 9) i++;
    else return false;
  }
  return n >= 3;
}
// Setext underline: indent 0-3, then only = or only -, then only spaces/tabs.
function matchSetext(P) {
  const ie = indentEnd(P);
  if (ie.cols > 3) return 0;
  let i = ie.off;
  if (i >= P.llen) return 0;
  const c = P.ltext.charCodeAt(i);
  if (c !== 61 && c !== 45) return 0;
  // a contiguous run of = or -, then only trailing whitespace
  while (i < P.llen && P.ltext.charCodeAt(i) === c) i++;
  while (i < P.llen && (P.ltext.charCodeAt(i) === 32 || P.ltext.charCodeAt(i) === 9)) i++;
  if (i < P.llen) return 0;
  return c === 61 ? 1 : 2;
}
// List marker: indent 0-3, then bullet (- + *) or ordered (1-9 digits + . or )).
// Returns {bullet, start, delim, w, off, cols} where w is the marker width in
// characters and off is the string index of the marker.
function matchList(P) {
  const ie = indentEnd(P);
  if (ie.cols > 3) return null;
  const i = ie.off;
  if (i >= P.llen) return null;
  const c = P.ltext.charCodeAt(i);
  if (c === 45 || c === 43 || c === 42) {
    const after = i + 1;
    if (after >= P.llen) return { bullet: true, start: 0, delim: '', ch: c, w: 1, off: i, cols: ie.cols };
    const d = P.ltext.charCodeAt(after);
    if (d !== 32 && d !== 9) return null;
    return { bullet: true, start: 0, delim: '', ch: c, w: 1, off: i, cols: ie.cols };
  }
  if (c >= 48 && c <= 57) {
    let j = i;
    let v = 0;
    while (j < P.llen && j - i < 9) {
      const d = P.ltext.charCodeAt(j);
      if (d < 48 || d > 57) break;
      v = v * 10 + (d - 48);
      j++;
    }
    if (j === i || j - i > 9) return null;
    if (j < P.llen && (P.ltext.charCodeAt(j) === 46 || P.ltext.charCodeAt(j) === 41)) {
      const delim = P.ltext.charCodeAt(j) === 46 ? '.' : ')';
      const after = j + 1;
      if (after >= P.llen) return { bullet: false, start: v, delim, ch: 0, w: after - i, off: i, cols: ie.cols };
      const d = P.ltext.charCodeAt(after);
      if (d !== 32 && d !== 9) return null;
      return { bullet: false, start: v, delim, ch: 0, w: after - i, off: i, cols: ie.cols };
    }
  }
  return null;
}
// Blockquote marker: indent 0-3, then '>'.
function matchQuote(P) {
  const ie = indentEnd(P);
  if (ie.cols > 3) return false;
  return P.ltext.charCodeAt(ie.off) === 62;
}
// HTML block start. Returns the type (1-7) or 0.
function matchHtml(P, inPara) {
  const ie = indentEnd(P);
  if (ie.cols > 3) return 0;
  const i = ie.off;
  const s = P.ltext;
  if (i >= P.llen || s.charCodeAt(i) !== 60) return 0; // <
  const c1 = s.charCodeAt(i + 1);
  // <!--  (type 2)
  if (c1 === 33 && s.charCodeAt(i + 2) === 45 && s.charCodeAt(i + 3) === 45) return 2;
  // <?  (type 3)
  if (c1 === 63) return 3;
  // <!letter  (type 4) or <![CDATA[  (type 5)
  if (c1 === 33) {
    const c2 = s.charCodeAt(i + 2);
    if ((c2 >= 65 && c2 <= 90) || (c2 >= 97 && c2 <= 122)) return 4;
    if (s.slice(i + 2, i + 9) === '[CDATA[') return 5;
    return 0;
  }
  // <script <pre <style <textarea  (type 1, opening tags only)
  if (isAlpha(c1) || c1 === 47) {
    let j = i + (c1 === 47 ? 2 : 1);
    let name = '';
    while (j < P.llen && isAlpha(s.charCodeAt(j))) { name += s[j].toLowerCase(); j++; }
    if (c1 !== 47 && (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea')) {
      const d = s.charCodeAt(j);
      if (j >= P.llen || d === 32 || d === 9 || d === 62) return 1;
    }
    if (BLOCK_TAGS.has(name)) {
      // type 6: tag followed by space, tab, '>', '/>' or end of line
      const d = s.charCodeAt(j);
      if (j >= P.llen || d === 32 || d === 9 || d === 62) return 6;
      if (d === 47 && s.charCodeAt(j + 1) === 62) return 6;
      return 0;
    }
    // type 7: a complete open or closing tag, and nothing else on the line
    // (a type-7 block cannot interrupt a paragraph)
    if (name.length > 0) {
      if (inPara) return 0;
      const end = scanTag(s, i, P.llen);
      if (end !== -1) {
        let m = end;
        while (m < P.llen && (s.charCodeAt(m) === 32 || s.charCodeAt(m) === 9)) m++;
        if (m >= P.llen) return 7;
      }
      return 0;
    }
  }
  return 0;
}
// GFM table delimiter row. Returns the alignment array or null.
function matchTableDelim(P) {
  const ie = indentEnd(P);
  if (ie.cols > 3) return null;
  const s = P.ltext.slice(ie.off);
  const cells = splitTableRow(s);
  if (cells.length === 0) return null;
  const align = [];
  for (const cell of cells) {
    const t = cell.trim();
    if (!/^(?::?-+:?)$/.test(t)) return null;
    align.push(t.charCodeAt(0) === 58 && t.charCodeAt(t.length - 1) === 58 ? 'center'
      : t.charCodeAt(0) === 58 ? 'left'
      : t.charCodeAt(t.length - 1) === 58 ? 'right' : null);
  }
  return align;
}
// Split a table row on unescaped '|'. Leading/trailing pipes are stripped;
// cells keep their raw text. A row without '|' is a single cell.
function splitTableRow(s) {
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && s.charCodeAt(i + 1) === 124) {
      // an escaped pipe is a literal pipe in the cell (the backslash is
      // consumed by the split, not left for inline parsing)
      cur += '|';
      i++;
    } else if (c === 124) {
      cells.push(cur);
      cur = '';
    } else {
      cur += s[i];
    }
  }
  cells.push(cur);
  // strip a leading empty cell (leading pipe) and a trailing empty cell
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells;
}
// ---- link reference definitions ----
// Parse as many link reference definitions as possible from the start of a
// paragraph's text. Returns the remaining text. Definitions go into P.refmap
// (first definition of a label wins).
function parseLinkDefs(P, text) {
  let pos = 0;
  const n = text.length;
  while (pos < n) {
    let i = pos;
    // up to 3 spaces of indentation (a definition may start on a new line)
    let sp = 0;
    while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9) && sp < 4) {
      if (text.charCodeAt(i) === 9) sp += 4 - (sp % 4); else sp++;
      i++;
    }
    if (sp >= 4) break;
    // allow a blank-ish separation? No: definitions must follow each other
    // directly (possibly across lines). Skip newlines between definitions.
    if (text.charCodeAt(i) === 10) { pos = i + 1; continue; }
    const def = tryParseDef(text, i);
    if (!def) break;
    const label = normalizeLabel(def.label);
    // a whitespace-only label is not a definition at all (cm-552: the
    // [\n ]: /uri paragraph stays as literal text)
    if (label.length === 0) break;
    if (!P.refmap.has(label)) {
      P.refmap.set(label, { dest: def.dest, title: def.title });
    }
    pos = def.end;
  }
  return text.slice(pos);
}

// Try to parse one link reference definition starting at text[i] === '['.
// Returns {label, dest, title, end} or null.
function tryParseDef(text, i) {
  const n = text.length;
  const lab = parseLinkLabel(text, i);
  if (!lab) return null;
  let j = lab.end;
  if (text.charCodeAt(j) !== 58) return null; // :
  j++;
  // optional whitespace, possibly across lines
  j = skipWsNl(text, j);
  // destination
  let dest;
  if (text.charCodeAt(j) === 60) { // <...>
    let k = j + 1;
    let ok = false;
    while (k < n) {
      const c = text.charCodeAt(k);
      if (c === 10 || c === 60) break;
      if (c === 62) { ok = true; break; }
      if (c === 92 && k + 1 < n && isPunct(text.charCodeAt(k + 1))) { k += 2; continue; }
      k++;
    }
    if (!ok) return null;
    dest = text.slice(j + 1, k);
    j = k + 1;
  } else {
    const d = parseBareDest(text, j);
    if (!d) return null;
    dest = d.dest;
    j = d.end;
  }
  // optional title: on this line (after spaces/tabs) or on the next line.
  // A title must be separated from the destination by whitespace.
  let title = null;
  let end = -1;
  let titleOnNextLine = false;
  let k = j;
  while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
  // a title must be separated from the destination by whitespace
  if (k === j && k < n) {
    const c0 = text.charCodeAt(k);
    if (c0 === 34 || c0 === 39 || c0 === 40) return null;
  }
  const tryTitle = (pos) => {
    if (pos >= n) return -1;
    const c = text.charCodeAt(pos);
    if (c !== 34 && c !== 39 && c !== 40) return -1;
    const t = parseTitle(text, pos);
    return t ? t.end : -2;
  };
  let tEnd = tryTitle(k);
  if (tEnd === -2) return null;
  if (tEnd >= 0) { title = parseTitle(text, k).title; end = tEnd; }
  else if (k < n && text.charCodeAt(k) === 10) {
    // no title on this line: try the next line
    let k2 = k + 1;
    while (k2 < n && (text.charCodeAt(k2) === 32 || text.charCodeAt(k2) === 9)) k2++;
    tEnd = tryTitle(k2);
    if (tEnd === -2) return null;
    if (tEnd >= 0) { title = parseTitle(text, k2).title; end = tEnd; titleOnNextLine = true; }
    else end = k; // no title: the definition ends at this newline
  } else if (k < n) {
    // junk after the destination on the same line
    return null;
  } else {
    end = k; // end of text
  }
  // after the title (or destination), only spaces/tabs up to a newline/end
  let m = end;
  while (m < n && (text.charCodeAt(m) === 32 || text.charCodeAt(m) === 9)) m++;
  if (m < n && text.charCodeAt(m) !== 10) {
    // a next-line title followed by junk: fall back to the definition
    // without a title, ending at the newline after the destination
    if (titleOnNextLine) {
      title = null;
      end = k;
      m = k;
      if (m < n) m++;
      return { label: lab.label, dest, title, end: m };
    }
    return null;
  }
  if (m < n) m++; // consume the newline
  return { label: lab.label, dest, title, end: m };
}

// Skip spaces/tabs/newlines.
function skipWsNl(text, i) {
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10) i++;
    else break;
  }
  return i;
}

// Parse a link label starting at text[i] === '['. The label may contain
// balanced brackets and backslash escapes, and may span lines. Returns
// {label, end} (end is the index just past ']') or null. Labels are at most
// 999 characters.
// A link label runs to the first unescaped ']' and must not contain an
// unescaped '[' (marked does not allow a bracket inside a label:
// [ref[bar]] and [ref[] are not labels, so the definition [ref[bar]]:
// /uri is not a definition either).
function parseLinkLabel(text, i) {
  const n = text.length;
  if (text.charCodeAt(i) !== 91) return null;
  let j = i + 1;
  let len = 0;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === 92 && j + 1 < n && (isPunct(text.charCodeAt(j + 1)) || text.charCodeAt(j + 1) === 10)) { j += 2; len += 2; continue; }
    if (c === 91) return null;
    if (c === 93) {
      if (len === 0 || len > 999) return null;
      return { label: text.slice(i + 1, j), end: j + 1 };
    }
    j++;
    len++;
    if (len > 999) return null;
  }
  return null;
}

// Parse a bare link destination starting at i: no spaces/control chars,
// balanced parentheses (backslash-escaped parens do not count). Returns
// {dest, end} or null.
function parseBareDest(text, i) {
  const n = text.length;
  let j = i;
  let parens = 0;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === 32 || c === 10 || c < 32) break;
    if (c === 92 && j + 1 < n && isPunct(text.charCodeAt(j + 1))) { j += 2; continue; }
    if (c === 40) parens++;
    else if (c === 41) {
      if (parens === 0) break;
      parens--;
    }
    j++;
  }
  if (j === i) return null;
  return { dest: text.slice(i, j), end: j };
}

// Parse a link title starting at i: "..." or '...' or (...).
// Returns {title, end} or null.
function parseTitle(text, i) {
  const n = text.length;
  const c = text.charCodeAt(i);
  if (c === 34 || c === 39) { // " or '
    let j = i + 1;
    while (j < n) {
      const d = text.charCodeAt(j);
      if (d === 92 && j + 1 < n && isPunct(text.charCodeAt(j + 1))) { j += 2; continue; }
      if (d === c) return { title: text.slice(i + 1, j), end: j + 1 };
      j++;
    }
    return null;
  }
  if (c === 40) { // (...)
    let j = i + 1;
    let depth = 0;
    while (j < n) {
      const d = text.charCodeAt(j);
      if (d === 92 && j + 1 < n && isPunct(text.charCodeAt(j + 1))) { j += 2; continue; }
      if (d === 40) depth++;
      else if (d === 41) {
        if (depth === 0) return { title: text.slice(i + 1, j), end: j + 1 };
        depth--;
      } else if (d === 10) return null;
      j++;
    }
    return null;
  }
  return null;
}

// Resolve backslash escapes in a destination/title: \punct -> punct, and
// \<newline> -> nothing (a backslash-newline is removed).
function unescapeDest(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d === 10) { i++; continue; }
      if (isPunct(d)) { out += s[i + 1]; i++; continue; }
    }
    out += s[i];
  }
  return out;
}

// Does `line` contain the closing tag </name> (name case-insensitive)?
function htmlHasEndTag(line, name) {
  const s = line.toLowerCase();
  const needle = '</' + name;
  let i = s.indexOf(needle);
  while (i >= 0) {
    const after = s.charCodeAt(i + needle.length);
    if (after === 62 || after === 32 || after === 9 || after === 47 || Number.isNaN(after)) return true;
    i = s.indexOf(needle, i + 1);
  }
  return false;
}


// After closing the tip down to `parent`, if `parent` is a list then a
// non-list-item block cannot be its child: finalize the list and return
// the list's parent as the real insertion point.
function closeListParent(P, parent) {
  if (parent.t === 'list') {
    finalize(P, parent);
    return parent.parent;
  }
  return parent;
}

// ---- the main line loop ----
function incorporateLine(P, lineText) {
  lineInit(P, lineText);

  // Phase 1: match open blocks, deepest first.
  let container = P.doc;
  let allMatched = true;
  for (;;) {
    const child = lastOpenChild(container);
    if (!child) break;
    if (!continueBlock(P, child)) { allMatched = false; break; }
    container = child;
  }

  // A line is blank when nothing but whitespace remains after its container
  // markers are consumed (so a lone ">" line is blank, as is a raw blank).
  let blank = /^[ \t]*$/.test(rest(P));
  if (blank && P.tip.t === 'table' && /^ *\t$/.test(rest(P))) {
    // A line of only spaces plus a single tab is NOT a blank line inside
    // a table: marked treats it as a table row of empty cells (while a
    // spaces-only line, a tab followed by a space, or two tabs do end
    // the table).
    blank = false;
  }
  if (blank && rest(P).length > 0 && P.isLastLine &&
      (P.loff > 0 || !P.srcEndsNl)) {
    // a whitespace-only last line is content (a paragraph continuation),
    // not a blank line, when container markers were consumed or when the
    // input does not end with a newline
    blank = false;
  }

  // Phase 2 + 3.
  if (blank) {
    // Mark the line's blankness on every still-open block, except when
    // the blank line is content of a code/HTML block (it does not
    // separate blocks, so it must not loosen a list).
    const blankIsContent = P.tip.t === 'code' ||
      (P.tip.t === 'html' && P.tip.kind <= 5 && !P.tip.ended);
    if (!blankIsContent) {
      // Also mark the container's last child: the blank line follows it
      // (e.g. a code block just closed by its fence).
      const last = container.ch.length ? container.ch[container.ch.length - 1] : null;
      if (last) last.lb = true;
      if (P.loff > 0) {
        // The blank line consumed a container marker (e.g. a lone ">"
        // line): it is a blank line INSIDE that container, so it only
        // separates content within the container. Set lb on the tip up
        // to the container and no further (cm-320: a ">" blank line
        // inside a quote must not loosen the list holding the quote).
        let b = P.tip;
        while (b) { b.lb = true; if (b === container) break; b = b.parent; }
      } else {
        // A bare blank line (no marker consumed): set lb on the tip and
        // ALL its ancestors, optimistically. The first non-blank line
        // after it clears lb on the ancestors above its own container
        // (see the non-blank path below), so only the level where the
        // separation really happens keeps lb (cm-325: the following
        // paragraph is a child of the outer item, so the inner list
        // keeps lb; cm-319: the following paragraph is a child of the
        // inner item, so the inner list and outer item lose lb; cm-326:
        // the following item is a child of the outer list, so the outer
        // item keeps lb).
        let b = P.tip;
        while (b) { b.lb = true; b = b.parent; }
        P.blankPending = true;
      }
    }
    if (!allMatched) {
      // phase 1 failed: the tip did not continue, so the blank line
      // closes the blocks below the deepest matched container (e.g. a
      // blockquote ended by a marker-less blank line). An ended HTML
      // block drops its trailing newline when so closed.
      const tip = P.tip;
      if (tip.t === 'html' && tip.ended && tip.str.length > 0 &&
          tip.str.charCodeAt(tip.str.length - 1) === 10) {
        tip.str = tip.str.slice(0, -1);
      }
      closeTo(P, container);
      return;
    }
    if (P.tip.t === 'code') {
      // blank lines are content of fenced/indented code blocks, with the
      // block's indent stripped (fence indent, or 4 for indented code).
      // A tab straddling the strip boundary is removed as a whole
      // (marked: fence indent 3 + a lone tab gives an empty line, not a
      // 1-space remainder), so strip with a whole-tab loop, not
      // advanceCols (which rewrites a partial tab into spaces).
      const strip = P.tip.fenced ? P.tip.fenceIndent : 4;
      let n = Math.min(strip, peekIndent(P));
      while (n > 0 && P.loff < P.llen) {
        const c = P.ltext.charCodeAt(P.loff);
        if (c === 32) { P.loff++; P.lcol++; n--; }
        else if (c === 9) { const w = 4 - (P.lcol % 4); P.loff++; P.lcol += w; n -= w; if (n < 0) n = 0; }
        else break;
      }
      addCodeLine(P, P.tip, rest(P));
    } else if (P.tip.t === 'html' && P.tip.kind <= 5 && !P.tip.ended) {
      // blank lines are content of HTML blocks of types 1-5 only (and
      // only while the block has not ended at its terminator)
      addCodeLine(P, P.tip, '');
    } else if (P.tip.t === 'para' || P.tip.t === 'table' || P.tip.t === 'html') {
      // a blank line ends paragraphs, tables and type-6/7 HTML blocks; an
      // HTML block that already ended at its terminator drops its trailing
      // newline here (finalize skips ended blocks)
      if (P.tip.t === 'html' && P.tip.ended && P.tip.str.length > 0 &&
          P.tip.str.charCodeAt(P.tip.str.length - 1) === 10) {
        P.tip.str = P.tip.str.slice(0, -1);
      }
      const parent = (container.t === 'para' || container.t === 'table' ||
        container.t === 'code' || container.t === 'html') ? container.parent : container;
      closeTo(P, parent);
    }
    // otherwise the blank line just sits in the containers
    return;
  }

  // Non-blank line: the blank flag is cleared only when a line is added
  // to a block itself (see the add-line section below), never on a
  // container: a blank line before a link definition inside an item still
  // separates that item from the next one.

  // If a blank line set lb on all ancestors, this line's container is
  // where the following content lands: clear lb on the ancestors above
  // that container, keeping it on the container and below (see above).
  if (P.blankPending) {
    P.blankPending = false;
    let b = container.parent;
    while (b) { b.lb = false; b = b.parent; }
  }

  // Setext heading: the tip is a paragraph, this line is its underline, and
  // phase 1 matched the paragraph (a lazy continuation line is never one).
  if (P.tip.t === 'para' && allMatched) {
    const level = matchSetext(P);
    if (level > 0) {
      const para = P.tip;
      // link reference definitions at the start of the paragraph are
      // extracted first; the remaining text becomes the heading
      const rest = parseLinkDefs(P, para.str).trim();
      if (rest.length === 0) {
        // the paragraph was only definitions: drop it and let this line
        // be processed as a fresh block (fall through, do not return)
        closeTo(P, para.parent);
      } else {
        para.t = 'heading';
        para.level = level;
        para.str = rest;
        closeTo(P, para.parent);
        return;
      }
    }
  }

  // Check for new block starts, looping so a blockquote or list item can be
  // created and then re-checked for another start on the same line.
  for (;;) {
    // a code or HTML block that phase 1 matched consumes the line itself
    // (content or closing fence); no new block can start on it
    if (allMatched && (P.tip.t === 'code' || P.tip.t === 'html')) break;
    const tip = P.tip;
    // the insertion point is the deepest matched block; if it is a leaf,
    // new blocks are siblings of it (children of its parent)
    let parent = (container.t === 'para' || container.t === 'table' ||
      container.t === 'code' || container.t === 'html') ? container.parent : container;
    // ATX heading
    const atxLevel = matchAtx(P);
    if (atxLevel) {
      closeTo(P, parent);
      parent = closeListParent(P, parent);
      const h = newNode('heading', parent);
      h.level = atxLevel;
      // heading text: rest of the line after the #'s, with a closing
      // sequence of #'s (preceded by a space) stripped, then trimmed
      const ie2 = indentEnd(P);
      let raw = P.ltext.slice(ie2.off + atxLevel);
      raw = raw.replace(/[ \t]+#+[ \t]*$/, '');
      h.str = raw.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      h.open = false;
      P.tip = parent;
      return;
    }
    // Fenced code
    const fence = matchFence(P);
    if (fence) {
      closeTo(P, parent);
      parent = closeListParent(P, parent);
      const code = newNode('code', parent);
      code.fenced = true;
      code.fenceCh = fence.ch;
      code.fenceLen = fence.len;
      code.fenceIndent = fence.cols;
      code.info = fence.info;
      code.str = '';
      P.tip = code;
      return;
    }
    // HTML block (type 7 cannot interrupt a paragraph)
    const hinfo = matchHtml(P, tip.t === 'para');
    if (hinfo) {
      closeTo(P, parent);
      parent = closeListParent(P, parent);
      const hb = newNode('html', parent);
      hb.kind = hinfo;
      hb.str = '';
      addCodeLine(P, hb, rest(P));
      P.tip = hb;
      // end conditions for types 1-5 (a type-1 block ends at its closing tag)
      if (hinfo === 1) {
        // the opening tag may span lines: the name may end at EOL
        let j = P.loff + 1;
        let nm = '';
        while (j < P.llen && isAlpha(P.ltext.charCodeAt(j))) { nm += P.ltext[j].toLowerCase(); j++; }
        const d = P.ltext.charCodeAt(j);
        if (j >= P.llen || d === 32 || d === 9 || d === 62) hb.endTag = nm;
        if (hb.endTag && htmlHasEndTag(hb.str, hb.endTag)) hb.ended = true;
      } else if (hinfo === 2 && hb.str.indexOf('-->') >= 0) hb.ended = true;
      else if (hinfo === 3 && hb.str.indexOf('?>') >= 0) hb.ended = true;
      else if (hinfo === 4 && hb.str.indexOf('>') >= 0) hb.ended = true;
      else if (hinfo === 5 && hb.str.indexOf(']]>') >= 0) hb.ended = true;
      return;
    }
    // Thematic break (can interrupt a paragraph)
    if (matchHr(P)) {
      closeTo(P, parent);
      parent = closeListParent(P, parent);
      const hr = newNode('hr', parent);
      hr.open = false;
      P.tip = parent;
      return;
    }
    // List item
    const lm = matchList(P);
    if (lm) {
      // can it interrupt a paragraph? A marker that continues the
      // currently open list of the same kind may do so even when it does
      // not start with 1 (e.g. "1. a\n2. b").
      const sameList = parent.t === 'list' && parent.bullet === lm.bullet &&
        (lm.bullet ? parent.mch === lm.ch : parent.delim === lm.delim);
      // a marker of a different kind than the open list starts a new list
      // and may interrupt a paragraph when it has content after it
      const diffKind = parent.t === 'list' && !sameList;
      // Inside a list item, an ordered list may start a nested list
      // even when it does not start with 1 (marked allows 2./49. to
      // nest inside an item; at top level or in a blockquote it must
      // start with 1 to interrupt a paragraph).
      let inItem = false;
      for (let a = tip; a; a = a.parent) { if (a.t === 'item') { inItem = true; break; } }
      const canInterrupt = tip.t !== 'para' || sameList ||
        (diffKind && restAfterMarker(P, lm)) ||
        (lm.bullet ? restAfterMarker(P, lm) : ((lm.start === 1 || inItem) && restAfterMarker(P, lm)));
      if (canInterrupt) {
        closeTo(P, parent);
        addListItem(P, parent, lm);
        container = P.tip;
        // continue the loop: the item's content may start another block
        continue;
      }
      // otherwise it is paragraph text; fall through
    }
    // Blockquote
    if (matchQuote(P)) {
      closeTo(P, parent);
      parent = closeListParent(P, parent);
      const q = newNode('quote', parent);
      P.tip = q;
      advanceCols(P, peekIndent(P));
      P.loff++; P.lcol++; // consume '>'
      if (curChar(P) === 32 || curChar(P) === 9) advanceCols(P, 1);
      container = q;
      continue;
    }
    // Indented code (cannot interrupt a paragraph; a tab-only line
    // inside a table is a table row, not indented code)
    if (tip.t !== 'para' && tip.t !== 'table' && peekIndent(P) >= 4) {
      closeTo(P, parent);
      parent = closeListParent(P, parent);
      const code = newNode('code', parent);
      code.fenced = false;
      code.str = '';
      advanceCols(P, 4);
      addCodeLine(P, code, rest(P));
      P.tip = code;
      return;
    }
    // GFM table: the tip is a one-line paragraph and this is its delimiter row
    if (tip.t === 'para' && tip.lineCount === 1) {
      const align = matchTableDelim(P);
      if (align) {
        const head = splitTableRow(tip.str);
        // the delimiter row must have the same cell count as the header
        if (align.length !== head.length) {
          // not a table: fall through to the paragraph-continuation path
        } else {
          tip.t = 'table';
          tip.align = align;
          tip.head = head;
          tip.rows = [];
          tip.str = undefined;
          P.tip = tip;
          return;
        }
      }
    }
    break;
  }

  // No new block started: add the line to the tip, or start a paragraph.
  if (!allMatched) {
    // phase 1 failed: a paragraph may only continue lazily if no blank
    // line has intervened since its last line (a lazy line may omit '>'
    // markers or a list item's indent, but not after a blank line)
    const ok = P.tip.t === 'para' && !P.tip.lb;
    if (!ok) closeTo(P, container);
  }
  const tip = P.tip;
  if (tip.t === 'para') {
    // paragraph continuation (lazy or normal)
    let r = rest(P);
    if (!allMatched) {
      // a lazy continuation line inside a list item: strip leading
      // whitespace up to the item's content indent
      let a = tip.parent;
      let item = null;
      let inQuote = false;
      while (a) {
        if (a.t === 'item' && !item) item = a;
        if (a.t === 'quote') inQuote = true;
        a = a.parent;
      }
      if (item) {
        const relPad = item.pad - (item.baseCol || 0);
        const ind = peekIndent(P);
        if (ind > 0) {
          advanceCols(P, Math.min(ind, relPad));
          r = rest(P);
        }
      } else if (inQuote && peekIndent(P) >= 4) {
        // a lazy continuation line inside a blockquote: if it is indented
        // 4 or more columns, strip 4 columns (an indented-code indent)
        advanceCols(P, 4);
        r = rest(P);
      }
      // a setext-like lazy line in a blockquote, after the paragraph was
      // already lazily continued, is indented by 4 spaces
      if (tip.lazy && /^[ \t]{0,3}(=+|-+)[ \t]*$/.test(r)) {
        let a = tip.parent;
        let inQuote = false;
        while (a) { if (a.t === 'quote') { inQuote = true; break; } a = a.parent; }
        if (inQuote) r = '    ' + r;
      }
      tip.lazy = true;
    }
    tip.str += '\n' + r;
    tip.lineCount++;
    tip.lb = false;
  } else if (tip.t === 'code') {
    if (tip.fenced) {
      // closing fence?
      const ie = indentEnd(P);
      if (ie.cols <= 3) {
        const i = ie.off;
        let n = 0;
        while (i + n < P.llen && P.ltext.charCodeAt(i + n) === tip.fenceCh) n++;
        if (n >= tip.fenceLen) {
          let k = i + n;
          let ok = true;
          while (k < P.llen) {
            const c = P.ltext.charCodeAt(k);
            if (c !== 32 && c !== 9) { ok = false; break; }
            k++;
          }
          if (ok) { closeTo(P, tip.parent); return; }
        }
      }
      // content line: strip up to fenceIndent columns. A tab that
      // straddles the strip boundary is removed as a whole (marked leaves
      // no partial-tab remainder: fence indent 3 + "\tindented" gives
      // "indented"). A leading tab that survives the strip expands to
      // spaces to the next tab stop when it is not at column 0 (inside a
      // container: "- ```" + "  \tindented" gives "  indented"); a tab
      // at column 0 stays literal.
      {
        let n = Math.min(tip.fenceIndent, peekIndent(P));
        while (n > 0 && P.loff < P.llen) {
          const c = P.ltext.charCodeAt(P.loff);
          if (c === 32) { P.loff++; P.lcol++; n--; }
          else if (c === 9) { const w = 4 - (P.lcol % 4); P.loff++; P.lcol += w; n -= w; if (n < 0) n = 0; }
          else break;
        }
        let r = rest(P);
        // expand a surviving leading tab only when the fence itself
        // stripped nothing (fenceIndent 0) and we are inside a container:
        // "- ```" + "  \tindented" gives "  indented". When the fence
        // stripping consumed indent, a surviving tab stays literal
        // ("   ```" + "   \tindented" gives "\tindented").
        // When the fence sits inside a blockquote that itself sits in
        // a list item, the tab expands to the next tab stop measured
        // from the list item's content column (the blockquote marker
        // does not count toward the tab stop): a tab at absolute column
        // 4 inside a "* " item (pad 2) is at relative column 2, so it
        // expands to 2 spaces, not 4. A fence directly in a list item
        // (no blockquote) uses the absolute column instead.
        if (r.charCodeAt(0) === 9 && tip.fenceIndent === 0 && P.lcol > 0) {
          let baseCol = 0;
          let b = tip;
          let seenQuote = false;
          while (b) {
            if (b.t === 'quote') seenQuote = true;
            if (b.t === 'item') { if (seenQuote) baseCol = b.pad; break; }
            b = b.parent;
          }
          const w = 4 - ((P.lcol - baseCol) % 4);
          r = ' '.repeat(w) + r.slice(1);
        }
        addCodeLine(P, tip, r);
      }
    } else {
      addCodeLine(P, tip, rest(P));
    }
  } else if (tip.t === 'html') {
    addCodeLine(P, tip, rest(P));
    // end conditions for types 1-5: mark ended; the next line closes it
    if (tip.kind === 1) {
      if (tip.endTag && htmlHasEndTag(rest(P), tip.endTag)) tip.ended = true;
    } else if (tip.kind === 2 && tip.str.indexOf('-->') >= 0) tip.ended = true;
    else if (tip.kind === 3 && tip.str.indexOf('?>') >= 0) tip.ended = true;
    else if (tip.kind === 4 && tip.str.indexOf('>') >= 0) tip.ended = true;
    else if (tip.kind === 5 && tip.str.indexOf(']]>') >= 0) tip.ended = true;
  } else if (tip.t === 'table') {
    tip.rows.push(splitTableRow(rest(P)));
  } else {
    // start a new paragraph in the current container, unless the line has
    // no remaining content (e.g. a lone ">" line, or a list marker
    // followed by only spaces)
    const r = rest(P);
    if (r.length > 0 && !/^[ \t]*$/.test(r)) {
      const parent2 = (container.t === 'para' || container.t === 'table' ||
        container.t === 'code' || container.t === 'html') ? container.parent : container;
      const para = newNode('para', closeListParent(P, parent2));
      para.str = r;
      para.lineCount = 1;
      P.tip = para;
    }
  }
}

// Is there non-whitespace content after a list marker?
function restAfterMarker(P, lm) {
  const i = lm.off + lm.w;
  for (let k = i; k < P.llen; k++) {
    const c = P.ltext.charCodeAt(k);
    if (c !== 32 && c !== 9) return true;
  }
  return false;
}

// Add a line to a code or HTML block's accumulated string.
function addCodeLine(P, b, text) {
  const nl = (P.isLastLine && !P.srcEndsNl) ? '' : '\n';
  if (b.str.length === 0) b.str = text + nl;
  else b.str += text + nl;
}

// Create (or extend) a list and add an item for the marker at the current
// position. Leaves the line cursor after the marker + padding.
function addListItem(P, container, lm) {
  // find or create the list: if the container itself is a list of the same
  // kind, the item belongs to it; otherwise look for a sibling list
  let list = null;
  const sameKind = (l) => l.bullet === lm.bullet &&
    (lm.bullet ? l.mch === lm.ch : l.delim === lm.delim);
  if (container.t === 'list' && container.open && sameKind(container)) {
    list = container;
  } else {
    // when the container is a list of a different kind, the new list is a
    // sibling of it (a child of the list's parent), not a child of the list
    const host = container.t === 'list' ? container.parent : container;
    const last = host.ch.length ? host.ch[host.ch.length - 1] : null;
    if (last && last.t === 'list' && last.open && sameKind(last)) {
      list = last;
    } else {
      // a different kind of list is starting: the old open list that is
      // the host's last child is done (its descendants are already closed)
      if (last && last.t === 'list' && last.open) finalize(P, last);
      list = newNode('list', host);
      list.bullet = lm.bullet;
      list.start = lm.start;
      list.delim = lm.delim;
      list.mch = lm.ch;
    }
  }
  const item = newNode('item', list);
  // the column where this container's content starts (before the marker)
  item.baseCol = P.lcol;
  // consume the indent and the marker
  P.loff = lm.off;
  P.lcol += lm.cols;
  P.loff += lm.w;
  P.lcol += lm.w;
  // padding: spaces/tabs after the marker
  const contentCol = P.lcol;
  let w = 0;
  let j = P.loff;
  let col = P.lcol;
  while (j < P.llen) {
    const c = P.ltext.charCodeAt(j);
    if (c === 32) { w++; col++; j++; }
    else if (c === 9) { const nw = 4 - (col % 4); w += nw; col += nw; j++; }
    else break;
  }
  let pad;
  if (j >= P.llen) {
    // empty item: content indent is one column past the marker
    item.pad = contentCol + 1;
  } else if (w >= 1 && w <= 4) {
    item.pad = contentCol + w;
    advanceCols(P, w);
  } else {
    // 5+ spaces: content indent is one column past the marker
    item.pad = contentCol + 1;
    advanceCols(P, 1);
  }
  item.markerOff = contentCol;
  P.tip = item;
}

// ============================================================
// Inline parsing
// ============================================================

// Plain-text rendering of a node list (for image alt text).
function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 'text') out += nd.s;
    else if (nd.t === 'code') out += nd.s;
    else if (nd.t === 'delim') out += String.fromCharCode(nd.ch).repeat(nd.n);
    else if (nd.t === 'link') out += plainText(nd.ch);
    else if (nd.t === 'bracket') out += '[';
    else if (nd.t === 'img') out += nd.alt;
    else if (nd.t === 'html') out += nd.s;
    else if (nd.t === 'softbr') out += '\n';
    else if (nd.t === 'br') out += '\n';
  }
  return out;
}

// GFM autolink backpedal: trim a URL's end the way marked's _backpedal
// regex does. Returns the trimmed end index within [start, end).
const URL_PUNCT = new Set([63, 33, 46, 44, 58, 59, 42, 95, 39, 34, 126, 41]); // ?!.,:;*_'\"~)
function backpedalEnd(src, start, end) {
  let i = start;
  while (i < end) {
    const c = src.charCodeAt(i);
    if (c === 40) { // (
      const j = src.indexOf(')', i + 1);
      if (j === -1 || j >= end) break;
      i = j + 1;
      continue;
    }
    if (c === 38) { // &
      let k = i + 1;
      while (k < end && isAlnum(src.charCodeAt(k))) k++;
      if (k < end && src.charCodeAt(k) === 59 && k === end - 1) break; // &word; at the end
      i++;
      continue;
    }
    if (URL_PUNCT.has(c)) {
      let j = i;
      while (j < end && URL_PUNCT.has(src.charCodeAt(j))) j++;
      if (j >= end) break; // the run reaches the end: stop before it
      i = j;
      continue;
    }
    i++;
  }
  return i;
}

// Match a GFM extended autolink (www. / scheme://) at src[i].
// Returns the end index (exclusive) or -1.
function matchExtUrl(src, i, n) {
  let j = i;
  const c0 = src.charCodeAt(i);
  if (c0 === 119) { // w: www. (lowercase only; Www. is not an autolink)
    if (src.slice(i, i + 4) !== 'www.') return -1;
    j = i + 4;
  } else if (c0 === 104 || c0 === 72 || c0 === 102 || c0 === 70) { // h/H/f/F
    const m = /^(?:https?|ftp):\/\//i.exec(src.slice(i, i + 8));
    if (!m) return -1;
    j = i + m[0].length;
  } else {
    return -1;
  }
  // domain: (?:[a-zA-Z0-9-]+\.?)+
  let end = -1;
  while (j < n) {
    let l0 = j;
    while (j < n && (isAlnum(src.charCodeAt(j)) || src.charCodeAt(j) === 45)) j++;
    if (j === l0) break;
    end = j;
    if (j < n && src.charCodeAt(j) === 46) { j++; end = j; }
    else break;
  }
  if (end === -1) return -1;
  // [^\s<]*
  let m = end;
  while (m < n) {
    const c = src.charCodeAt(m);
    if (c === 32 || c === 9 || c === 10 || c === 60) break;
    m++;
  }
  const trimmed = backpedalEnd(src, i, m);
  return trimmed > i ? trimmed : -1;
}

// Validate an email domain after '@' (src[j] is just past '@').
// Returns the end index or -1. Domain: label(.label)+, each label ending in
// an alnum, and the match must not be followed by a word char or '-'.
function matchEmailDomain(src, j, n) {
  let k = matchDomainLabel(src, j, n);
  if (k === -1) return -1;
  let labels = 1;
  while (k < n && src.charCodeAt(k) === 46) {
    // only consume the dot when a valid label follows it (a trailing
    // dot is not part of the address: a.b-c_d@a.b. links a.b-c_d@a.b)
    const k2 = matchDomainLabel(src, k + 1, n);
    if (k2 === -1) break;
    k = k2;
    labels++;
  }
  if (labels < 2) return -1;
  if (k < n && (isAlnum(src.charCodeAt(k)) || src.charCodeAt(k) === 45 || src.charCodeAt(k) === 95)) return -1;
  return k;
}

// Match one domain label starting at src[k]; returns its end or -1.
function matchDomainLabel(src, k, n) {
  const l0 = k;
  while (k < n && (isAlnum(src.charCodeAt(k)) || src.charCodeAt(k) === 45 || src.charCodeAt(k) === 95)) k++;
  if (k === l0) return -1;
  if (!isAlnum(src.charCodeAt(k - 1))) return -1;
  return k;
}

// Match an email autolink at src[i] (i is the start of the local part).
// Returns {end, text} or null.
function matchEmail(src, i, n) {
  let j = i;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (isAlnum(c) || c === 46 || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  if (j === i || j >= n || src.charCodeAt(j) !== 64) return null; // @
  const dEnd = matchEmailDomain(src, j + 1, n);
  if (dEnd === -1) return null;
  return { end: dEnd, text: src.slice(i, dEnd) };
}

// Is src[i] the start of a local-part run (for email detection)?
function isLocalStart(src, i) {
  const c = src.charCodeAt(i);
  if (!(isAlnum(c) || c === 46 || c === 95 || c === 43 || c === 45)) return false;
  if (i === 0) return true;
  const p = src.charCodeAt(i - 1);
  return !(isAlnum(p) || p === 46 || p === 95 || p === 43 || p === 45);
}

// <...> autolink (scheme: or email) at src[i] === '<'. Returns {href, text, end} or null.
function matchAngleAutolink(src, i, n) {
  // scheme: <letter [alnum+.-]{1,31} : ...>
  if (i + 1 < n && isAlpha(src.charCodeAt(i + 1))) {
    let j = i + 1;
    let sc = 0;
    while (j < n && sc < 32) {
      const c = src.charCodeAt(j);
      if (isAlnum(c) || c === 43 || c === 46 || c === 45) { sc++; j++; }
      else break;
    }
    if (sc >= 2 && sc <= 32 && j < n && src.charCodeAt(j) === 58) {
      let k = j + 1;
      while (k < n) {
        const c = src.charCodeAt(k);
        if (c === 32 || c === 10 || c === 60 || c === 62 || c < 32) break;
        k++;
      }
      if (k < n && src.charCodeAt(k) === 62) {
        return { href: src.slice(i + 1, k), text: src.slice(i + 1, k), end: k + 1 };
      }
    }
  }
  // email: <local@domain>
  const em = matchEmail(src, i + 1, n);
  if (em && em.end < n && src.charCodeAt(em.end) === 62) {
    return { href: 'mailto:' + em.text, text: em.text, end: em.end + 1 };
  }
  return null;
}


// Parse a complete open or closing tag at s[i] === '<' with proper attribute
// validation. Returns the index just past the closing '>' or -1.
function scanTag(s, i, n) {
  let j = i + 1;
  let closing = false;
  if (s.charCodeAt(j) === 47) { closing = true; j++; }
  if (j >= n || !isAlpha(s.charCodeAt(j))) return -1;
  while (j < n && (isAlnum(s.charCodeAt(j)) || s.charCodeAt(j) === 45)) j++;
  if (closing) {
    while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) j++;
    if (j < n && s.charCodeAt(j) === 62) return j + 1;
    return -1;
  }
  for (;;) {
    let w = j;
    // newlines are legal whitespace inside a tag (cm-615: <b2\ndata="foo" >)
    while (w < n && (s.charCodeAt(w) === 32 || s.charCodeAt(w) === 9 || s.charCodeAt(w) === 10)) w++;
    if (w >= n) return -1;
    const d = s.charCodeAt(w);
    if (d === 62) return w + 1;
    if (d === 47 && s.charCodeAt(w + 1) === 62) return w + 2;
    if (w === j) return -1; // no whitespace before an attribute
    j = w;
    const a0 = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (isAlnum(c) || c === 45 || c === 95 || c === 58 || c === 46) j++;
      else break;
    }
    if (j === a0) return -1;
    const aEnd = j; // end of the attribute name
    while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) j++;
    if (j >= n || s.charCodeAt(j) !== 61) {
      // boolean attribute (no '='): rewind to the end of the name so the
      // loop-top whitespace check sees the space before the next attribute
      // (cm-616: <a _boolean zoop /> has two boolean attributes)
      j = aEnd;
      continue;
    }
    if (j < n && s.charCodeAt(j) === 61) { // =
      j++;
      while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) j++;
      if (j >= n) return -1;
      const q = s.charCodeAt(j);
      if (q === 34 || q === 39) {
        j++;
        // newlines are allowed inside a quoted attribute value
        // (cm-642: <a href="foo\nbar"> is a tag)
        while (j < n && s.charCodeAt(j) !== q) j++;
        if (j >= n) return -1;
        j++;
      } else {
        const v0 = j;
        while (j < n) {
          const c = s.charCodeAt(j);
          if (c === 32 || c === 9 || c === 10 || c === 34 || c === 39 || c === 61 || c === 60 || c === 62 || c === 96) break;
          j++;
        }
        if (j === v0) return -1;
      }
    }
  }
}

// Raw HTML tag at src[i] === '<'. Returns the tag string or null.
function matchHtmlTag(src, i, n) {
  const s = src;
  if (i + 1 >= n) return null;
  const c1 = s.charCodeAt(i + 1);
  // comment
  if (c1 === 33 && s.charCodeAt(i + 2) === 45 && s.charCodeAt(i + 3) === 45) {
    if (s.slice(i + 4, i + 6) === '--') return null; // <!-- -- is not a comment start? (handled below)
    // <!--> and <!---> are complete empty comments on their own
    // (cm-626: the trailing " -->" is then plain text, escaped)
    if (s.charCodeAt(i + 4) === 62) return s.slice(i, i + 5);
    if (s.charCodeAt(i + 4) === 45 && s.charCodeAt(i + 5) === 62) return s.slice(i, i + 6);
    let j = s.indexOf('-->', i + 4);
    if (j === -1) return null;
    return s.slice(i, j + 3);
  }
  // processing instruction
  if (c1 === 63) {
    let j = s.indexOf('?>', i + 2);
    if (j === -1) return null;
    return s.slice(i, j + 2);
  }
  // declaration / CDATA
  if (c1 === 33) {
    const c2 = s.charCodeAt(i + 2);
    if (s.slice(i + 2, i + 9) === '[CDATA[') {
      let j = s.indexOf(']]>', i + 9);
      if (j === -1) return null;
      return s.slice(i, j + 3);
    }
    if (isAlpha(c2)) {
      let j = i + 2;
      while (j < n && s.charCodeAt(j) !== 62) j++;
      if (j >= n) return null;
      return s.slice(i, j + 1);
    }
    return null;
  }
  // open / closing tag
  const end = scanTag(s, i, n);
  return end === -1 ? null : s.slice(i, end);
}

// Parse an angle-bracket destination at text[i] === '<'. Returns {dest, end} or null.
function parseAngleDest(text, i) {
  const n = text.length;
  let j = i + 1;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === 10) return null;
    if (c === 60) return null;
    if (c === 62) return { dest: text.slice(i + 1, j), end: j + 1 };
    if (c === 92 && j + 1 < n && isPunct(text.charCodeAt(j + 1))) { j += 2; continue; }
    j++;
  }
  return null;
}

// Try to parse an inline link "(dest title)" starting at text[i] === '('.
// Returns {dest, title, end} or null.
function tryInlineLink(text, i, P) {
  const n = text.length;
  let j = i + 1;
  j = skipWsNl(text, j);
  if (j >= n) return null;
  let dest;
  if (text.charCodeAt(j) === 60) {
    const d = parseAngleDest(text, j);
    if (!d) return null;
    dest = d.dest;
    j = d.end;
  } else if (text.charCodeAt(j) === 41) {
    // empty destination: [link]() is a link with href=""
    dest = '';
  } else {
    const d = parseBareDest(text, j);
    if (!d) return null;
    dest = d.dest;
    j = d.end;
  }
  const afterDest = skipWsNl(text, j);
  let title = null;
  let end = afterDest;
  if (afterDest < n && text.charCodeAt(afterDest) !== 41) {
    const t = parseTitle(text, afterDest);
    if (!t) return null;
    title = t.title;
    end = skipWsNl(text, t.end);
  }
  if (end >= n || text.charCodeAt(end) !== 41) return null;
  return { dest, title, end: end + 1 };
}

// Punctuation for emphasis flanking: ASCII punctuation plus any non-ASCII
// character that is not a letter/digit/space (Unicode punctuation and
// symbols such as \u00a3, \u20ac, \u00ab, \u2014, \u2022, \u00a9 all count:
// marked treats them as punctuation here, so a '*' next to one cannot
// open intraword or close after it). Kept separate from isPunct, which
// stays ASCII-only for backslash escapes.
const FLANK_PUNCT_RE = /[\p{P}\p{S}]/u;
function isFlankPunct(ch) {
  if (ch === 0) return false;
  if (ch < 128) return isPunct(ch);
  if (isSpace(ch)) return false;
  return FLANK_PUNCT_RE.test(String.fromCharCode(ch));
}

// Compute canOpen/canClose for a delimiter run of `ch` at [i, i+len).
// before/after are the neighbouring characters (0 = start/end of input).
function delimFlags(ch, before, after) {
  const beforeSpace = before === 0 ? true : isSpace(before);
  const afterSpace = after === 0 ? true : isSpace(after);
  const beforePunct = before === 0 ? false : isFlankPunct(before);
  const afterPunct = after === 0 ? false : isFlankPunct(after);
  const leftFlanking = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
  const rightFlanking = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
  if (ch === 95) { // _
    return {
      canOpen: leftFlanking && (!rightFlanking || beforePunct),
      canClose: rightFlanking && (!leftFlanking || afterPunct),
    };
  }
  return { canOpen: leftFlanking, canClose: rightFlanking };
}

// Process emphasis / strikethrough delimiters in a node list (in place).
// Delimiter nodes accumulate open/close tags; unused ones render as text.
// True when the nodes strictly between d1 and d2 contain no whitespace
// (used to decide whether a closer run's leftover asterisks render
// inside the emphasis, before its close tag).
function attachedSpan(nodes, d1, d2) {
  const i1 = nodes.indexOf(d1);
  const i2 = nodes.indexOf(d2);
  if (i1 < 0 || i2 < 0 || i2 <= i1) return false;
  for (let i = i1 + 1; i < i2; i++) {
    const nd = nodes[i];
    if (nd.t === 'softbr' || nd.t === 'br') return false;
    if (nd.t === 'text' && /[ \t\n\r]/.test(nd.s)) return false;
    if (nd.t !== 'text' && nd.t !== 'delim') return false;
  }
  return true;
}

function processEmphasis(nodes, delims) {
  // No openers_bottom optimisation: a closer that finds no opener (e.g.
  // blocked by the rule of 3 against one opener) must not hide earlier
  // openers from later closers (cm-411: *foo**bar**baz* needs the outer
  // '*' to stay visible after the inner '**' pair is resolved).
  // Formed pairs are recorded as spans [openerIdx, closerIdx, tag]; a new
  // pair may not cross a span boundary (an opener inside a span cannot
  // pair with a closer outside it: cm-469 *foo _bar* baz_ keeps the '_'
  // literal because the '_' opener sits inside the '*' span but its
  // closer is outside it). A single-asterisk <em> pair is also blocked
  // when a **strong** span sits strictly inside it whose opener is NOT
  // preceded by a word character AND whose closer IS immediately followed
  // by a word character (marked's regex behaviour: *a **b**c* leaves the
  // outer '*' literal, but *foo**bar**baz* (inner attached to a word),
  // *a **b** c*, *a *b*c*, *a __b__c*, **a **b**c** and _a **b**c_ all
  // form the outer pair).
  const spans = [];
  for (let di = 0; di < delims.length; di++) {
    const closer = delims[di];
    if (!closer.canClose || closer.n === 0) continue;
    let oi = -1;
    for (let k = di - 1; k >= 0; k--) {
      const opener = delims[k];
      if (opener.ch !== closer.ch) continue;
      if (!opener.canOpen || opener.n === 0) continue;
      if (closer.ch === 126 && opener.n !== closer.n) continue; // ~ needs equal lengths
      if ((opener.canClose || closer.canOpen) &&
          (opener.n + closer.n) % 3 === 0 &&
          (opener.n % 3 !== 0 || closer.n % 3 !== 0)) continue;
      // no crossing: opener inside a formed span, closer outside it
      let crosses = false;
      for (let s = 0; s < spans.length; s++) {
        const a = spans[s][0], b = spans[s][1];
        if (k > a && k < b && di > b) { crosses = true; break; }
      }
      if (crosses) continue;
      // blocked em: a strong span strictly inside this candidate pair,
      // whose opener is not preceded by a word char and whose closer is
      // immediately followed by a word char. Only when the outer closer
      // run has at most 2 asterisks: with a *** closer the outer em
      // forms and the leftover renders inside it.
      const use0 = (opener.n >= 2 && closer.n >= 2) ? 2 : 1;
      if (use0 === 1 && closer.ch === 42 && closer.n <= 2) {
        let blocked = false;
        for (let s = 0; s < spans.length; s++) {
          const sp = spans[s];
          if (sp[2] === 'strong' && sp[0] > k && sp[1] < di && !delims[sp[0]].bw && delims[sp[1]].aw) { blocked = true; break; }
        }
        if (blocked) continue;
      }
      oi = k;
      break;
    }
    if (oi === -1) continue;
    const opener = delims[oi];
    const use = (opener.n >= 2 && closer.n >= 2) ? 2 : 1;
    const tag = closer.ch === 126 ? 'del' : use === 2 ? 'strong' : 'em';
    opener.n -= use;
    opener.open.push(tag);
    closer.n -= use;
    closer.close.push(tag);
    // leftover placement: when this closer run has leftover asterisks and
    // an inner span is attached to it (no whitespace between the inner
    // span's closer and this closer), the leftover renders BEFORE the
    // close tag (inside the emphasis); otherwise after it. Only when the
    // closer run originally had at least 3 asterisks (a ** closer's
    // leftover renders outside).
    if (closer.n > 0 && closer.n + use >= 3) {
      let bestB = -1;
      for (let s = 0; s < spans.length; s++) {
        const sp = spans[s];
        if (sp[0] > oi && sp[1] < di && sp[1] > bestB) bestB = sp[1];
      }
      if (bestB >= 0 && attachedSpan(nodes, delims[bestB], closer)) {
        closer.litFirst = true;
      }
    }
    spans.push([oi, di, tag]);
    if (closer.n > 0) di--; // reprocess this closer
  }
}

// Render a node list to HTML.
function renderInline(nodes, inLink) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 'text': out += escapeText(nd.s); break;
      case 'code': out += '<code>' + escapeCode(nd.s) + '</code>'; break;
      case 'html': out += nd.s; break;
      case 'br': out += '<br>'; break;
      case 'softbr': out += '\n'; break;
      case 'delim': {
        // litFirst: a closer run's leftover asterisks render BEFORE its
        // close tag (inside the emphasis) when an inner span is attached
        // to it; otherwise after the close tag.
        const lit = nd.n > 0 ? (nd.ch === 42 ? '*'.repeat(nd.n) : nd.ch === 95 ? '_'.repeat(nd.n) : '~'.repeat(nd.n)) : '';
        if (nd.litFirst && lit) out += lit;
        for (const tag of nd.close) out += '</' + tag + '>';
        if (!nd.litFirst && lit) out += lit;
        for (let k = nd.open.length - 1; k >= 0; k--) out += '<' + nd.open[k] + '>';
        break;
      }
      case 'link': {
        // An autolink inside a link is flattened to plain text (links
        // cannot nest) — EXCEPT an angle-bracket autolink <...>, which
        // marked keeps as a nested <a>. Bare GFM autolinks (scheme/www/
        // email) flatten; explicit links never occur here (blocked at
        // parse time) but flatten defensively all the same.
        if (inLink && !(nd.auto && nd.angle)) { out += escapeText(plainText(nd.ch)); break; }
        out += '<a href="' + escapeText(encodeHref(nd.href)) + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + escapeText(nd.title) + '"';
        out += '>' + renderInline(nd.ch, true) + '</a>';
        break;
      }
      case 'img': {
        out += '<img src="' + escapeText(encodeHref(nd.src)) + '" alt="' + escapeText(nd.alt) + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + escapeText(nd.title) + '"';
        out += '>';
        break;
      }
      case 'bracket': out += '['; break;
    }
  }
  return out;
}

// The inline scanner. Returns the HTML for `src`.
function parseInline(P, src) {
  const n = src.length;
  const nodes = [];
  const brackets = [];
  const delims = [];
  let i = 0;
  let textStart = 0;
  const flushText = (end) => {
    if (end > textStart) nodes.push({ t: 'text', s: src.slice(textStart, end) });
  };

  while (i < n) {
    const c = src.charCodeAt(i);
    // backslash escape / hard break
    if (c === 92) {
      if (i + 1 < n) {
        const d = src.charCodeAt(i + 1);
        if (isPunct(d)) { flushText(i); nodes.push({ t: 'text', s: src[i + 1] }); i += 2; textStart = i; continue; }
        if (d === 10) {
          flushText(i); nodes.push({ t: 'br' }); i += 2;
          // a hard break strips the next line's leading whitespace
          while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
          textStart = i; continue;
        }
      }
      i++;
      continue;
    }
    // code span
    if (c === 96) {
      let run = 0;
      while (i + run < n && src.charCodeAt(i + run) === 96) run++;
      // find a matching run of the same length
      let j = i + run;
      let found = -1;
      while (j < n) {
        if (src.charCodeAt(j) === 96) {
          let r2 = 0;
          while (j + r2 < n && src.charCodeAt(j + r2) === 96) r2++;
          if (r2 === run) { found = j; break; }
          j += r2;
        } else j++;
      }
      if (found === -1) { i += run; continue; } // literal backticks
      let content = src.slice(i + run, found).replace(/\n/g, ' ');
      if (content.length > 0 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      flushText(i);
      nodes.push({ t: 'code', s: content });
      i = found + run;
      textStart = i;
      continue;
    }
    // numeric character reference
    if (c === 38) {
      const dec = decodeNumericRef(src, i);
      if (dec) { flushText(i); nodes.push({ t: 'text', s: dec[0] }); i = dec[1]; textStart = i; continue; }
      i++;
      continue;
    }
    // < autolink / raw HTML
    if (c === 60) {
      const al = matchAngleAutolink(src, i, n);
      if (al) {
        flushText(i);
        nodes.push({ t: 'link', href: al.href, title: null, auto: true, angle: true, ch: [{ t: 'text', s: al.text }] });
        i = al.end;
        textStart = i;
        continue;
      }
      const tag = matchHtmlTag(src, i, n);
      if (tag) {
        flushText(i);
        nodes.push({ t: 'html', s: tag });
        i += tag.length;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    // [ or ![
    if (c === 91 || (c === 33 && i + 1 < n && src.charCodeAt(i + 1) === 91)) {
      const image = c === 33;
      flushText(i);
      let bang = -1;
      if (image) { nodes.push({ t: 'text', s: '!' }); bang = nodes.length - 1; }
      nodes.push({ t: 'bracket', image, textPos: i });
      brackets.push({ idx: nodes.length - 1, image, active: true, bang });
      i += image ? 2 : 1;
      textStart = i;
      continue;
    }
    // ] : try to form a link
    if (c === 93) {
      let bi = brackets.length - 1;
      while (bi >= 0 && !brackets[bi].active) bi--;
      if (bi < 0) { i++; continue; }
      const br = brackets[bi];
      let link = null;
      let linkEnd = -1;
      if (i + 1 < n && src.charCodeAt(i + 1) === 40) {
        const il = tryInlineLink(src, i + 1, P);
        if (il) { link = il; linkEnd = il.end; }
      }
      if (!link && i + 1 < n && src.charCodeAt(i + 1) === 91) {
        const lab = parseLinkLabel(src, i + 1);
        if (lab) {
          const key = normalizeLabel(lab.label);
          const ref = P.refmap.get(key);
          if (ref) { link = { dest: ref.dest, title: ref.title }; linkEnd = lab.end; }
        }
      }
      if (!link) {
        // collapsed reference [text][]
        if (i + 2 < n && src.charCodeAt(i + 1) === 91 && src.charCodeAt(i + 2) === 93) {
          // textPos points at '[' (link) or '!' (image); skip the bracket
          const label = src.slice(nodes[br.idx].textPos + (br.image ? 2 : 1), i);
          const ref = P.refmap.get(normalizeLabel(label));
          if (ref) { link = { dest: ref.dest, title: ref.title }; linkEnd = i + 3; }
        }
      }
      if (!link && !(i + 1 < n && src.charCodeAt(i + 1) === 91)) {
        // shortcut reference [text] — only when ']' is not followed by
        // '[': a bracket followed by '[label]' is a full-reference
        // attempt, and if that fails the bracket stays literal (cm-571:
        // [foo][bar][baz] links only [bar] to [baz]'s definition).
        // A failed inline link "(...)" DOES fall back to the shortcut
        // (cm-568: [foo](not a link) links [foo] to its definition)
        const label = src.slice(nodes[br.idx].textPos + (br.image ? 2 : 1), i);
        const ref = P.refmap.get(normalizeLabel(label));
        if (ref) { link = { dest: ref.dest, title: ref.title }; linkEnd = i + 1; }
      }
      if (link && !br.image) {
        // a link cannot contain another EXPLICIT link: if the bracket text
        // already holds a non-autolink link node, the outer '[' stays
        // literal text (images are exempt: their alt text is plain text,
        // so a link inside is fine). An autolink inside link text does
        // NOT block the outer link; it is flattened to its text.
        for (let k = br.idx + 1; k < nodes.length; k++) {
          if (nodes[k].t === 'link' && !nodes[k].auto) { link = null; break; }
        }
      }
      if (link) {
        flushText(i);
        const children = nodes.splice(br.idx + 1);
        // delimiters inside the link text belong to the link's own level:
        // take them out of the top-level list so they are not processed twice
        const childSet = new Set(children);
        const innerDelims = [];
        for (let k = delims.length - 1; k >= 0; k--) {
          if (childSet.has(delims[k])) { innerDelims.unshift(delims[k]); delims.splice(k, 1); }
        }
        // deactivate brackets inside the link
        for (let k = bi + 1; k < brackets.length; k++) brackets[k].active = false;
        brackets.length = bi;
        const dest = unescapeDest(link.dest);
        const title = link.title === null || link.title === undefined ? null : unescapeDest(link.title);
        // process emphasis inside the bracket text first, so the image
        // alt (plain text) does not keep emphasis markers literally
        // (cm-577: ![foo *bar*] has alt "foo bar", not "foo *bar*")
        processEmphasis(children, innerDelims);
        if (br.image) {
          const alt = plainText(children);
          const imgNode = { t: 'img', src: dest, alt, title };
          let bIdx = br.idx;
          if (br.bang >= 0) { nodes.splice(br.bang, 1); bIdx--; }
          nodes[bIdx] = imgNode;
        } else {
          nodes[br.idx] = { t: 'link', href: dest, title, ch: children };
        }
        i = linkEnd;
        textStart = i;
        continue;
      }
      // no link: the bracket can no longer link
      brackets.splice(bi, 1);
      i++;
      continue;
    }
    // emphasis / strikethrough delimiter runs
    if (c === 42 || c === 95 || c === 126) {
      let run = 0;
      while (i + run < n && src.charCodeAt(i + run) === c) run++;
      if (c === 126 && run > 2) { i += run; continue; } // 3+ tildes are literal
      const before = i > 0 ? src.charCodeAt(i - 1) : 0;
      const after = i + run < n ? src.charCodeAt(i + run) : 0;
      const flags = delimFlags(c, before, after);
      flushText(i);
      const d = { t: 'delim', ch: c, n: run, canOpen: flags.canOpen, canClose: flags.canClose, open: [], close: [], aw: isWordChar(after), bw: isWordChar(before) };
      nodes.push(d);
      delims.push(d);
      i += run;
      textStart = i;
      continue;
    }
    // newline: hard or soft break
    if (c === 10) {
      let sp = 0;
      let k = i - 1;
      while (k >= 0 && src.charCodeAt(k) === 32) { sp++; k--; }
      if (sp >= 2) {
        // hard break: drop the trailing spaces
        flushText(i - sp);
        if (textStart > i - sp) {
          const last = nodes[nodes.length - 1];
          if (last && last.t === 'text') {
            const excess = textStart - (i - sp);
            last.s = last.s.slice(0, last.s.length - excess);
            if (last.s === '') nodes.pop();
          }
        }
        nodes.push({ t: 'br' });
        i++;
        // a hard break strips the next line's leading whitespace
        while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
        textStart = i;
        continue;
      } else {
        flushText(i);
        nodes.push({ t: 'softbr' });
        i++;
        textStart = i;
        continue;
      }
    }
    // GFM extended autolinks
    if ((c === 119 || c === 87 || c === 104 || c === 72 || c === 102 || c === 70)) {
      const prev = i > 0 ? src.charCodeAt(i - 1) : 0;
      const isWww = c === 119 || c === 87;
      const okPrev = isWww
        ? (i === 0 || prev === 32 || prev === 9 || prev === 10 || prev === 42 || prev === 95 || prev === 126 || prev === 40)
        : true;
      if (okPrev) {
        let end = matchExtUrl(src, i, n);
        if (end > i) {
          // A bare URL inside link text stops at the bracket's closing
          // ']' when that ']' starts an inline destination: in
          // "[render simple https://example.org/x](https://www.example.com)"
          // the URL is "https://example.org/x", not the whole
          // "https://example.org/x](https://www.example.com)". Only the
          // FIRST ']' after the URL start counts (it closes the open
          // bracket); if it is not followed by '(' the bracket does not
          // form a link and the URL runs free (r4). And if the open
          // bracket's text already holds an explicit link, the bracket
          // cannot form a link at all (links cannot nest), so the URL
          // also runs free (doc-08: the outer bracket holds the inner
          // "[cache large server](#to ...)" link).
          let bi2 = brackets.length - 1;
          while (bi2 >= 0 && !brackets[bi2].active) bi2--;
          if (bi2 >= 0) {
            const brIdx = brackets[bi2].idx;
            let hasLink = false;
            for (let k = brIdx + 1; k < nodes.length; k++) {
              if (nodes[k].t === 'link' && !nodes[k].auto) { hasLink = true; break; }
            }
            if (!hasLink) {
              let j = src.indexOf(']', i);
              // ']' followed by '(' starts an inline destination, and
              // ']' followed by '[' starts a reference label: in both
              // cases the bracket closes here and the URL stops before
              // it ("[the public www.moss.com/callback][valid-30]" links
              // the URL only up to "callback").
              if (j !== -1 && j < end && j + 1 < n && (src.charCodeAt(j + 1) === 40 || src.charCodeAt(j + 1) === 91)) {
                end = backpedalEnd(src, i, j);
              }
            }
          }
          const text = src.slice(i, end);
          flushText(i);
          nodes.push({ t: 'link', href: isWww ? 'http://' + text : text, title: null, auto: true, ch: [{ t: 'text', s: text }] });
          i = end;
          textStart = i;
          continue;
        }
      }
    }
    if ((c === 109 || c === 120) && i + 1 < n) { // m / x: mailto: / xmpp:
      const prev = i > 0 ? src.charCodeAt(i - 1) : 0;
      const okPrev = i === 0 || !isAlnum(prev);
      if (okPrev) {
        const word = c === 109 ? 'mailto:' : 'xmpp:';
        if (src.slice(i, i + word.length) === word) {
          const em = matchEmail(src, i + word.length, n);
          if (em) {
            let end = em.end;
            // xmpp: URLs take a single path segment after the address
            // (xmpp:foo@bar.baz/txt links the whole thing, but in
            // xmpp:foo@bar.baz/txt/bin only /txt is part of the link)
            if (c === 120 && end < n && src.charCodeAt(end) === 47) {
              let k = end + 1;
              while (k < n) {
                const cc = src.charCodeAt(k);
                if (cc === 47 || cc === 32 || cc === 9 || cc === 10 || cc === 60) break;
                k++;
              }
              if (k > end + 1) end = backpedalEnd(src, end, k);
            }
            const text = src.slice(i, end);
            flushText(i);
            nodes.push({ t: 'link', href: text, title: null, auto: true, ch: [{ t: 'text', s: text }] });
            i = end;
            textStart = i;
            continue;
          }
        }
      }
    }
    if (isLocalStart(src, i)) {
      const em = matchEmail(src, i, n);
      if (em) {
        flushText(i);
        nodes.push({ t: 'link', href: 'mailto:' + em.text, title: null, auto: true, ch: [{ t: 'text', s: em.text }] });
        i = em.end;
        textStart = i;
        continue;
      }
    }
    i++;
  }
  flushText(n);
  processEmphasis(nodes, delims);
  return renderInline(nodes);
}

// ============================================================
// Rendering
// ============================================================

// Strip trailing blank lines from a code block's content, leaving exactly
// one trailing newline when there is any content.
function codeContent(s, fenced) {
  if (s.length === 0) return '';
  if (fenced) {
    // a fenced block keeps its blank lines except for one trailing
    // newline when the last line is blank: "\n\n" -> "\n", "\n" -> "",
    // "" -> "" (an all-newline body drops exactly one trailing "\n")
    let allNl = true;
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) !== 10) { allNl = false; break; }
    }
    if (allNl) return s.length >= 2 ? s.slice(0, -1) : '';
    if (s.length >= 2 && s.charCodeAt(s.length - 1) === 10 &&
        s.charCodeAt(s.length - 2) === 10) {
      return s.slice(0, -1);
    }
    return s;
  }
  // an indented block drops all trailing blank lines, keeping one newline
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 10) end--;
  if (end === 0) return '';
  return s.slice(0, end) + '\n';
}

function renderBlock(P, b, out) {
  switch (b.t) {
    case 'doc':
      for (const c of b.ch) renderBlock(P, c, out);
      break;
    case 'para':
      out.push('<p>' + parseInline(P, b.str) + '</p>\n');
      break;
    case 'heading':
      out.push('<h' + b.level + '>' + parseInline(P, b.str) + '</h' + b.level + '>\n');
      break;
    case 'hr':
      out.push('<hr>\n');
      break;
    case 'code': {
      const content = codeContent(b.str, b.fenced);
      if (b.fenced) {
        out.push('<pre><code');
        if (b.info) out.push(' class="language-' + escapeText(b.info.split(/\s+/)[0]) + '"');
        out.push('>' + escapeCode(content) + '</code></pre>\n');
      } else {
        out.push('<pre><code>' + escapeCode(content) + '</code></pre>\n');
      }
      break;
    }
    case 'html':
      out.push(b.str);
      break;
    case 'quote':
      out.push('<blockquote>\n');
      for (const c of b.ch) renderBlock(P, c, out);
      out.push('</blockquote>\n');
      break;
    case 'list': {
      const tag = b.bullet ? 'ul' : 'ol';
      out.push('<' + tag);
      if (!b.bullet && b.start !== 1) out.push(' start="' + b.start + '"');
      out.push('>\n');
      for (const c of b.ch) renderBlock(P, c, out);
      out.push('</' + tag + '>\n');
      break;
    }
    case 'item': {
      out.push('<li>');
      const tight = b.parent.tight;
      for (let k = 0; k < b.ch.length; k++) {
        const c = b.ch[k];
        if (c.t === 'para' && !tight) {
          // loose list: paragraphs render as blocks; task-list checkbox
          // goes inside the first paragraph
          if (k === 0 && c.task !== undefined) {
            out.push('<p>' + taskCheckbox(c.task) + parseInline(P, c.str) + '</p>\n');
          } else {
            out.push('<p>' + parseInline(P, c.str) + '</p>\n');
          }
        } else if (c.t === 'para' && tight) {
          if (k === 0 && c.task !== undefined) out.push(taskCheckbox(c.task));
          out.push(parseInline(P, c.str));
        } else {
          renderBlock(P, c, out);
        }
      }
      out.push('</li>\n');
      break;
    }
    case 'table': {
      out.push('<table>\n<thead>\n<tr>\n');
      const cols = b.align.length;
      for (let k = 0; k < cols; k++) {
        const cell = k < b.head.length ? b.head[k] : '';
        const a = b.align[k];
        out.push('<th' + (a ? ' align="' + a + '"' : '') + '>' + parseInline(P, cell.trim()) + '</th>\n');
      }
      if (b.rows.length === 0) {
        out.push('</tr>\n</thead>\n</table>\n');
        break;
      }
      out.push('</tr>\n</thead>\n<tbody>');
      for (const row of b.rows) {
        out.push('<tr>\n');
        for (let k = 0; k < cols; k++) {
          const cell = k < row.length ? row[k] : '';
          const a = b.align[k];
          out.push('<td' + (a ? ' align="' + a + '"' : '') + '>' + parseInline(P, cell.trim()) + '</td>\n');
        }
        out.push('</tr>\n');
      }
      out.push('</tbody></table>\n');
      break;
    }
  }
}

function taskCheckbox(checked) {
  return checked
    ? '<input checked="" disabled="" type="checkbox">'
    : '<input disabled="" type="checkbox">';
}

// ============================================================
// Driver
// ============================================================

function blockParse(src) {
  src = src.replace(/\r\n?/g, '\n');
  const srcEndsNl = src.length > 0 && src.charCodeAt(src.length - 1) === 10;
  const lines = src.split('\n');
  if (srcEndsNl) lines.pop();
  const doc = newNode('doc', null);
  const P = {
    doc, tip: doc, refmap: new Map(),
    ltext: '', loff: 0, lcol: 0, llen: 0, lblank: true,
    srcEndsNl, isLastLine: false, atEof: false,
  };
  for (let li = 0; li < lines.length; li++) {
    P.isLastLine = li === lines.length - 1;
    incorporateLine(P, lines[li]);
  }
  P.atEof = true;
  closeTo(P, doc);
  return P;
}

/** Render `markdown` to HTML exactly as marked 18.1.3 does with defaults. */
export function parse(markdown) {
  if (markdown === '') return '';
  const P = blockParse(markdown);
  // task-list items: a list item whose first paragraph starts with [ ] / [x]
  markTasks(P.doc);
  const out = [];
  renderBlock(P, P.doc, out);
  return out.join('');
}

// Walk the tree; a list item whose first block is a paragraph starting with
// a task marker becomes a task item (the marker is stripped from the text).
function markTasks(node) {
  for (const c of node.ch) {
    if (c.t === 'item') {
      const first = c.ch[0];
      if (first && first.t === 'para') {
        const m = /^\[([ xX])\][ \t]+/.exec(first.str);
        if (m) {
          first.task = m[1] === 'x' || m[1] === 'X';
          // strip only the "[x]" itself; the following whitespace stays
          // as the space after the checkbox
          first.str = first.str.slice(3);
        }
      }
    }
    markTasks(c);
  }
}
