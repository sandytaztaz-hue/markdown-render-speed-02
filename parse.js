// parse.js — a fast CommonMark 0.31.2 + GFM renderer.
//
// Written from scratch to return, for every input string, exactly the HTML
// that marked 18.1.3 renders with its default options (gfm on, breaks off,
// pedantic off, async off). The grammar it implements is the CommonMark
// spec plus the GFM extensions (tables, task lists, strikethrough,
// extended autolinks, disallowed raw HTML); where marked departs from the
// spec, marked's output is what this reproduces.
//
// Design: a block pass splits the document into blocks (collecting link
// reference definitions as it goes), then a render pass turns each block
// into HTML, running the inline pass over its text. Inline tokenizing
// happens only after every block is known, so a reference defined anywhere
// in the document applies everywhere, exactly like marked.

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  const ctx = {
    links: Object.create(null),
    queue: [], // {src, into} inline jobs, filled after the block pass
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
  };
  const tokens = blockTokens(src, [], ctx, false);
  // Inline pass: every queued text now has the full link map available.
  for (let i = 0; i < ctx.queue.length; i++) {
    const job = ctx.queue[i];
    ctx.inRawBlock = false;
    job.into.push(...inlineTokens(job.src, ctx));
  }
  ctx.queue.length = 0;
  return renderBlocks(tokens);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const RE_ESCAPE = /[&<>"']/;
const RE_ESCAPE_G = /[&<>"']/g;
const RE_ESCAPE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const RE_ESCAPE_NO_ENCODE_G = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Escape HTML characters. encode=true escapes & always; otherwise a & that
// starts a valid character or entity reference is left alone.
function esc(s, encode) {
  if (encode) {
    return RE_ESCAPE.test(s) ? s.replace(RE_ESCAPE_G, (c) => ESCAPES[c]) : s;
  }
  return RE_ESCAPE_NO_ENCODE.test(s) ? s.replace(RE_ESCAPE_NO_ENCODE_G, (c) => ESCAPES[c]) : s;
}

const RE_NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const RE_NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Decode numeric character references in plain text; a bare & becomes
// &amp;. Named references are intentionally left untouched.
function unescapeEntities(s) {
  if (!RE_NUM_REF.test(s)) return s;
  return s.replace(RE_NUM_REF_OR_AMP, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

const RE_PERCENT = /%25/g;
// Clean a link/image URL the way marked does: encodeURI, keeping % literal.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(RE_PERCENT, '%');
  } catch {
    return null;
  }
}

// Normalize a link label for lookup: trim, collapse whitespace, fold case.
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Strip trailing characters: L(str, ch) removes a run of ch from the end;
// with t=true it removes a run of anything that is NOT ch.
function stripTail(s, ch, not) {
  const n = s.length;
  if (n === 0) return '';
  let k = 0;
  for (; k < n;) {
    const c = s.charAt(n - k - 1);
    if (c === ch && !not) k++;
    else if (c !== ch && not) k++;
    else break;
  }
  return s.slice(0, n - k);
}

// Expand tabs to spaces, columns counted from col.
function expandTabs(s, col) {
  let out = '';
  let c = col;
  for (const ch of s) {
    if (ch === '\t') {
      const n = 4 - (c % 4);
      out += ' '.repeat(n);
      c += n;
    } else {
      out += ch;
      c++;
    }
  }
  return out;
}

// Drop trailing blank lines of a block when there are more than one.
function trimBlankTail(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && /^[ \t]*$/.test(lines[t]);) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// Parenthesis balance of s: index of the first unbalanced ')', -2 when an
// opening '(' is never closed, -1 when balanced.
function parenBalance(s) {
  if (s.indexOf('(') === -1 && s.indexOf(')') === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '(') depth++;
    else if (s[i] === ')' && (--depth, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

// Split a table row into cells, honouring escaped pipes and edge pipes.
function splitCells(row, count) {
  const t = row.replace(/\|/g, (ch, off, str) => {
    let escaped = false;
    let p = off;
    for (; --p >= 0 && str[p] === '\\';) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = t.split(/ \|/);
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells.at(-1)?.trim() && cells.pop(), count) {
    if (cells.length > count) cells.splice(count);
    else for (; cells.length < count;) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// ---------------------------------------------------------------------------
// Grammar: block-level patterns
// ---------------------------------------------------------------------------

// Block-level HTML tag names (CommonMark appendix / GFM).
const TAG_NAMES =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|' +
  'fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|' +
  'menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// Reusable fragments (each is a pattern source, no leading ^).
const P_HR = ' {0,3}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const P_HEADING = ' {0,3}#{1,6}(?:\\s|$)';
const P_FENCES = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const P_BLOCKQUOTE = ' {0,3}>';
const P_HTML_OPEN =
  ' {0,3}(?:</?(?:' + TAG_NAMES + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const P_LIST_KE = ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)';
const P_BULL = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';
const P_LIST_PARA = ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]';
const P_LIST_XE = ' {0,3}(?:[*+-]|1[.)])[ \\t]';
const P_CODE_IND = '(?: {4}| {0,3}\\t)[^\\n]';

// A table: header line, delimiter row, then body rows that do not start a
// new block construct.
const P_TABLE =
  ' *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)' +
  '(?:\\n((?:(?! *\\n|' + P_HR + '|' + P_HEADING + '|' + P_BLOCKQUOTE + '|' + P_CODE_IND + '|' + P_FENCES +
  '|' + P_LIST_XE + '|' + P_HTML_OPEN + ').*(?:\\n|$))*)\\n*|$)';

// A paragraph continues onto the next line unless that line starts a block
// construct (a setext underline is handled by the lheading rule instead,
// and a table stops a paragraph).
const P_PARA =
  '^([^\\n]+(?:\\n(?!' + P_HR + '|' + P_HEADING + '|' + P_BLOCKQUOTE + '|' + P_FENCES + '|' + P_LIST_PARA +
  '|' + P_HTML_OPEN + '|' + P_TABLE + '|[ \\t]+\\n)[^\\n]+)*)';

// The same paragraph rule as used inside block quotes: there an ordered
// list may start with any number, and a table does not stop the paragraph.
const P_PARA_QUOTE =
  '^([^\\n]+(?:\\n(?!' + P_HR + '|' + P_HEADING + '|' + P_BLOCKQUOTE + '|' + P_FENCES + '|' + P_LIST_KE +
  '|' + P_HTML_OPEN + '|[ \\t]+\\n)[^\\n]+)*)';

const RE_BLOCK = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  hr: new RegExp('^' + P_HR),
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  blockquote: new RegExp('^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(' + P_PARA_QUOTE.slice(1) + ')|[^\\n]*)(?:\\n|$))+'),
  list: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
  html: new RegExp(
    '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)' +
    '|<!--(?:-?>|[\\s\\S]*?(?:-->|$))[^\\n]*(\\n+|$)' +
    '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)' +
    '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)' +
    '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)' +
    '|</?(' + TAG_NAMES + ')(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)' +
    '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)' +
    '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))', 'i'),
  def: /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\)))? *(?:\n+|$)/,
  table: new RegExp('^' + P_TABLE),
  // Setext heading: the text may not itself start a list, code block,
  // fence, quote, ATX heading, HTML block or table.
  lheading: new RegExp(
    '^(?!' + P_BULL + '|(?: {4}| {0,3}\\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>|' + P_HEADING +
    '| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n)' +
    '((?:.|\\n(?!\\s*?\\n|' + P_BULL + '| {0,3}(?:`{3,}|~{3,})| {0,3}>|' + P_HEADING +
    '| {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}<[^\\n>]+>\\n' +
    '| {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)'),
  paragraph: new RegExp(P_PARA),
  text: /^[^\n]+/,
};

// Patterns consulted while scanning list items. The indent they are built
// with is clamped to 0..3 (marked's memoizer builds them for indent-1,
// capped at 3): a construct indented 4 or more spaces is not seen as a new
// block start from inside a list item.
const clampInd = (indent) => Math.max(0, Math.min(3, indent - 1));
const RE_LIST_ITEM = (bull) => new RegExp(`^( {0,3}${bull})((?:[ \t][^\n]*)?(?:\n|$))`);
const RE_NEXT_BULLET = (indent) => new RegExp(`^ {0,${clampInd(indent)}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))`);
const RE_HR_IND = (indent) => new RegExp(`^ {0,${clampInd(indent)}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`);
const RE_FENCES_IND = (indent) => new RegExp(`^ {0,${clampInd(indent)}}(?:\`\`\`|~~~)`);
const RE_HEADING_IND = (indent) => new RegExp(`^ {0,${clampInd(indent)}}#{1,6}(?:\\s|$)`);
const RE_HTML_IND = (indent) =>
  new RegExp(`^ {0,${clampInd(indent)}}(?:</?(?:${TAG_NAMES})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
const RE_BLOCKQUOTE_IND = (indent) => new RegExp(`^ {0,${clampInd(indent)}}>`);

// ---------------------------------------------------------------------------
// Grammar: inline-level patterns
// ---------------------------------------------------------------------------

// Fragments for link labels and references (pattern sources).
const FRAG_BRACKETS = '\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]';
const FRAG_LABEL =
  '(?:\\[(?:' + FRAG_BRACKETS + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
const FRAG_REF = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const FRAG_REF_SEARCH = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}';
const FRAG_REF_SEARCH_LABEL =
  '(?:[^\\[\\]\\\\`]*(?:\\[(?:' + FRAG_BRACKETS + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?';
const FRAG_HREF = '<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\))';
const FRAG_TITLE = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)';
const FRAG_EMAIL = '[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const FRAG_EMAIL_G = '[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';

// Unicode classes used by the emphasis delimiter rules.
const P_PUNCT = '[\\p{P}\\p{S}]';
const P_PUNCT_NT = '(?!~)[\\p{P}\\p{S}]'; // punct, but never ~
const P_PUNCT_SPACE = '[\\s\\p{P}\\p{S}]';
const P_PUNCT_SPACE_NT = '(?!~)[\\s\\p{P}\\p{S}]';
const P_NOT_PS = '[^\\s\\p{P}\\p{S}]'; // not punct/space
const P_NOT_PS_T = '(?:[^\\s\\p{P}\\p{S}]|~)'; // not punct/space, or ~

const RE_INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  // Two trailing spaces, or a backslash, before a line end.
  br: /^( {2,}|[\x5c])\n(?!\s*$)[ \t]*/,
  // Plain text: stops before anything that might start a construct, before
  // a hard break, and before something that might start an extended autolink.
  text: new RegExp(
    '^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\\n)|(?=[a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-]+@)|[\\s\\S]*?(?:(?=[\\\\<!\\[`*~_]|\\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\\/\\/|(?<![^\\s*_~(])www\\.|$)|[^ ](?= {2,}\\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-]+@))))'),
  delLDelim: new RegExp('^~~?(?:((?!~)' + P_PUNCT + ')|[^\\s~])', 'u'),
  delRDelim: new RegExp(
    '^[^~]+(?=[^~])|(?!~)' + P_PUNCT + '(~~?)(?=[\\s]|$)|' + P_NOT_PS +
    '(~~?)(?!~)(?=' + P_PUNCT_SPACE + '|$)|(?!~)' + P_PUNCT_SPACE +
    '(~~?)(?=' + P_NOT_PS + ')|[\\s](~~?)(?!~)(?=' + P_PUNCT +
    ')|(?!~)' + P_PUNCT + '(~~?)(?!~)(?=' + P_PUNCT + ')|' + P_NOT_PS +
    '(~~?)(?=' + P_NOT_PS + ')', 'gu'),
  emStrongLDelim: new RegExp(
    '^(?:\\*+(?:((?!\\*)(?!~)' + P_PUNCT + ')|([^\\s*]))?)|^_+(?:((?!_)(?!~)' + P_PUNCT + ')|([^\\s_]))?', 'u'),
  // Delimiter runs that can close * emphasis. Each alternative is one
  // character before the run (or skipped text), then the run itself.
  emStrongRDelimAst: new RegExp(
    '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])' +
    '|(?!\\*)' + P_PUNCT_NT + '(\\*+)(?=[\\s]|$)' +
    '|' + P_NOT_PS_T + '(\\*+)(?!\\*)(?=' + P_PUNCT_SPACE_NT + '|$)' +
    '|(?!\\*)' + P_PUNCT_SPACE_NT + '(\\*+)(?=' + P_NOT_PS_T + ')' +
    '|[\\s](\\*+)(?!\\*)(?=' + P_PUNCT_NT + ')' +
    '|(?!\\*)' + P_PUNCT_NT + '(\\*+)(?!\\*)(?=' + P_PUNCT_NT + ')' +
    '|' + P_NOT_PS_T + '(\\*+)(?=' + P_NOT_PS_T + ')', 'gu'),
  emStrongRDelimUnd: new RegExp(
    '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])' +
    '|(?!_)' + P_PUNCT + '(_+)(?=[\\s]|$)' +
    '|' + P_NOT_PS + '(_+)(?!_)(?=' + P_PUNCT_SPACE + '|$)' +
    '|(?!_)' + P_PUNCT_SPACE + '(_+)(?=' + P_NOT_PS + ')' +
    '|[\\s](_+)(?!_)(?=' + P_PUNCT + ')' +
    '|(?!_)' + P_PUNCT + '(_+)(?!_)(?=' + P_PUNCT + ')', 'gu'),
  anyPunctuation: new RegExp('\\\\(' + P_PUNCT + ')', 'gu'),
  anyPunctuationOutsideCode: new RegExp(
    '(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\(' + P_PUNCT + ')', 'gu'),
  // Links, code spans and tags, as seen by the emphasis mask: they hide
  // their contents from delimiter scanning.
  blockSkip: new RegExp(
    '\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)' +
    '|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)' +
    '|<(?! )[^<>]*?>', 'g'),
  punctuation: new RegExp('^((?![*_])' + P_PUNCT_SPACE + ')', 'u'),
  autolink: new RegExp(
    '^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\\s\\x00-\\x1f<>]*|[a-zA-Z0-9.!#$%&\'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>'),
  tag: /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/,
  link: new RegExp(
    '^!?\\[(' + FRAG_LABEL + ')\\]\\([ \\t\\n]*(' + FRAG_HREF +
    ')(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(' + FRAG_TITLE + '))?[ \\t\\n]*\\)'),
  reflink: new RegExp('^!?\\[(' + FRAG_LABEL + ')\\]\\[(' + FRAG_REF + ')\\]'),
  nolink: new RegExp('^!?\\[(' + FRAG_REF + ')\\](?:\\[\\])?'),
  reflinkSearch: new RegExp(
    '!?\\[(' + FRAG_REF_SEARCH_LABEL + ')\\]\\[(' + FRAG_REF_SEARCH + ')\\]|!?\\[(' +
    FRAG_REF_SEARCH + ')\\](?:\\[\\])?(?!\\()', 'g'),
  url: new RegExp(
    '^(?:mailto:' + FRAG_EMAIL + '|xmpp:' + FRAG_EMAIL + '(?:\\/[A-Za-z0-9@.]+)?)' +
    '|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*' +
    '|^' + FRAG_EMAIL_G),
  _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
};

// Single-character tag checks used by the inline tag tokenizer.
const RE_START_A_TAG = /^<a /i;
const RE_END_A_TAG = /^<\/a>/i;
const RE_START_PRE_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const RE_END_PRE_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;
const RE_START_ANGLE = /^</;
const RE_END_ANGLE = />$/;
const RE_UNICODE_ALNUM = /[\p{L}\p{N}]/u;

// ---------------------------------------------------------------------------
// Block tokenizing
// ---------------------------------------------------------------------------

const RE_BLANK_LINE = /^[ \t]*$/;
const RE_DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;
const RE_ANY_LINE = /\n.*\n/;
const RE_NON_SPACE = /[^ ]/;
const RE_LEADING_SPACE_TAB = /^[ \t]+/;
const RE_LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const RE_LIST_REPLACE_TASK = /^\[[ xX]\][ \t]+/;
const RE_LIST_CHECKBOX = /\[[ xX]\]/;
const RE_SETEXT_LINE = /^ {0,3}(?:=+|-+) *$/;
const RE_BLOCKQUOTE_START = /^ {0,3}>/;
const RE_BLOCKQUOTE_WS = /^( {0,3}>)([ \t]+)/gm;
const RE_BLOCKQUOTE_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const RE_BLOCKQUOTE_SETEXT2 = /^ {0,3}>[ \t]?/gm;
const RE_CODE_REMOVE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const RE_INDENT_CODE_COMP = /^(\s+)(?:```)/;
const RE_BEGINNING_SPACE = /^\s+/;
const RE_ENDING_HASH = /#$/;
const RE_ENDING_SPACE_TAB = /[ \t]$/;
const RE_TABLE_DELIM = /[:|]/;
const RE_TABLE_ALIGN_CHARS = /^\||\| *$/g;
const RE_TABLE_ROW_BLANK = /\n[ \t]*$/;
const RE_TABLE_ALIGN_RIGHT = /^ *-+: *$/;
const RE_TABLE_ALIGN_CENTER = /^ *:-+: *$/;
const RE_TABLE_ALIGN_LEFT = /^ *:-+ *$/;
const RE_HREF_BRACKETS = /^<(.*)>$/;
const RE_TAB_GLOBAL = /\t/g;

// Queue an inline job: the token's `tokens` array is filled once the whole
// document's blocks (and therefore its link definitions) are known.
function queueInline(ctx, src) {
  const tokens = [];
  ctx.queue.push({ src, into: tokens });
  return tokens;
}

function tokSpace(src) {
  const m = RE_BLOCK.newline.exec(src);
  if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
}

function tokCode(src) {
  const m = RE_BLOCK.code.exec(src);
  if (m) {
    const raw = trimBlankTail(m[0]);
    return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(RE_CODE_REMOVE_INDENT, '') };
  }
}

// De-indent fenced code by the opening fence's indent.
function deindentFence(raw, content) {
  const m = RE_INDENT_CODE_COMP.exec(raw);
  if (m === null) return content;
  const indent = m[1];
  return content.split('\n').map((line) => {
    const lm = RE_BEGINNING_SPACE.exec(line);
    if (lm === null) return line;
    return line.slice(Math.min(lm[0].length, indent.length));
  }).join('\n');
}

function tokFences(src) {
  const m = RE_BLOCK.fences.exec(src);
  if (m) {
    return {
      type: 'code',
      raw: m[0],
      lang: m[2] ? m[2].trim().replace(RE_INLINE.anyPunctuation, '$1') : m[2],
      text: deindentFence(m[0], m[3] || ''),
    };
  }
}

function tokHeading(src, ctx) {
  const m = RE_BLOCK.heading.exec(src);
  if (m) {
    let text = m[2].trim();
    if (RE_ENDING_HASH.test(text)) {
      const stripped = stripTail(text, '#');
      if (!stripped || RE_ENDING_SPACE_TAB.test(stripped)) text = stripped.trim();
    }
    return { type: 'heading', raw: stripTail(m[0], '\n'), depth: m[1].length, text, tokens: queueInline(ctx, text) };
  }
}

function tokHr(src) {
  const m = RE_BLOCK.hr.exec(src);
  if (m) return { type: 'hr', raw: stripTail(m[0], '\n') };
}

function tokBlockquote(src, ctx) {
  const m = RE_BLOCK.blockquote.exec(src);
  if (!m) return;
  let lines = stripTail(m[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  for (; lines.length > 0;) {
    let lazy = false;
    const chunk = [];
    let p;
    for (p = 0; p < lines.length; p++) {
      if (RE_BLOCKQUOTE_START.test(lines[p])) { chunk.push(lines[p]); lazy = true; }
      else if (!lazy) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const joined = chunk.join('\n');
    const dequoted = joined
      .replace(RE_BLOCKQUOTE_WS, (g, marker, ws) => marker + expandTabs(ws, marker.length))
      .replace(RE_BLOCKQUOTE_SETEXT, '\n    $1')
      .replace(RE_BLOCKQUOTE_SETEXT2, '');
    raw = raw ? raw + '\n' + joined : joined;
    text = text ? text + '\n' + dequoted : dequoted;
    const savedTop = ctx.top;
    ctx.top = true;
    blockTokens(dequoted, tokens, ctx, true);
    ctx.top = savedTop;
    if (lines.length === 0) break;
    const last = tokens.at(-1);
    if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' || last?.type === 'html' || last?.type === 'table') break;
    if (last?.type === 'blockquote') {
      const inner = last.raw + '\n' + lines.join('\n').replace(RE_BLOCKQUOTE_SETEXT2, '');
      const reparsed = tokBlockquote(inner, ctx);
      tokens[tokens.length - 1] = reparsed;
      const rest = inner.substring(reparsed.raw.length).replace(/^\n/, '');
      const restLines = rest ? rest.split('\n').length : 0;
      const taken = restLines ? lines.slice(0, -restLines) : lines;
      if (taken.length > 0) raw = raw + '\n' + taken.join('\n');
      text = text.substring(0, text.length - last.text.length) + reparsed.text;
      lines = lines.slice(taken.length);
      if (lines.length > 0 && RE_BLOCKQUOTE_START.test(lines[0])) continue;
      break;
    } else if (last?.type === 'list') {
      const joinedSrc = last.raw + '\n' + lines.join('\n');
      const reparsed = tokList(joinedSrc, ctx);
      tokens[tokens.length - 1] = reparsed;
      const extra = reparsed.raw.length > last.raw.length
        ? joinedSrc.slice(last.raw.length + 1, reparsed.raw.length).split('\n').length : 0;
      if (extra > 0) {
        const taken = lines.slice(0, extra).join('\n');
        raw = raw + '\n' + taken;
        text = text + '\n' + taken;
      }
      lines = lines.slice(extra);
      continue;
    }
  }
  return { type: 'blockquote', raw, tokens, text };
}

function tokList(src, ctx) {
  let m = RE_BLOCK.list.exec(src);
  if (!m) return;
  const full = src;
  const consumed = () => full.length - src.length;
  let bullet = m[1].trim();
  const ordered = bullet.length > 1;
  const list = { type: 'list', raw: '', ordered, start: ordered ? +bullet.slice(0, -1) : '', loose: false, items: [] };
  bullet = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
  const itemRe = RE_LIST_ITEM(bullet);
  let prevBlank = false;
  for (; src;) {
    let emptyItem = false;
    let itemText = '';
    if (!(m = itemRe.exec(src)) || RE_BLOCK.hr.test(src)) break;
    const startOff = consumed();
    src = src.substring(m[0].length);
    const nlF = m[2].indexOf('\n');
    let first = nlF === -1 ? m[2] : m[2].slice(0, nlF);
    const bulletLen = m[1].length;
    let content = first.includes('\t')
      ? first.replace(RE_LEADING_SPACE_TAB, (v) => expandTabs(v, bulletLen)) : first;
    const nlN = src.indexOf('\n');
    let next = nlN === -1 ? src : src.slice(0, nlN);
    let firstEmpty = !content.trim();
    let indent;
    if (firstEmpty) {
      indent = bulletLen + 1;
    } else {
      indent = content.search(RE_NON_SPACE);
      indent = indent > 4 ? 1 : indent;
      itemText = content.slice(indent);
      indent += bulletLen;
    }
    if (firstEmpty && RE_BLANK_LINE.test(next)) {
      src = src.substring(next.length + 1);
      emptyItem = true;
    }
    if (!emptyItem) {
      const nextBullet = RE_NEXT_BULLET(indent);
      const hrRe = RE_HR_IND(indent);
      const fenceRe = RE_FENCES_IND(indent);
      const headingRe = RE_HEADING_IND(indent);
      const htmlRe = RE_HTML_IND(indent);
      const quoteRe = RE_BLOCKQUOTE_IND(indent);
      for (; src;) {
        const nl = src.indexOf('\n');
        const line = nl === -1 ? src : src.slice(0, nl);
        next = line;
        // One leading-whitespace scan serves three checks: the block-starter
        // pre-filter, whether a tab needs expanding, and the blank test.
        let p = 0, tabInLead = false;
        while (p < line.length) {
          const c = line.charCodeAt(p);
          if (c === 32) p++;
          else if (c === 9) { tabInLead = true; p++; }
          else break;
        }
        const ch = p < line.length ? line.charCodeAt(p) : 0;
        const mayStart = ch === 96 || ch === 126 || ch === 35 || ch === 60 || ch === 62 ||
          ch === 45 || ch === 42 || ch === 43 || ch === 95 || (ch >= 48 && ch <= 57);
        if (mayStart && (fenceRe.test(line) || headingRe.test(line) || htmlRe.test(line) || quoteRe.test(line) || nextBullet.test(line) || hrRe.test(line))) break;
        // Expanding the leading tabs only matters when a tab is present;
        // without one the line is unchanged, so no regex replace is needed.
        const expanded = tabInLead
          ? line.replace(RE_LEADING_SPACE_TAB, (v) => expandTabs(v, 0)) : line;
        // Index of the first non-space/tab char in `expanded`: with no tab
        // it is p; with a tab the expansion shifts it, so fall back to the
        // regex search (tabs are rare).
        const firstNonWs = tabInLead ? expanded.search(RE_NON_SPACE) : p;
        // A line is blank when it is all whitespace: p at the end, or the
        // first non-space/tab char is itself whitespace (control char or
        // non-breaking space), in which case trim() decides.
        let isBlank = p >= line.length;
        if (!isBlank && (ch <= 32 || ch === 160)) isBlank = !line.trim();
        if (firstNonWs >= indent || isBlank) {
          itemText += '\n' + expanded.slice(indent);
        } else {
          if (firstEmpty || content.replace(RE_TAB_GLOBAL, '    ').search(RE_NON_SPACE) >= 4 ||
              fenceRe.test(content) || headingRe.test(content) || htmlRe.test(content) || hrRe.test(content)) break;
          const setext = RE_SETEXT_LINE.test(next) && RE_BLOCK.lheading.test(`${content}\n${next}`)
            ? `    ${expanded.replace(/^ {0,3}/, '')}` : next;
          itemText += '\n' + setext;
        }
        firstEmpty = !next.trim();
        src = nl === -1 ? '' : src.substring(nl + 1);
        content = expanded.slice(indent);
      }
    }
    const itemRaw = full.slice(startOff, consumed());
    if (!list.loose) {
      if (prevBlank) list.loose = true;
      else if (RE_DOUBLE_BLANK.test(itemRaw)) prevBlank = true;
    }
    list.items.push({ type: 'list_item', raw: itemRaw, task: RE_LIST_IS_TASK.test(itemText), loose: false, text: itemText, tokens: [] });
  }
  const lastItem = list.items.at(-1);
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return;
  }
  list.raw = full.slice(0, consumed()).trimEnd();
  for (const item of list.items) {
    ctx.top = false;
    item.tokens = blockTokens(item.text, [], ctx, false);
    if (!list.loose) {
      const spaces = item.tokens.filter((t) => t.type === 'space');
      list.loose = spaces.length > 0 && spaces.some((t) => RE_ANY_LINE.test(t.raw));
    }
  }
  for (const item of list.items) {
    const firstTok = item.tokens[0];
    if (item.task && (firstTok?.type === 'text' || firstTok?.type === 'paragraph')) {
      item.text = item.text.replace(RE_LIST_REPLACE_TASK, '');
      firstTok.raw = firstTok.raw.replace(RE_LIST_REPLACE_TASK, '');
      firstTok.text = firstTok.text.replace(RE_LIST_REPLACE_TASK, '');
      for (let g = ctx.queue.length - 1; g >= 0; g--) {
        if (RE_LIST_IS_TASK.test(ctx.queue[g].src)) {
          ctx.queue[g].src = ctx.queue[g].src.replace(RE_LIST_REPLACE_TASK, '');
          break;
        }
      }
      const box = RE_LIST_CHECKBOX.exec(item.raw);
      if (box) {
        const checkbox = { type: 'checkbox', raw: box[0] + ' ', checked: box[0] !== '[ ]' };
        item.checked = checkbox.checked;
        if (list.loose) {
          if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) &&
              'tokens' in item.tokens[0] && item.tokens[0].tokens) {
            item.tokens[0].raw = checkbox.raw + item.tokens[0].raw;
            item.tokens[0].text = checkbox.raw + item.tokens[0].text;
            item.tokens[0].tokens.unshift(checkbox);
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] });
          }
        } else {
          item.tokens.unshift(checkbox);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
    }
  }
  return list;
}

function tokHtml(src) {
  const m = RE_BLOCK.html.exec(src);
  if (m) {
    const raw = trimBlankTail(m[0]);
    return { type: 'html', block: true, raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text: raw };
  }
}

function tokDef(src) {
  const m = RE_BLOCK.def.exec(src);
  if (m) {
    if (!RE_START_ANGLE.test(m[2]) && parenBalance(m[2]) !== -1) return;
    const tag = normalizeLabel(m[1]);
    const href = m[2] ? m[2].replace(RE_HREF_BRACKETS, '$1').replace(RE_INLINE.anyPunctuation, '$1') : '';
    const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(RE_INLINE.anyPunctuation, '$1') : m[3];
    return { type: 'def', tag, raw: stripTail(m[0], '\n'), href, title };
  }
}

function tokTable(src, ctx) {
  const m = RE_BLOCK.table.exec(src);
  if (!m || !RE_TABLE_DELIM.test(m[2])) return;
  const header = splitCells(m[1]);
  const alignParts = m[2].replace(RE_TABLE_ALIGN_CHARS, '').split('|');
  const body = m[3]?.trim() ? m[3].replace(RE_TABLE_ROW_BLANK, '').split('\n') : [];
  if (header.length !== alignParts.length) return;
  const align = alignParts.map((a) =>
    RE_TABLE_ALIGN_RIGHT.test(a) ? 'right' :
    RE_TABLE_ALIGN_CENTER.test(a) ? 'center' :
    RE_TABLE_ALIGN_LEFT.test(a) ? 'left' : null);
  const table = { type: 'table', raw: stripTail(m[0], '\n'), header: [], align, rows: [] };
  for (let i = 0; i < header.length; i++) {
    table.header.push({ text: header[i], tokens: queueInline(ctx, header[i]), header: true, align: align[i] });
  }
  for (const row of body) {
    table.rows.push(splitCells(row, header.length).map((cell, p) =>
      ({ text: cell, tokens: queueInline(ctx, cell), header: false, align: align[p] })));
  }
  return table;
}

function tokLheading(src, ctx) {
  const m = RE_BLOCK.lheading.exec(src);
  if (m) {
    const text = m[1].trim();
    return { type: 'heading', raw: stripTail(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text, tokens: queueInline(ctx, text) };
  }
}

function tokParagraph(src, ctx) {
  const m = RE_BLOCK.paragraph.exec(src);
  if (m) {
    const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
    return { type: 'paragraph', raw: m[0], text, tokens: queueInline(ctx, text) };
  }
}

function tokText(src, ctx) {
  const m = RE_BLOCK.text.exec(src);
  if (m) return { type: 'text', raw: m[0], text: m[0], tokens: queueInline(ctx, m[0]) };
}

// Is the second line of src a table delimiter row? The table regex requires
// the delimiter on line 2 and its characters are only | : - space tab, with
// at least one -. This is a cheap necessary condition (an over-approximation
// the regex itself still confirms), so the big table regex is skipped when
// line 2 cannot be a delimiter.
function line2IsTableDelim(src) {
  const nl = src.indexOf('\n');
  if (nl === -1) return false;
  let i = nl + 1, sp = 0;
  while (i < src.length && src.charCodeAt(i) === 32 && sp < 3) { i++; sp++; }
  let hasDash = false;
  for (let j = i; j < src.length; j++) {
    const c = src.charCodeAt(j);
    if (c === 10) return hasDash;
    if (c === 45) { hasDash = true; continue; }
    if (c === 124 || c === 58 || c === 32 || c === 9) continue;
    return false;
  }
  return hasDash;
}

// Is there a setext underline (=+ or -+, after at most 3 spaces) on any line
// before the next blank line? The lheading regex needs such a line after its
// text, so this is a necessary condition; the regex itself confirms. Lines
// are checked cheaply (a normal text line fails on its first character).
function hasSetextUnderline(src) {
  let i = 0;
  const n = src.length;
  while (i < n) {
    let j = src.indexOf('\n', i);
    if (j === -1) j = n;
    let k = i;
    while (k < j && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9)) k++;
    if (k === j) return false;
    let p = i, sp = 0;
    while (p < j && src.charCodeAt(p) === 32 && sp < 3) { p++; sp++; }
    if (p < j) {
      const ch = src.charCodeAt(p);
      if (ch === 61 || ch === 45) {
        let q = p + 1;
        while (q < j && (src.charCodeAt(q) === ch || src.charCodeAt(q) === 32 || src.charCodeAt(q) === 9)) q++;
        if (q === j) return true;
      }
    }
    i = j + 1;
  }
  return false;
}

// Split src into block tokens, appending to `tokens`. `inLazy` is true when
// this call continues a block quote, so a leading paragraph merges with a
// paragraph token the previous call left behind.
function blockTokens(src, tokens, ctx, inLazy) {
  let guard = Infinity;
  while (src) {
    if (src.length < guard) guard = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    // First-char dispatch: scan the leading whitespace and note the first
    // non-whitespace char. Each block regex is anchored on a specific
    // starter character (or indent), so most of them can be skipped here;
    // the table and setext-heading regexes get a cheap necessary-condition
    // check instead. The order of the remaining attempts is unchanged.
    let i = 0, sp = 0, hasTab = false;
    while (i < src.length) {
      const ch = src.charCodeAt(i);
      if (ch === 32) { sp++; i++; }
      else if (ch === 9) { hasTab = true; i++; }
      else break;
    }
    const c1 = i < src.length ? src.charCodeAt(i) : 0;
    const indented = sp >= 4 || (hasTab && sp <= 3);
    const maySpace = i > 0 || c1 === 10;
    const mayCode = indented && c1 !== 10 && c1 !== 0;
    const may3 = sp <= 3 && !hasTab;
    const mayFences = may3 && (c1 === 96 || c1 === 126);
    const mayHeading = may3 && c1 === 35;
    const mayHr = may3 && (c1 === 45 || c1 === 95 || c1 === 42);
    const mayBlockquote = may3 && c1 === 62;
    const mayList = may3 && (c1 === 42 || c1 === 43 || c1 === 45 || (c1 >= 48 && c1 <= 57));
    const mayHtml = may3 && c1 === 60;
    const mayDef = may3 && c1 === 91;
    let tok;
    if (maySpace && (tok = tokSpace(src))) {
      src = src.slice(tok.raw.length);
      const last = tokens.at(-1);
      if (tok.raw.length === 1 && last !== undefined) last.raw += '\n';
      else tokens.push(tok);
      continue;
    }
    if (mayCode && (tok = tokCode(src))) {
      src = src.slice(tok.raw.length);
      const last = tokens.at(-1);
      if (last?.type === 'paragraph' || last?.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.text;
        ctx.queue.at(-1).src = last.text;
      } else tokens.push(tok);
      continue;
    }
    if (mayFences && (tok = tokFences(src))) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    if (mayHeading && (tok = tokHeading(src, ctx))) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    if (mayHr && (tok = tokHr(src))) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    if (mayBlockquote && (tok = tokBlockquote(src, ctx))) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    if (mayList && (tok = tokList(src, ctx))) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    if (mayHtml && (tok = tokHtml(src))) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    if (mayDef && (tok = tokDef(src))) {
      src = src.slice(tok.raw.length);
      const last = tokens.at(-1);
      if (last?.type === 'paragraph' || last?.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.raw;
        ctx.queue.at(-1).src = last.text;
      } else {
        if (!Object.hasOwn(ctx.links, tok.tag)) ctx.links[tok.tag] = { href: tok.href, title: tok.title };
        tokens.push(tok);
      }
      continue;
    }
    if (line2IsTableDelim(src) && (tok = tokTable(src, ctx))) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    if (hasSetextUnderline(src) && (tok = tokLheading(src, ctx))) { src = src.slice(tok.raw.length); tokens.push(tok); continue; }
    if (ctx.top && (tok = tokParagraph(src, ctx))) {
      const last = tokens.at(-1);
      if (inLazy && last?.type === 'paragraph') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.text;
        ctx.queue.pop();
        ctx.queue.at(-1).src = last.text;
      } else tokens.push(tok);
      inLazy = false;
      src = src.slice(tok.raw.length);
      continue;
    }
    if ((tok = tokText(src, ctx))) {
      src = src.slice(tok.raw.length);
      const last = tokens.at(-1);
      if (last?.type === 'text') {
        last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
        last.text += '\n' + tok.text;
        ctx.queue.pop();
        ctx.queue.at(-1).src = last.text;
      } else tokens.push(tok);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  ctx.top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// Inline tokenizing
// ---------------------------------------------------------------------------

function tokEscape(src) {
  const m = RE_INLINE.escape.exec(src);
  if (m) return { type: 'escape', raw: m[0], text: m[1] };
}

function tokTag(src, ctx) {
  const m = RE_INLINE.tag.exec(src);
  if (m) {
    if (!ctx.inLink && RE_START_A_TAG.test(m[0])) ctx.inLink = true;
    else if (ctx.inLink && RE_END_A_TAG.test(m[0])) ctx.inLink = false;
    if (!ctx.inRawBlock && RE_START_PRE_TAG.test(m[0])) ctx.inRawBlock = true;
    else if (ctx.inRawBlock && RE_END_PRE_TAG.test(m[0])) ctx.inRawBlock = false;
    return { type: 'html', raw: m[0], inLink: ctx.inLink, inRawBlock: ctx.inRawBlock, block: false, text: m[0] };
  }
}

// Would the link text swallow a tag or autolink that runs past its end?
function hasTagBeyond(src, label, bang) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const code = RE_INLINE.code.exec(label.slice(s));
      if (code) { s += code[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const tag = RE_INLINE.tag.exec(src.slice(bang + s)) || RE_INLINE.autolink.exec(src.slice(bang + s));
    if (tag) {
      if (tag[0].length > label.length - s) return true;
      s += tag[0].length - 1;
    }
  }
  return false;
}

// Build a link or image token, tokenizing its text (which may itself hold
// links; a link inside a link voids the outer one).
function makeLink(m, ref, raw, ctx) {
  const text = m[1].replace(/\\([\[\]])/g, '$1');
  const isImage = m[0].charAt(0) === '!';
  const savedInLink = ctx.inLink;
  const savedEmitted = ctx.linkEmitted;
  const savedRawBlock = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  const tokens = inlineTokens(text, ctx);
  const nested = ctx.linkEmitted;
  ctx.linkEmitted = savedEmitted;
  ctx.inLink = savedInLink;
  if (!isImage) {
    if (nested) { ctx.inRawBlock = savedRawBlock; return; }
    ctx.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href: ref.href, title: ref.title || null, text, tokens };
}

function tokLink(src, ctx) {
  if (ctx.linkParenPossible === false) return;
  const m = RE_INLINE.link.exec(src);
  if (!m) return;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (hasTagBeyond(src, m[1], bang)) return;
  if (RE_START_ANGLE.test(m[2])) {
    if (!RE_END_ANGLE.test(m[2])) return;
    const stripped = stripTail(m[2].slice(0, -1), '\\');
    if ((m[2].length - stripped.length) % 2 === 0) return;
  } else {
    const bal = parenBalance(m[2]);
    if (bal === -2) return;
    if (bal > -1) {
      const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + bal;
      m[2] = m[2].substring(0, bal);
      m[0] = m[0].substring(0, cut).trim();
      m[3] = '';
    }
  }
  const rawEnd = stripTail(m[0].slice(0, -1), '\\');
  if ((m[0].length - rawEnd.length) % 2 === 0) return;
  const title = m[3] ? m[3].slice(1, -1) : '';
  let href = m[2].trim();
  if (RE_START_ANGLE.test(href)) href = href.slice(1, -1);
  return makeLink(m,
    { href: href && href.replace(RE_INLINE.anyPunctuation, '$1'),
      title: title && title.replace(RE_INLINE.anyPunctuation, '$1') },
    m[0], ctx);
}

function tokReflink(src, ctx) {
  const m = RE_INLINE.reflink.exec(src) || RE_INLINE.nolink.exec(src);
  if (!m) return;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (hasTagBeyond(src, m[1], bang)) return;
  const ref = ctx.links[normalizeLabel(m[2] || m[1])];
  if (!ref) {
    const ch = m[0].charAt(0);
    return { type: 'text', raw: ch, text: ch };
  }
  return makeLink(m, ref, m[0], ctx);
}

// Where the last possible emphasis/delimiter closer sits in a masked
// source, so the search for a closer can stop early. Same result as
// scanning the whole string: the start of the last run of each delimiter
// that is preceded by a non-whitespace character.
function emInfo(masked) {
  const em = { '*': -1, '_': -1 };
  let del = -1;
  for (const d of ['*', '_', '~']) {
    let i = masked.lastIndexOf(d);
    while (i >= 0) {
      let s = i;
      while (s > 0 && masked[s - 1] === d) s--;
      const before = s === 0 ? '\n' : masked[s - 1];
      if (before !== ' ' && before !== '\t' && before !== '\n' && before !== '\r' && before !== '\f') {
        if (d === '~') del = s;
        else em[d] = s;
        break;
      }
      if (s === 0) break;
      i = masked.lastIndexOf(d, s - 1);
    }
  }
  return { em, del };
}

function tokEmStrong(src, masked, prevChar, info, ctx) {
  const m = RE_INLINE.emStrongLDelim.exec(src);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return;
  const delim = m[0][0];
  const sameAsPrev = prevChar === delim;
  const offset = masked.length - src.length;
  let runStart = offset;
  while (runStart > 0 && masked[runStart - 1] === delim) runStart--;
  const beforeRun = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const beforeIsPunctish = beforeRun === '*' || beforeRun === '_' || !!RE_INLINE.punctuation.exec(beforeRun);
  if (runStart < offset) prevChar = beforeRun;
  const prevIsPunct = runStart < offset ? beforeIsPunctish : !!RE_INLINE.punctuation.exec(prevChar);
  if (m[4] && RE_UNICODE_ALNUM.test(prevChar)) return;
  const followedByPunct = m[1] || m[3] || '';
  if (!followedByPunct || !prevChar || prevIsPunct) {
    const runLen = [...m[0]].length - 1;
    let need = runLen;
    let extra = 0;
    const totalRun = offset - runStart + runLen;
    const canOpenMid = !!beforeRun.trim() && (!!followedByPunct || (delim === '*' && !beforeIsPunctish));
    if (delim !== '*' && delim !== '_') return;
    const rdelim = delim === '*' ? RE_INLINE.emStrongRDelimAst : RE_INLINE.emStrongRDelimUnd;
    const lastCloser = info.em[delim];
    const q = offset + runLen;
    if (lastCloser < q) return;
    const rest = masked.slice(-src.length + runLen);
    const limit = lastCloser - q;
    rdelim.lastIndex = 0;
    let match;
    while ((match = rdelim.exec(rest)) !== null && !(match.index > limit)) {
      const g = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!g) continue;
      const b = [...g].length;
      if (match[3] || match[4]) { need += b; continue; }
      else if (match[5] || match[6] || canOpenMid) {
        if (sameAsPrev && (match[5] || match[6])) break;
        if (totalRun % 3 && !((totalRun + b) % 3)) { extra += b; continue; }
      }
      need -= b;
      if (need > 0) continue;
      const used = Math.min(b, b + need + extra);
      const firstLen = [...match[0]][0].length;
      const raw = src.slice(0, runLen + match.index + firstLen + used);
      if (Math.min(runLen, used) % 2) {
        const inner = raw.slice(1, -1);
        return { type: 'em', raw, text: inner, tokens: inlineTokens(inner, ctx) };
      }
      const inner = raw.slice(2, -2);
      return { type: 'strong', raw, text: inner, tokens: inlineTokens(inner, ctx) };
    }
  }
}

function tokCodespan(src) {
  const m = RE_INLINE.code.exec(src);
  if (m) {
    let text = m[2].replace(/\n/g, ' ');
    if (/[^ ]/.test(text) && /^ /.test(text) && / $/.test(text)) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: m[0], text };
  }
}

function tokBr(src) {
  const m = RE_INLINE.br.exec(src);
  if (m) return { type: 'br', raw: m[0] };
}

function tokDel(src, masked, prevChar, info, ctx) {
  const m = RE_INLINE.delLDelim.exec(src);
  if (!m) return;
  if (!(m[1] || '') || !prevChar || RE_INLINE.punctuation.exec(prevChar)) {
    const runLen = [...m[0]].length - 1;
    let need = runLen;
    const rdelim = RE_INLINE.delRDelim;
    const lastCloser = info.del;
    const d = masked.length - src.length + runLen;
    if (lastCloser < d) return;
    const rest = masked.slice(-src.length + runLen);
    const limit = lastCloser - d;
    rdelim.lastIndex = 0;
    let match;
    while ((match = rdelim.exec(rest)) !== null && !(match.index > limit)) {
      const g = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!g) continue;
      let l = [...g].length;
      if (l !== runLen) continue;
      if (match[3] || match[4]) { need += l; continue; }
      need -= l;
      if (need > 0) continue;
      l = Math.min(l, l + need);
      const firstLen = [...match[0]][0].length;
      const raw = src.slice(0, runLen + match.index + firstLen + l);
      const inner = raw.slice(runLen, -runLen);
      return { type: 'del', raw, text: inner, tokens: inlineTokens(inner, ctx) };
    }
  }
}

function tokAutolink(src) {
  const m = RE_INLINE.autolink.exec(src);
  if (m) {
    const href = m[2] === '@' ? 'mailto:' + m[1] : m[1];
    return { type: 'link', raw: m[0], text: m[1], href, autolink: true, tokens: [{ type: 'text', raw: m[1], text: m[1] }] };
  }
}

function tokUrl(src) {
  const m = RE_INLINE.url.exec(src);
  if (m) {
    let text;
    let href;
    if (m[2] === '@') {
      text = m[0];
      href = 'mailto:' + text;
    } else {
      let prev;
      text = m[0];
      do {
        prev = text;
        text = RE_INLINE._backpedal.exec(text)?.[0] ?? '';
      } while (prev !== text);
      href = m[1] === 'www.' ? 'http://' + text : text;
    }
    return { type: 'link', raw: text, text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }
}

function tokInlineText(src, ctx) {
  const m = RE_INLINE.text.exec(src);
  if (m) {
    const inRaw = ctx.inRawBlock;
    return { type: 'text', raw: m[0], text: inRaw ? m[0] : unescapeEntities(m[0]), escaped: inRaw };
  }
}

// Does this text contain a link (used while masking reference links)?
function linkInText(src, ctx) {
  if (!src.includes('[')) return false;
  for (const m of src.matchAll(RE_INLINE.blockSkip)) {
    if (RE_INLINE.link.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of src.matchAll(RE_INLINE.reflinkSearch)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(ctx.links, normalizeLabel(s.slice(r + 1, -1)))) &&
        !(r > 1 && linkInText(s.slice(1, r - 1), ctx))) return true;
  }
  return false;
}

// Mask a source for emphasis scanning: reference links, code spans and
// tags are blanked out (length preserved) so their delimiters are ignored.
function maskInline(src, ctx) {
  let out = src;
  if (src.includes('[')) {
    const search = RE_INLINE.reflinkSearch;
    const maskRef = (match) => {
      const o = match.lastIndexOf('[');
      if (!Object.hasOwn(ctx.links, normalizeLabel(match.slice(o + 1, -1)))) return match;
      if (o > 1 && match.charAt(0) !== '!') {
        const label = match.slice(1, o - 1);
        if (linkInText(label, ctx)) return '[' + label.replace(search, maskRef) + '][' + 'a'.repeat(match.length - o - 2) + ']';
      }
      return '[' + 'a'.repeat(match.length - 2) + ']';
    };
    out = out.replace(search, maskRef);
  }
  if (src.includes('`') || src.includes('\\')) {
    out = out.replace(RE_INLINE.anyPunctuationOutsideCode, (match, codeRun, punct) =>
      punct ? '+'.repeat(match.length) :
      codeRun ? codeRun + match.slice(codeRun.length, -codeRun.length).replace(/`/g, '+') + codeRun : match);
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    out = out.replace(RE_INLINE.blockSkip, (match) => '[' + 'a'.repeat(match.length - 2) + ']');
  }
  return out;
}

// emInfo's result for a source with no *, _, or ~ delimiters: no closer
// can exist, and the emphasis/deletion tokenizers are never invoked, so
// this constant is a safe stand-in that skips three full lastIndexOf scans.
const EM_INFO_EMPTY = { em: { '*': -1, '_': -1 }, del: -1 };

function inlineTokens(src, ctx) {
  const saved = ctx.linkParenPossible;
  ctx.linkParenPossible = saved && src.includes(')');
  try {
    const hasDelim = src.includes('*') || src.includes('_') || src.includes('~');
    const needsMask = hasDelim &&
      (src.includes('[') || src.includes('`') || src.includes('<') || src.includes('\\'));
    const masked = needsMask ? maskInline(src, ctx) : src;
    return inlineTokensInner(src, masked, hasDelim ? emInfo(masked) : EM_INFO_EMPTY, ctx);
  } finally {
    ctx.linkParenPossible = saved;
  }
}

// Where plain text must stop: the next construct starter, hard break, or
// bare URL. One scan replaces the lazy text regex. Emails are NOT in this
// regex: the email alternative backtracked at every letter position, so the
// '@' position is tracked by the caller instead (see textRun).
const RE_TEXT_STOP = /[\\<\[`*!~_]| {2,}\n|[hH][tT][tT][pP][sS]?|[fF][tT][tT][pP]:|(?<![^\s*_~(])www\.|(?<![A-Za-z0-9])(?:mailto:|xmpp:)/g;

const isEmailLocal = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 43 || c === 45;
const isDomainChar = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95;
const isAlnum = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

// Is the domain after src[at] === '@' a valid email domain per FRAG_EMAIL:
// [a-zA-Z0-9-_]+ (?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+ (?![\w-]). Each dot-group
// is greedy and backtracks past trailing -/_ to its last alnum; when a
// group cannot match at all (no alnum after the dot) the + loop simply
// ends and the lookahead is checked at the dot.
function emailDomainOk(src, at) {
  let i = at + 1;
  const n = src.length;
  let j = i;
  while (j < n && isDomainChar(src.charCodeAt(j))) j++;
  if (j === i) return false;
  i = j;
  let groups = 0;
  while (i < n && src.charCodeAt(i) === 46) {
    let k = i + 1;
    while (k < n && isDomainChar(src.charCodeAt(k))) k++;
    let e = k - 1;
    while (e > i && !isAlnum(src.charCodeAt(e))) e--;
    if (e === i) break;
    groups++;
    i = e + 1;
  }
  if (groups === 0) return false;
  if (i < n) {
    const c = src.charCodeAt(i);
    if (isAlnum(c) || c === 95 || c === 45) return false;
  }
  return true;
}

// Consume the plain-text run at the start of src (at least one char; the
// construct at position 0 already failed). A leading backtick or tilde run
// is consumed whole, as in marked's text rule. kind tells the caller what
// the run stopped at: 'email' | 'url' | 'other' | 'end'. atPos is the index
// of the next '@' in src (-1 if none); canUrl is whether the caller will
// try tokUrl after an email/url stop (false inside a link, where the email
// is plain text instead).
function textRun(src, atPos, canUrl) {
  let start = 1;
  const c0 = src.charCodeAt(0);
  if (c0 === 96 || c0 === 126) {
    while (start < src.length && src.charCodeAt(start) === c0) start++;
  }
  RE_TEXT_STOP.lastIndex = start;
  const m = RE_TEXT_STOP.exec(src);
  const stopIdx = m ? m.index : src.length;
  let kind = 'other';
  if (m) {
    const low = m[0].toLowerCase();
    kind = (low === 'http' || low === 'https' || low === 'ftp:' || low === 'www.' || low === 'mailto:' || low === 'xmpp:') ? 'url' : 'other';
  } else {
    kind = 'end';
  }
  // A bare email before the regex stop ends the run at its local start.
  while (atPos !== -1 && atPos < stopIdx) {
    let ls = atPos;
    while (ls > 0 && isEmailLocal(src.charCodeAt(ls - 1))) ls--;
    if (ls < atPos && emailDomainOk(src, atPos)) {
      if (ls > 0 || canUrl) return { text: src.slice(0, ls), kind: 'email' };
      // The email starts at 0 but cannot be linkified here: it is plain
      // text, so keep scanning for a later email that can stop the run.
    }
    atPos = src.indexOf('@', atPos + 1);
  }
  return { text: src.slice(0, stopIdx), kind };
}

// Could a bare email address start at src[0]? Bounded scan for '@'
// over email-local characters only.
function emailAhead(src) {
  for (let i = 0; i < src.length && i < 64; i++) {
    const ch = src.charCodeAt(i);
    if (ch === 64) return true;
    if (!((ch >= 48 && ch <= 57) || (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 46 || ch === 95 || ch === 43 || ch === 45)) return false;
  }
  return false;
}

function inlineTokensInner(src, masked, info, ctx) {
  const tokens = [];
  let wasText = false;
  let prevChar = '';
  // Index of the next '@' in src, for textRun's email check. Kept in sync
  // as src is consumed; -1 means no '@' remains, and a suffix of a string
  // without '@' cannot gain one, so it stays -1.
  let atPos = src.indexOf('@');
  const advance = (n) => {
    if (atPos === -1) return;
    atPos -= n;
    if (atPos < 0) atPos = src.indexOf('@');
  };
  let guard = Infinity;
  while (src) {
    if (src.length < guard) guard = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    if (!wasText) prevChar = '';
    wasText = false;
    const c = src.charCodeAt(0);
    let tok;
    if (c === 92) tok = tokEscape(src) || tokBr(src);
    else if (c === 60) tok = tokTag(src, ctx) || tokAutolink(src);
    else if (c === 91 || c === 33) tok = tokLink(src, ctx) || tokReflink(src, ctx);
    else if (c === 42 || c === 95) tok = tokEmStrong(src, masked, prevChar, info, ctx);
    else if (c === 96) tok = tokCodespan(src);
    else if (c === 126) tok = tokDel(src, masked, prevChar, info, ctx);
    else if (c === 32) tok = tokBr(src);
    else if (c === 104 || c === 102 || c === 119 || c === 109 || c === 120 || c === 72 || c === 70) tok = !ctx.inLink ? tokUrl(src) : null;
    else if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) tok = (!ctx.inLink && emailAhead(src)) ? tokUrl(src) : null;
    if (tok) {
      src = src.slice(tok.raw.length);
      advance(tok.raw.length);
      if (tok.type === 'text') {
        const last = tokens.at(-1);
        if (last?.type === 'text') { last.raw += tok.raw; last.text += tok.text; }
        else tokens.push(tok);
      } else tokens.push(tok);
      continue;
    }
    const run = textRun(src, atPos, !ctx.inLink);
    const raw = run.text;
    const inRaw = ctx.inRawBlock;
    const text = inRaw ? raw : unescapeEntities(raw);
    src = src.slice(raw.length);
    advance(raw.length);
    if (raw.slice(-1) !== '_') prevChar = raw.slice(-1);
    wasText = true;
    const last = tokens.at(-1);
    if (last?.type === 'text') { last.raw += raw; last.text += text; }
    else tokens.push({ type: 'text', raw, text, escaped: inRaw });
    if ((run.kind === 'email' || run.kind === 'url') && !ctx.inLink) {
      const u = tokUrl(src);
      if (u) {
        src = src.slice(u.raw.length);
        advance(u.raw.length);
        tokens.push(u);
        wasText = false;
      }
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTableCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const open = cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`;
  return open + renderInline(cell.tokens) + `</${tag}>\n`;
}

function renderBlocks(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space': break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading': out += `<h${tok.depth}>${renderInline(tok.tokens)}</h${tok.depth}>\n`; break;
      case 'code': {
        const lang = (tok.lang || '').match(/^\S*/)?.[0];
        const text = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
        const body = esc(text, true);
        out += lang
          ? `<pre><code class="language-${esc(lang)}">${body}</code></pre>\n`
          : `<pre><code>${body}</code></pre>\n`;
        break;
      }
      case 'table': {
        let head = '';
        for (const cell of tok.header) head += renderTableCell(cell);
        let body = '';
        for (const row of tok.rows) {
          let cells = '';
          for (const cell of row) cells += renderTableCell(cell);
          body += `<tr>\n${cells}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out += `<table>\n<thead>\n<tr>\n${head}</tr>\n</thead>\n${body}</table>\n`;
        break;
      }
      case 'blockquote': out += `<blockquote>\n${renderBlocks(tok.tokens)}</blockquote>\n`; break;
      case 'list': {
        const tag = tok.ordered ? 'ol' : 'ul';
        const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
        let items = '';
        for (const item of tok.items) items += `<li>${renderBlocks(item.tokens)}</li>\n`;
        out += `<${tag}${start}>\n${items}</${tag}>\n`;
        break;
      }
      case 'checkbox': out += `<input ${tok.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `; break;
      case 'html': out += tok.text; break;
      case 'def': break;
      case 'paragraph': out += `<p>${renderInline(tok.tokens)}</p>\n`; break;
      case 'text': out += renderInline(tok.tokens); break;
      default: throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}

// Render inline tokens. textMode renders plain text (for image alt text):
// no tags, no escaping, links and emphasis dissolve into their text.
function renderInline(tokens, textMode) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'escape': out += textMode ? tok.text : esc(tok.text); break;
      case 'html': out += tok.text; break;
      case 'link': {
        if (textMode) { out += renderInline(tok.tokens, true); break; }
        const inner = tok.autolink ? esc(tok.text, true) : renderInline(tok.tokens);
        const href = cleanUrl(tok.href);
        if (href === null) { out += inner; break; }
        let a = '<a href="' + esc(href, tok.autolink) + '"';
        if (tok.title) a += ' title="' + esc(tok.title) + '"';
        out += a + '>' + inner + '</a>';
        break;
      }
      case 'image': {
        const alt = tok.tokens ? renderInline(tok.tokens, true) : tok.text;
        if (textMode) { out += alt; break; }
        const href = cleanUrl(tok.href);
        if (href === null) { out += esc(alt); break; }
        let img = '<img src="' + esc(href) + '" alt="' + esc(alt) + '"';
        if (tok.title) img += ' title="' + esc(tok.title) + '"';
        out += img + '>';
        break;
      }
      case 'checkbox': out += textMode ? tok.raw : `<input ${tok.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `; break;
      case 'strong': out += textMode ? renderInline(tok.tokens, true) : `<strong>${renderInline(tok.tokens)}</strong>`; break;
      case 'em': out += textMode ? renderInline(tok.tokens, true) : `<em>${renderInline(tok.tokens)}</em>`; break;
      case 'codespan': out += textMode ? tok.text : `<code>${esc(tok.text, true)}</code>`; break;
      case 'br': out += textMode ? '' : '<br>'; break;
      case 'del': out += textMode ? renderInline(tok.tokens, true) : `<del>${renderInline(tok.tokens)}</del>`; break;
      case 'text': out += textMode ? tok.text : (tok.escaped ? tok.text : esc(tok.text)); break;
      default: throw new Error('Token with "' + tok.type + '" type was not found.');
    }
  }
  return out;
}
