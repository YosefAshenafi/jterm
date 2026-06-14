const MAX_HIGHLIGHT = 100_000;

interface LangSpec {
  line?: string;
  block?: [string, string];
  rawStrings?: string[];
  strings: string;
  keywords?: Set<string>;
  caps?: boolean;
}

const kw = (s: string) => new Set(s.trim().split(/\s+/));

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

  const never = "(?!x)x";
  const source =
    "(" + URL_SRC + ")" +
    "|(" + (comment.length ? comment.join("|") : never) + ")" +
    "|(" + (strings.length ? strings.join("|") : never) + ")" +
    "|(0[xX][0-9a-fA-F]+|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)" +
    "|([A-Za-z_$][\\w$]*)";

  const re = new RegExp(source, "g");
  regexCache.set(key, re);
  return re;
}

const URL_SRC = "https?:\\/\\/[^\\s\"'`<>)\\]}]+";

function highlightUrlsOnly(code: string): string {
  const re = new RegExp(URL_SRC, "gi");
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    if (m.index > last) out += htmlEscape(code.slice(last, m.index));
    out += `<span class="tok-link">${htmlEscape(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  out += htmlEscape(code.slice(last));
  return out + "\n";
}

/** Highlight `code` to an HTML string of <span class="tok-…"> tokens. */
export function highlightToHtml(code: string, key: keyof typeof SPECS): string {
  const spec = SPECS[key];
  if (code.length > MAX_HIGHLIGHT) return htmlEscape(code) + "\n";
  if (key === "plain") return highlightUrlsOnly(code);

  const re = tokenizer(key);
  const keywords = spec.keywords;
  let out = "";
  let last = 0;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    if (m.index > last) out += htmlEscape(code.slice(last, m.index));
    const [full, url, comment, str, num, ident] = m;
    if (url !== undefined) out += `<span class="tok-link">${htmlEscape(url)}</span>`;
    else if (comment !== undefined) out += `<span class="tok-comment">${htmlEscape(comment)}</span>`;
    else if (str !== undefined) out += `<span class="tok-string">${htmlEscape(str)}</span>`;
    else if (num !== undefined) out += `<span class="tok-number">${num}</span>`;
    else if (ident !== undefined) {
      if (keywords?.has(ident)) out += `<span class="tok-keyword">${ident}</span>`;
      else if (spec.caps && ident.length > 1 && ident[0] >= "A" && ident[0] <= "Z")
        out += `<span class="tok-type">${ident}</span>`;
      else out += ident;
    }
    last = m.index + full.length;
    if (full.length === 0) re.lastIndex++;
  }
  out += htmlEscape(code.slice(last));
  return out + "\n";
}
