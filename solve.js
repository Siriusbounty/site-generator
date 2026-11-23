// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01).
// Same answers, byte for byte; single-pass scanners, flat template ops,
// per-case memoisation, no dependencies. ES module, Node 22+.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ---------------------------------------------------------------- text

const ESCMAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  ESC_RE.lastIndex = 0;
  let m;
  let out = '';
  let last = 0;
  while ((m = ESC_RE.exec(text)) !== null) {
    out += text.slice(last, m.index) + ESCMAP[m[0]];
    last = m.index + 1;
  }
  if (last === 0) return text;
  return out + text.slice(last);
}

/** Reference slugify, used verbatim for non-ASCII input. */
function slugifySlow(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/**
 * The slug of `text`. ASCII input (the overwhelming majority) is handled by a
 * char-code scan: NFKD is the identity on ASCII and ASCII holds no combining
 * marks, so the result is identical to the reference. Anything else falls back
 * to the reference implementation.
 */
function slugifyRaw(text) {
  const buf = [];
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 128) return slugifySlow(text);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      if (buf.length > 0) gap = true;
      continue;
    }
    if (gap) {
      buf.push(45); // '-'
      gap = false;
    }
    buf.push(keep);
  }
  let out = String.fromCharCode.apply(null, buf);
  if (out.length > 64) out = out.slice(0, 64);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  if (end !== out.length) out = out.slice(0, end);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  // date is validated YYYY-MM-DD, so fixed positions are safe.
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Whether char code `c` is whitespace in the /\s/ sense. */
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS_TABLE[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS_TABLE[c] = 1;

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)]) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isKeyChar(c) {
  return (c >= 97 && c <= 122) || c === 95; // a-z or _
}

function isNameChar(c) {
  return (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45; // a-z 0-9 -
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1)
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0;
      let mo = 0;
      let d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) {
            ok = false;
            break;
          }
        }
        if (ok) {
          y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
          mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
          d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
        }
      }
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo))
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93)
        return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = new Array(parts.length);
      for (let i = 0; i < parts.length; i++) {
        const t = parts[i].trim();
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let j = 0; j < t.length; j++) {
          const c = t.charCodeAt(j);
          if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
        tags[i] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) if (!isNameChar(raw.charCodeAt(i))) return { error: 'key "layout": not a template name' };
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true; // a slug may not start with '-'
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error }.
 * `text` has "\n" line ends. Lines are scanned by index, never split.
 */
function parseFrontMatter(text) {
  const n = text.length;
  const nl0 = text.indexOf('\n');
  const firstEnd = nl0 === -1 ? n : nl0;
  if (firstEnd !== 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45)
    return { error: 'no front matter' };
  // Find the closing '---' line.
  let closeStart = -1;
  let closeEnd = -1; // position just past the closing line's '\n' (or n)
  let scan = nl0 === -1 ? n : nl0 + 1;
  while (scan < n) {
    const e = text.indexOf('\n', scan);
    const le = e === -1 ? n : e;
    if (le - scan === 3 && text.charCodeAt(scan) === 45 && text.charCodeAt(scan + 1) === 45 && text.charCodeAt(scan + 2) === 45) {
      closeStart = scan;
      closeEnd = e === -1 ? n : e + 1;
      break;
    }
    if (e === -1) break;
    scan = e + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineNo = 2;
  let pos = nl0 + 1;
  while (pos < closeStart) {
    const e = text.indexOf('\n', pos);
    const le = e === -1 ? closeStart : Math.min(e, closeStart);
    // line is text[pos..le)
    if (le > pos) {
      const c0 = text.charCodeAt(pos);
      let skip = false;
      if (c0 === 35) skip = true; // comment
      else if (c0 === 32 || c0 === 9) {
        // blank only if the whole line is spaces/tabs
        let allWS = true;
        for (let i = pos; i < le; i++) {
          const c = text.charCodeAt(i);
          if (c !== 32 && c !== 9) {
            allWS = false;
            break;
          }
        }
        if (allWS) skip = true;
      }
      if (!skip) {
        // Parse "key: value": key of [a-z_]+, ':', then ' ' + rest or end.
        let i = pos;
        while (i < le && isKeyChar(text.charCodeAt(i))) i++;
        let raw = null;
        let key = null;
        if (i > pos && i < le && text.charCodeAt(i) === 58) {
          // ':'
          key = text.slice(pos, i);
          if (i + 1 === le) raw = '';
          else if (text.charCodeAt(i + 1) === 32) raw = text.slice(i + 2, le);
        }
        if (raw === null) return { error: `line ${lineNo} is not "key: value"` };
        // strip trailing spaces/tabs from raw
        let rEnd = raw.length;
        while (rEnd > 0) {
          const c = raw.charCodeAt(rEnd - 1);
          if (c === 32 || c === 9) rEnd--;
          else break;
        }
        if (rEnd !== raw.length) raw = raw.slice(0, rEnd);
        if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
        if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
        if (raw === '') return { error: `key "${key}" has no value` };
        const v = valueOf(key, raw);
        if ('error' in v) return v;
        data[key] = v.value;
      }
    }
    // empty line: blank, skip
    lineNo++;
    pos = e === -1 ? closeStart : e + 1;
    if (e === -1) break;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** First index in [from, b) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, b) {
  const wlen = what.length;
  for (let j = from; j <= b - wlen; j++) {
    if (s[j] === '\\' && j + 1 < b && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** First single * in [from, b) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, b) {
  for (let j = from; j < b; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < b && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (j + 1 < b && s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const INLINE_SPECIAL = /[\\`*\x5b&<>"']/g;
const HTML_ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * `s[a..b)` rendered inline into `out` (an array of strings); `link(target)` is
 * a link's href. Recursion is on index ranges, never on sliced copies. One
 * regex scan finds the next character needing attention, Markdown construct or
 * HTML escape alike, so plain runs are pushed unescaped as-is; `lastIndex` is
 * set explicitly each step, so the recursion through the shared regex is safe.
 */
function inlineInto(s, a, b, link, out) {
  let i = a;
  let run = a;
  for (;;) {
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    if (m === null || m.index >= b) break;
    const j = m.index;
    const c = s[j];
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      if (j > run) out.push(s.slice(run, j));
      out.push(HTML_ENT[c]);
      i = j + 1;
      run = i;
      continue;
    }
    if (c === '\\') {
      if (j + 1 < b && ESCAPABLE.has(s[j + 1])) {
        if (j > run) out.push(s.slice(run, j));
        const e = s[j + 1];
        out.push(e === '>' ? '&gt;' : e);
        i = j + 2;
        run = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < b && k > j + 1) {
        if (j > run) out.push(s.slice(run, j));
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        run = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (j + 1 < b && s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2, b);
        if (k !== -1 && k > j + 2) {
          if (j > run) out.push(s.slice(run, j));
          out.push('<strong>');
          inlineInto(s, j + 2, k, link, out);
          out.push('</strong>');
          i = k + 2;
          run = i;
        } else {
          i = j + 2;
        }
        continue;
      }
      const k = findSingleStar(s, j + 1, b);
      if (k !== -1 && k > j + 1) {
        if (j > run) out.push(s.slice(run, j));
        out.push('<em>');
        inlineInto(s, j + 1, k, link, out);
        out.push('</em>');
        i = k + 1;
        run = i;
      } else {
        i = j + 1;
      }
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', j + 1, b);
    let m2 = -1;
    if (k !== -1 && k + 1 < b && s[k + 1] === '(') {
      m2 = s.indexOf(')', k + 2);
      if (m2 === -1 || m2 >= b) m2 = -1;
    }
    const target = m2 === -1 ? '' : s.slice(k + 2, m2);
    if (target !== '' && !/\s/.test(target)) {
      if (j > run) out.push(s.slice(run, j));
      out.push('<a href="', escapeHtml(link(target)), '">');
      inlineInto(s, j + 1, k, link, out);
      out.push('</a>');
      i = m2 + 1;
      run = i;
    } else {
      i = j + 1;
    }
  }
  if (b > run) out.push(s.slice(run, b));
}

function inline(s, link) {
  const out = [];
  inlineInto(s, 0, s.length, link, out);
  return out.join('');
}

// Line helpers over s[a..b) (a line without its '\n').

function isBlank(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Trailing spaces/tabs stripped: end index of the line's content. */
function rtrimEnd(s, a, b) {
  let e = b;
  while (e > a) {
    const c = s.charCodeAt(e - 1);
    if (c === 32 || c === 9) e--;
    else break;
  }
  return e;
}

/** Leading spaces/tabs stripped: start index of the line's content. */
function ltrimStart(s, a, b) {
  let i = a;
  while (i < b) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9) i++;
    else break;
  }
  return i;
}

function trimLineStr(s, a, b) {
  return s.slice(ltrimStart(s, a, b), rtrimEnd(s, a, b));
}

/** Fence open: ``` + lang [A-Za-z0-9_+-]* + spaces/tabs only; returns lang or null. */
function fenceOpen(s, a, b) {
  if (b - a < 3 || s.charCodeAt(a) !== 96 || s.charCodeAt(a + 1) !== 96 || s.charCodeAt(a + 2) !== 96) return null;
  let i = a + 3;
  while (i < b) {
    const c = s.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = s.slice(a + 3, i);
  while (i < b) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Fence close: ``` + spaces/tabs only. */
function fenceClose(s, a, b) {
  if (b - a < 3 || s.charCodeAt(a) !== 96 || s.charCodeAt(a + 1) !== 96 || s.charCodeAt(a + 2) !== 96) return false;
  for (let i = a + 3; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Heading: 1-6 #, >=1 space/tab, non-empty text; returns {depth, text} or null. */
function headingOf(s, a, b) {
  let i = a;
  while (i < b && s.charCodeAt(i) === 35 && i - a < 6) i++;
  const depth = i - a;
  if (depth === 0 || depth > 6) return null;
  if (i >= b) return null;
  const c = s.charCodeAt(i);
  if (c !== 32 && c !== 9) return null;
  const ts = ltrimStart(s, i, b);
  if (ts >= b) return null;
  const te = rtrimEnd(s, ts, b);
  if (te <= ts) return null;
  return { depth, text: s.slice(ts, te) };
}

/** Thematic break: --- or *** + spaces/tabs only. */
function isHr(s, a, b) {
  if (b - a < 3) return false;
  const c0 = s.charCodeAt(a);
  if (c0 !== 45 && c0 !== 42) return false;
  if (s.charCodeAt(a + 1) !== c0 || s.charCodeAt(a + 2) !== c0) return false;
  for (let i = a + 3; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether a line ends a paragraph: blank, fence open, heading or thematic break. */
function endsParagraph(s, a, b) {
  return isBlank(s, a, b) || fenceOpen(s, a, b) !== null || headingOf(s, a, b) !== null || isHr(s, a, b);
}

/** Bullet marker: '- ' or '* '; returns content start or -1. */
function bulletStart(s, a, b) {
  if (b - a < 2) return -1;
  const c = s.charCodeAt(a);
  if ((c === 45 || c === 42) && s.charCodeAt(a + 1) === 32) return a + 2;
  return -1;
}

/** Ordered marker: 1-9 digits + '. '; returns {content, num} or null. */
function orderedStart(s, a, b) {
  let i = a;
  while (i < b && i - a < 9) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
  }
  const digits = i - a;
  if (digits === 0) return null;
  if (i + 1 >= b || s.charCodeAt(i) !== 46 || s.charCodeAt(i + 1) !== 32) return null;
  return { content: i + 2, num: Number(s.slice(a, i)) };
}

/** Continuation line: 2+ spaces then a non-space, non-tab char. */
function isContinued(s, a, b) {
  if (b - a < 3) return false;
  if (s.charCodeAt(a) !== 32 || s.charCodeAt(a + 1) !== 32) return false;
  let i = a + 2;
  while (i < b && s.charCodeAt(i) === 32) i++;
  if (i >= b) return false;
  const c = s.charCodeAt(i);
  return c !== 32 && c !== 9;
}

/**
 * `src` rendered: { html, toc, excerpt }. Single pass over the source; no
 * token objects, no per-line regexes.
 */
function renderMarkdown(src, link, slugCache) {
  const n = src.length;
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let pos = 0;
  while (pos <= n) {
    const nl = src.indexOf('\n', pos);
    const le = nl === -1 ? n : nl;
    const nextPos = nl === -1 ? n + 1 : nl + 1;
    if (isBlank(src, pos, le)) {
      if (nl === -1) break;
      pos = nextPos;
      continue;
    }
    const fence = fenceOpen(src, pos, le);
    if (fence !== null) {
      const lang = fence;
      const parts = [];
      pos = nextPos;
      while (pos <= n) {
        const nl2 = src.indexOf('\n', pos);
        const le2 = nl2 === -1 ? n : nl2;
        if (fenceClose(src, pos, le2)) {
          pos = nl2 === -1 ? n + 1 : nl2 + 1;
          break;
        }
        parts.push(escapeHtml(src.slice(pos, le2)), '\n');
        if (nl2 === -1) {
          pos = n + 1;
          break;
        }
        pos = nl2 + 1;
      }
      const cls = lang === '' ? '' : ` class="language-${lang}"`;
      blocks.push(`<pre><code${cls}>${parts.join('')}</code></pre>`);
      if (pos > n) break;
      continue;
    }
    const heading = headingOf(src, pos, le);
    if (heading !== null) {
      const id = uniqueSlug(slugifyCached(heading.text, slugCache), ids);
      const html = inline(heading.text, link);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      if (nl === -1) break;
      pos = nextPos;
      continue;
    }
    if (isHr(src, pos, le)) {
      blocks.push('<hr>');
      if (nl === -1) break;
      pos = nextPos;
      continue;
    }
    if (src.charCodeAt(pos) === 62) {
      // '>' blockquote
      const lines = [];
      while (pos <= n) {
        const nl2 = src.indexOf('\n', pos);
        const le2 = nl2 === -1 ? n : nl2;
        if (src.charCodeAt(pos) !== 62) break;
        let cs = pos + 1;
        if (cs < le2 && src.charCodeAt(cs) === 32) cs++;
        const t = trimLineStr(src, cs, le2);
        if (t !== '') lines.push(t);
        if (nl2 === -1) {
          pos = n + 1;
          break;
        }
        pos = nl2 + 1;
      }
      blocks.push(lines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(lines.join('\n'), link)}</p>\n</blockquote>`);
      if (pos > n) break;
      continue;
    }
    const bStart = bulletStart(src, pos, le);
    const oStart = bStart === -1 ? orderedStart(src, pos, le) : null;
    if (bStart !== -1 || oStart !== null) {
      const isOrdered = oStart !== null;
      const startNum = isOrdered ? oStart.num : 1;
      const items = [];
      while (pos <= n) {
        const nl2 = src.indexOf('\n', pos);
        const le2 = nl2 === -1 ? n : nl2;
        let content = -1;
        if (isOrdered) {
          const o = orderedStart(src, pos, le2);
          if (o !== null) content = o.content;
        } else {
          content = bulletStart(src, pos, le2);
        }
        if (content !== -1) {
          items.push([trimLineStr(src, content, le2)]);
        } else if (isContinued(src, pos, le2)) {
          items[items.length - 1].push(trimLineStr(src, pos, le2));
        } else break;
        if (nl2 === -1) {
          pos = n + 1;
          break;
        }
        pos = nl2 + 1;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`;
      const parts = [open, '\n'];
      for (const partsArr of items) parts.push(`<li>${inline(partsArr.join('\n'), link)}</li>\n`);
      parts.push(`</${tag}>`);
      blocks.push(parts.join(''));
      if (pos > n) break;
      continue;
    }
    // Paragraph.
    const lines = [trimLineStr(src, pos, le)];
    pos = nextPos;
    while (pos <= n) {
      const nl2 = src.indexOf('\n', pos);
      const le2 = nl2 === -1 ? n : nl2;
      if (endsParagraph(src, pos, le2)) break;
      lines.push(trimLineStr(src, pos, le2));
      if (nl2 === -1) {
        pos = n + 1;
        break;
      }
      pos = nl2 + 1;
    }
    const html = inline(lines.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
    if (pos > n) break;
  }
  const out = [];
  for (const b of blocks) {
    out.push(b, '\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

function slugifyCached(text, cache) {
  let v = cache.get(text);
  if (v === undefined) {
    v = slugifyRaw(text);
    cache.set(text, v);
  }
  return v;
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTree(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// Flat ops. op: 0 text, 1 var, 2 raw, 3 if, 4 else-jump, 5 for, 6 loop-next, 7 include.
// flatten also records, per template, the names it reads freely (first path
// segments not bound by an enclosing for in the same template) and its
// includes with the names bound at each include site; run() closes these over
// includes to decide which templates are constant (they read only site, tags
// and recent, the same for every page).
function flatten(nodes, ops, bound, ownFree, includes) {
  for (const n of nodes) {
    if (n.kind === 'text') ops.push({ op: 0, s: n.text });
    else if (n.kind === 'var') {
      ops.push({ op: 1, path: n.path });
      if (!bound.has(n.path[0])) ownFree.add(n.path[0]);
    } else if (n.kind === 'raw') {
      ops.push({ op: 2, path: n.path });
      if (!bound.has(n.path[0])) ownFree.add(n.path[0]);
    } else if (n.kind === 'if') {
      const ifOp = { op: 3, path: n.path, not: n.not, els: 0 };
      ops.push(ifOp);
      if (!bound.has(n.path[0])) ownFree.add(n.path[0]);
      flatten(n.then, ops, bound, ownFree, includes);
      if (n.else !== null) {
        const elseOp = { op: 4, end: 0 };
        ops.push(elseOp);
        ifOp.els = ops.length;
        flatten(n.else, ops, bound, ownFree, includes);
        elseOp.end = ops.length;
        ifOp.end = ops.length;
      } else {
        ifOp.els = ops.length;
        ifOp.end = ops.length;
      }
    } else if (n.kind === 'for') {
      const forOp = { op: 5, name: n.name, path: n.path, end: 0 };
      ops.push(forOp);
      if (!bound.has(n.path[0])) ownFree.add(n.path[0]);
      const inner = new Set(bound);
      inner.add(n.name);
      inner.add('loop'); // a for binds its element name and `loop` together
      flatten(n.body, ops, inner, ownFree, includes);
      ops.push({ op: 6, forOp });
      forOp.end = ops.length;
    } else if (n.kind === 'include') {
      ops.push({ op: 7, name: n.name });
      includes.push({ name: n.name, bound: new Set(bound) });
    }
  }
  return ops;
}

/** Parse a template source into flat ops (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const ownFree = new Set();
  const includes = [];
  const ops = flatten(parseTree(name, src), [], new Set(), ownFree, includes);
  ops.ownFree = ownFree;
  ops.includes = includes;
  return ops;
}

/** Close the free-name sets over includes; mark constant templates. */
function analyseTemplates(templates) {
  for (const ops of templates.values()) ops.free = new Set(ops.ownFree);
  let changed = true;
  while (changed) {
    changed = false;
    for (const ops of templates.values()) {
      for (const inc of ops.includes) {
        const sub = templates.get(inc.name);
        if (sub === undefined) continue;
        for (const n of sub.free) {
          if (!inc.bound.has(n) && !ops.free.has(n)) {
            ops.free.add(n);
            changed = true;
          }
        }
      }
    }
  }
  for (const ops of templates.values()) {
    let constant = true;
    for (const n of ops.free) {
      if (n !== 'site' && n !== 'tags' && n !== 'recent') {
        constant = false;
        break;
      }
    }
    ops.constant = constant;
  }
}

/** The value at `path` in the scope chain. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += textOf(v[i]);
    }
    return out;
  }
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * Render flat `ops` in `scope` into `out` (an array of strings).
 * Iterative: an explicit call stack for includes, an explicit loop stack for
 * {% for %}; `templates` maps names to op arrays. A constant template (it reads
 * only site, tags and recent, the same for every page) is rendered once per
 * entry include depth and cached in `constCache`, unless an active loop binds
 * one of the names it reads.
 */
function renderOps(ops, scope, templates, out, constCache, startDepth) {
  let cur = ops;
  let pc = 0;
  let depth = startDepth === undefined ? 0 : startDepth;
  const callStack = [];
  const loopStack = [];
  for (;;) {
    while (pc < cur.length) {
      const o = cur[pc];
      switch (o.op) {
        case 0:
          out.push(o.s);
          pc++;
          break;
        case 1:
          out.push(escapeHtml(textOf(lookup(scope, o.path))));
          pc++;
          break;
        case 2:
          out.push(textOf(lookup(scope, o.path)));
          pc++;
          break;
        case 3: {
          const v = truthy(lookup(scope, o.path));
          pc = v !== o.not ? pc + 1 : o.els;
          break;
        }
        case 4:
          pc = o.end;
          break;
        case 5: {
          const xs = lookup(scope, o.path);
          if (!Array.isArray(xs) || xs.length === 0) {
            pc = o.end;
            break;
          }
          const vars = { loop: { index: 1, first: true, last: xs.length === 1, length: xs.length } };
          vars[o.name] = xs[0];
          const frame = { arr: xs, idx: 0, name: o.name, vars, bodyPc: pc + 1, endPc: o.end, parentScope: scope };
          frame.scope = { vars, parent: scope };
          loopStack.push(frame);
          scope = frame.scope;
          pc++;
          break;
        }
        case 6: {
          const fr = loopStack[loopStack.length - 1];
          fr.idx++;
          if (fr.idx < fr.arr.length) {
            fr.vars[fr.name] = fr.arr[fr.idx];
            const lp = fr.vars.loop;
            lp.index = fr.idx + 1;
            lp.first = fr.idx === 0;
            lp.last = fr.idx === fr.arr.length - 1;
            scope = fr.scope;
            pc = fr.bodyPc;
          } else {
            loopStack.pop();
            scope = fr.parentScope;
            pc = fr.endPc;
          }
          break;
        }
        case 7: {
          const t = templates.get(o.name);
          if (t === undefined || depth >= 8) {
            pc++;
            break;
          }
          if (t.constant) {
            let shadowed = false;
            for (let li = 0; li < loopStack.length; li++) {
              if (t.free.has(loopStack[li].name)) {
                shadowed = true;
                break;
              }
            }
            if (!shadowed) {
              const key = `${o.name}\n${depth + 1}`;
              let s = constCache.get(key);
              if (s === undefined) {
                const tmp = [];
                renderOps(t, scope, templates, tmp, constCache, depth + 1);
                s = tmp.join('');
                constCache.set(key, s);
              }
              out.push(s);
              pc++;
              break;
            }
          }
          callStack.push({ ops: cur, pc: pc + 1 });
          depth++;
          cur = t;
          pc = 0;
          break;
        }
      }
    }
    if (callStack.length === 0) break;
    const f = callStack.pop();
    depth--;
    cur = f.ops;
    pc = f.pc;
  }
}

// ---------------------------------------------------------------- build

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

export function run(input) {
  const slugCache = new Map();
  const slugify = (text) => slugifyCached(text, slugCache);
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  analyseTemplates(templates);
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push(f);
  }
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) {
        own = d;
        break;
      }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const link = (target) => {
      if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const page = bySource.get(path);
        if (page !== undefined) return `${page.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${srcPath} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.reading = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (const name of tags) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    const refs = [];
    for (const name of ownTags(s)) {
      const slug = slugify(name);
      refs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
    s.tagRefs = refs;
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  const linkOf = (s) =>
    s === null
      ? null
      : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const cards = new Map();
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.reading,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const p of posts) cards.set(p, cardOf(p));
  const pageOf = (s) => {
    const c = cardOf(s);
    c.slug = s.slug;
    c.content = s.html;
    c.toc = s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
    c.newer = linkOf(s.newer ?? null);
    c.older = linkOf(s.older ?? null);
    c.is_post = s.post;
    return c;
  };
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const constCache = new Map();
  const render = (name, vars) => {
    const ops = templates.get(name);
    if (ops === undefined) return null;
    const out = [];
    renderOps(ops, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, templates, out, constCache, 0);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }
  const lines = [...report, ...broken].sort(byCodeUnits);
  const nPages = kept.filter((s) => !s.post).length;
  lines.push(`built ${nPages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
