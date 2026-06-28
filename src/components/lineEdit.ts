/**
 * VS Code-style whole-line editing for the file editor: cut / copy / delete /
 * paste the caret's line when there is no selection. Pure helpers so the
 * keyboard handler in WorkArea stays thin and the behaviour is unit-testable.
 */

export interface LineEditResult {
  value: string;
  caret: number;
}

/** The [start, end) offsets of the whole lines spanned by [selStart, selEnd],
 * where `end` includes the trailing newline when there is one. With no
 * selection this is just the caret's line. */
export function lineSpan(
  value: string,
  selStart: number,
  selEnd: number
): { start: number; end: number } {
  const start = selStart <= 0 ? 0 : value.lastIndexOf("\n", selStart - 1) + 1;
  // For a real selection, a caret resting at column 0 of the next line should
  // not pull that line in, so probe from the character before selEnd.
  const endRef = selEnd > selStart ? selEnd - 1 : selEnd;
  const nl = value.indexOf("\n", endRef);
  const end = nl === -1 ? value.length : nl + 1;
  return { start, end };
}

/** Clipboard payload for a "copy line": the spanned lines, always
 * newline-terminated so a later line-paste lands as whole lines. */
export function lineCopyText(value: string, selStart: number, selEnd: number): string {
  const { start, end } = lineSpan(value, selStart, selEnd);
  const text = value.slice(start, end);
  return text.endsWith("\n") ? text : text + "\n";
}

/** Remove the lines spanned by [selStart, selEnd] ("cut line" / "delete line").
 * When the final line (which has no trailing newline) is removed, the newline
 * before it goes too so no blank line is left behind. The caret keeps its
 * column on the line that shifts up into place. */
export function deleteLines(value: string, selStart: number, selEnd: number): LineEditResult {
  const { start, end } = lineSpan(value, selStart, selEnd);
  let delStart = start;
  const delEnd = end;
  if (delEnd === value.length && value[delEnd - 1] !== "\n" && delStart > 0) {
    delStart -= 1;
  }
  const next = value.slice(0, delStart) + value.slice(delEnd);
  const col = selStart - start;
  const lineEnd = next.indexOf("\n", delStart);
  const lineLen = (lineEnd === -1 ? next.length : lineEnd) - delStart;
  const caret = delStart + Math.min(Math.max(0, col), Math.max(0, lineLen));
  return { value: next, caret };
}

/** Insert a whole-line clipboard payload above the caret's line (VS Code
 * line-paste). The caret's own line is pushed down and the caret rides with it,
 * keeping its column. */
export function pasteLineAbove(value: string, caretPos: number, payload: string): LineEditResult {
  const { start } = lineSpan(value, caretPos, caretPos);
  const text = payload.endsWith("\n") ? payload : payload + "\n";
  const next = value.slice(0, start) + text + value.slice(start);
  return { value: next, caret: caretPos + text.length };
}
