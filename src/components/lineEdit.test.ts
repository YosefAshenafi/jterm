import { describe, expect, it } from "vitest";
import { lineSpan, lineCopyText, deleteLines, pasteLineAbove } from "./lineEdit";

const DOC = "alpha\nbeta\ngamma";
// offsets:    0-4    6-9   11-15  (newlines at 5 and 10; length 16)

describe("lineSpan", () => {
  it("spans the caret's line including its trailing newline", () => {
    // caret inside "beta"
    expect(lineSpan(DOC, 7, 7)).toEqual({ start: 6, end: 11 });
  });

  it("spans the first line from offset 0", () => {
    expect(lineSpan(DOC, 2, 2)).toEqual({ start: 0, end: 6 });
  });

  it("spans the last line to end-of-text when there is no trailing newline", () => {
    expect(lineSpan(DOC, 13, 13)).toEqual({ start: 11, end: 16 });
  });

  it("covers every line a multi-line selection touches", () => {
    // from inside "alpha" to inside "gamma"
    expect(lineSpan(DOC, 2, 13)).toEqual({ start: 0, end: 16 });
  });

  it("does not pull in the next line when a selection ends at its column 0", () => {
    // select all of "alpha\n", caret resting at start of "beta"
    expect(lineSpan(DOC, 0, 6)).toEqual({ start: 0, end: 6 });
  });
});

describe("lineCopyText", () => {
  it("copies the caret line with its newline", () => {
    expect(lineCopyText(DOC, 7, 7)).toBe("beta\n");
  });

  it("newline-terminates the last line even without one in the buffer", () => {
    expect(lineCopyText(DOC, 13, 13)).toBe("gamma\n");
  });
});

describe("deleteLines", () => {
  it("removes a middle line and keeps the caret column on the line below", () => {
    // caret at column 1 of "beta" (offset 7)
    expect(deleteLines(DOC, 7, 7)).toEqual({ value: "alpha\ngamma", caret: 7 });
  });

  it("removes the first line", () => {
    expect(deleteLines(DOC, 2, 2)).toEqual({ value: "beta\ngamma", caret: 2 });
  });

  it("removes the last line and the newline before it, no blank line left", () => {
    const r = deleteLines(DOC, 13, 13);
    expect(r.value).toBe("alpha\nbeta");
    expect(r.caret).toBe(10); // end of "beta"
  });

  it("clamps the kept column to the new line's length", () => {
    // caret at end of "gamma" (col 5) — previous line "beta" is shorter
    const r = deleteLines(DOC, 15, 15);
    expect(r.value).toBe("alpha\nbeta");
    expect(r.caret).toBe(10);
  });

  it("removes every line spanned by a selection", () => {
    // selection runs from column 2 of "alpha" into "beta"; both lines go and
    // the caret keeps column 2 on the line that shifts up.
    expect(deleteLines(DOC, 2, 7)).toEqual({ value: "gamma", caret: 2 });
  });
});

describe("pasteLineAbove", () => {
  it("inserts the payload as a whole line above the caret's line", () => {
    // caret inside "beta" at offset 7
    const r = pasteLineAbove(DOC, 7, "new\n");
    expect(r.value).toBe("alpha\nnew\nbeta\ngamma");
    expect(r.caret).toBe(11); // caret rode down with "beta", same column
  });

  it("newline-terminates a payload that lacks one", () => {
    const r = pasteLineAbove(DOC, 7, "new");
    expect(r.value).toBe("alpha\nnew\nbeta\ngamma");
  });

  it("can paste above the first line", () => {
    const r = pasteLineAbove(DOC, 2, "new\n");
    expect(r.value).toBe("new\nalpha\nbeta\ngamma");
  });
});
