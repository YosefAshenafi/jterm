// Dependency-free syntax highlighting for the file editor.
//
// Performance first: a single regex tokenizes the whole buffer in one linear
// pass and we emit an HTML *string* (applied with one innerHTML write) instead
// of thousands of React nodes — so there is no per-token reconciliation on every
// keystroke. Above a size cap we skip tokenizing entirely and just escape the
// text, guaranteeing huge files never add typing latency.

const MAX_HIGHLIGHT = 100_000; // chars; above this we render plain (still fast)

interface LangSpec {
  line?: string; // line-comment marker, e.g. "//" or "#"
  block?: [string, string]; // block-comment delimiters, e.g. ["/*", "*/"]
  rawStrings?: string[]; // extra string regex sources (e.g. python triple quotes)
  strings: string; // single-char string delimiters, e.g. "\"'`"
  keywords?: Set<string>; // identifiers to color as keywords
  caps?: boolean; // color Capitalized identifiers as types
}

const kw = (s: string) => new Set(s.trim().split(/\s+/));

// One broad union across the common code languages. A few cross-language false
// positives (e.g. `def` would never appear in JS anyway) are an acceptable trade
// for covering many languages with one fast table in a lightweight viewer.
const CODE_KEYWORDS = kw(`
  abstract alias and as asserts async await become box break case catch chan class const
  constructor continue crate debugger declare def default defer del delete dis do done dyn
  elif else end enum esac except export extends extern false fi final finally fn for from fun
  func function get global go goto guard if impl implements import in infer instanceof int
  interface is keyof lambda let loop match mod module move mut namespace new nil none nonlocal
  not null object of operator or out override package pass private protected pub public raise
  readonly rec ref register return sealed select self Self set sizeof static struct super
  switch symbol synchronized template then this throw throws trait true try type typedef
  typeof undefined union unique unknown unless unsafe until use using val var virtual void
  volatile when where while with yield
`);

const SQL_KEYWORDS = kw(`
  select from where insert into update delete create table drop alter add column values set
  join inner left right outer on group by order having limit offset union all as distinct
  and or not null is in like between exists count sum avg min max primary key foreign references
  default index unique view trigger procedure function begin commit rollback case when then else end
`);

const SPECS: Record<string, LangSpec> = {
  cstyle: { line: "//", block: ["/*", "*/"], strings: "\"'`", keywords: CODE_KEYWORDS, caps: true },
  python: { line: "#", rawStrings: ['"""[\\s\\S]*?"""', "'''[\\s\\S]*?'''"], strings: "\"'", keywords: CODE_KEYWORDS, caps: true },
  shell: { line: "#", strings: "\"'`", keywords: CODE_KEYWORDS },
  ruby: { line: "#", strings: "\"'`", keywords: CODE_KEYWORDS, caps: true },
  css: { block: ["/*", "*/"], strings: "\"'" },
  json: { strings: '"', keywords: kw("true false null") },
  markup: { block: ["<!--", "-->"], strings: "\"'" },
  sql: { line: "--", block: ["/*", "*/"], strings: "'\"", keywords: SQL_KEYWORDS },
  conf: { line: "#", strings: "\"'" },
  plain: { strings: "" },
};

const EXT: Record<string, keyof typeof SPECS> = {
  js: "cstyle", jsx: "cstyle", mjs: "cstyle", cjs: "cstyle",
  ts: "cstyle", tsx: "cstyle", mts: "cstyle", cts: "cstyle",
  java: "cstyle", c: "cstyle", h: "cstyle", cpp: "cstyle", cc: "cstyle", cxx: "cstyle",
  hpp: "cstyle", hh: "cstyle", cs: "cstyle", go: "cstyle", rs: "cstyle", swift: "cstyle",
  kt: "cstyle", kts: "cstyle", php: "cstyle", dart: "cstyle", scala: "cstyle", zig: "cstyle",
  py: "python", pyw: "python",
  rb: "ruby",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
  css: "css", scss: "css", sass: "css", less: "css",
  json: "json", json5: "json",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup", svelte: "markup",
  sql: "sql",
  yml: "conf", yaml: "conf", toml: "conf", ini: "conf", conf: "conf", env: "conf",
  md: "plain", markdown: "plain", txt: "plain", log: "plain",
};

const FILENAMES: Record<string, keyof typeof SPECS> = {
  dockerfile: "shell",
  makefile: "shell",
  ".env": "conf",
  ".gitignore": "conf",
  ".bashrc": "shell",
  ".zshrc": "shell",
};

/** Pick a language spec key from a file name (extension, with a few specials). */
export function languageFromName(name: string): keyof typeof SPECS {
  const base = name.toLowerCase();
  if (FILENAMES[base]) return FILENAMES[base];
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1) : "";
  return EXT[ext] ?? "plain";
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function htmlEscape(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

// Compiled regex is cached per language — building it is the only non-trivial
// setup cost and it never changes for a given language.
const regexCache = new Map<string, RegExp>();

function tokenizer(key: keyof typeof SPECS): RegExp {
  const cached = regexCache.get(key);
  if (cached) return cached;
  const spec = SPECS[key];

  const comment: string[] = [];
  if (spec.block) comment.push(escapeRe(spec.block[0]) + "[\\s\\S]*?" + escapeRe(spec.block[1]));
  if (spec.line) comment.push(escapeRe(spec.line) + "[^\\n]*");

  const strings: string[] = [...(spec.rawStrings ?? [])];
  for (const d of spec.strings) {
    if (d === "`") strings.push("`(?:\\\\.|[^`\\\\])*`?");
    else strings.push(d + "(?:\\\\.|[^" + d + "\\\\\\n])*" + d + "?");
  }

  const never = "(?!x)x"; // matches nothing, keeps group numbering stable
  const source =
    "(" + (comment.length ? comment.join("|") : never) + ")" + // 1: comment
    "|(" + (strings.length ? strings.join("|") : never) + ")" + // 2: string
    "|(0[xX][0-9a-fA-F]+|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)" + // 3: number
    "|([A-Za-z_$][\\w$]*)"; // 4: identifier

  const re = new RegExp(source, "g");
  regexCache.set(key, re);
  return re;
}

/** Highlight `code` to an HTML string of <span class="tok-…"> tokens. */
export function highlightToHtml(code: string, key: keyof typeof SPECS): string {
  const spec = SPECS[key];
  if (key === "plain" || code.length > MAX_HIGHLIGHT) return htmlEscape(code) + "\n";

  const re = tokenizer(key);
  const keywords = spec.keywords;
  let out = "";
  let last = 0;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    if (m.index > last) out += htmlEscape(code.slice(last, m.index));
    const [full, comment, str, num, ident] = m;
    if (comment !== undefined) out += `<span class="tok-comment">${htmlEscape(comment)}</span>`;
    else if (str !== undefined) out += `<span class="tok-string">${htmlEscape(str)}</span>`;
    else if (num !== undefined) out += `<span class="tok-number">${num}</span>`;
    else if (ident !== undefined) {
      if (keywords?.has(ident)) out += `<span class="tok-keyword">${ident}</span>`;
      else if (spec.caps && ident.length > 1 && ident[0] >= "A" && ident[0] <= "Z")
        out += `<span class="tok-type">${ident}</span>`;
      else out += ident;
    }
    last = m.index + full.length;
    if (full.length === 0) re.lastIndex++; // guard against a zero-width match
  }
  out += htmlEscape(code.slice(last));
  return out + "\n"; // trailing line so the pre's height tracks the textarea
}
