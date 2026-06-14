// Editor auto-indentation, by file type. Pure helpers so the behaviour is unit
// testable. `language` is a syntax key from languageFromName (e.g. "cstyle",
// "python", "plain"); see ./syntax.

const BRACKET_PAIRS: Record<string, string> = { "{": "}", "[": "]", "(": ")" };

/** Infer the file's indent unit: a tab if any line is tab-indented, else the
 * smallest run of leading spaces seen, else two spaces. */
export function detectIndentUnit(text: string): string {
  let minSpaces = Infinity;
  for (const line of text.split("\n")) {
    if (line[0] === "\t") return "\t";
    const m = /^( +)\S/.exec(line);
    if (m) minSpaces = Math.min(minSpaces, m[1].length);
  }
  return minSpaces === Infinity ? "  " : " ".repeat(minSpaces);
}

/** Whether a line (its text up to the cursor) opens a deeper block in `language`. */
export function opensBlock(language: string, lineBeforeCursor: string): boolean {
  if (language === "plain") return false; // prose/markdown: just keep indentation
  const trimmed = lineBeforeCursor.replace(/\s+$/, "");
  if (/[{([]$/.test(trimmed)) return true;
  if (language === "python" && trimmed.endsWith(":")) return true;
  return false;
}

/** Result of pressing Enter at [selStart, selEnd): the full new text and where
 * the caret should land. Copies the current line's indentation, deepens it one
 * level after a block opener, and splits a matching bracket pair onto its own
 * lines (the editor "{ ⏎ }" expansion). */
export function autoIndentOnEnter(
  language: string,
  value: string,
  selStart: number,
  selEnd: number
): { value: string; caret: number } {
  const lineStart = value.lastIndexOf("\n", selStart - 1) + 1;
  const before = value.slice(lineStart, selStart);
  const indent = /^[ \t]*/.exec(before)![0];
  const unit = detectIndentUnit(value);

  const opener = value[selStart - 1] ?? "";
  const expandPair =
    language !== "plain" &&
    BRACKET_PAIRS[opener] !== undefined &&
    BRACKET_PAIRS[opener] === value[selEnd];

  let insert: string;
  let caret: number;
  if (expandPair) {
    insert = "\n" + indent + unit + "\n" + indent;
    caret = selStart + 1 + indent.length + unit.length;
  } else if (opensBlock(language, before)) {
    insert = "\n" + indent + unit;
    caret = selStart + insert.length;
  } else {
    insert = "\n" + indent;
    caret = selStart + insert.length;
  }

  return { value: value.slice(0, selStart) + insert + value.slice(selEnd), caret };
}
