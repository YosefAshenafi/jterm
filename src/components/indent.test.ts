import { describe, expect, it } from "vitest";
import { autoIndentOnEnter, detectIndentUnit, opensBlock } from "./indent";

describe("detectIndentUnit", () => {
  it("detects tabs", () => {
    expect(detectIndentUnit("foo\n\tbar")).toBe("\t");
  });
  it("detects 2- and 4-space units", () => {
    expect(detectIndentUnit("foo\n  bar")).toBe("  ");
    expect(detectIndentUnit("foo\n    bar")).toBe("    ");
  });
  it("uses the smallest indent seen", () => {
    expect(detectIndentUnit("a\n    deep\n  two")).toBe("  ");
  });
  it("defaults to two spaces when nothing is indented", () => {
    expect(detectIndentUnit("no indent here")).toBe("  ");
  });
});

describe("opensBlock", () => {
  it("treats trailing brackets as block openers in code", () => {
    expect(opensBlock("cstyle", "if (x) {")).toBe(true);
    expect(opensBlock("cstyle", "const a = [")).toBe(true);
    expect(opensBlock("cstyle", "foo(")).toBe(true);
    expect(opensBlock("cstyle", "let a = 1;")).toBe(false);
  });
  it("treats a trailing colon as a block opener only in Python", () => {
    expect(opensBlock("python", "def f():")).toBe(true);
    expect(opensBlock("python", "x = 1")).toBe(false);
    expect(opensBlock("cstyle", "case 1:")).toBe(false);
  });
  it("never deepens plain text / markdown", () => {
    expect(opensBlock("plain", "a list item {")).toBe(false);
  });
});

describe("autoIndentOnEnter", () => {
  it("copies the current line's indentation", () => {
    const r = autoIndentOnEnter("cstyle", "  foo", 5, 5);
    expect(r.value).toBe("  foo\n  ");
    expect(r.caret).toBe(8);
  });

  it("deepens one level after a brace, using the file's unit", () => {
    const src = "function f() {";
    const r = autoIndentOnEnter("cstyle", src, src.length, src.length);
    expect(r.value).toBe("function f() {\n  ");
    expect(r.caret).toBe(src.length + 3);
  });

  it("deepens after a Python colon", () => {
    const r = autoIndentOnEnter("python", "def f():", 8, 8);
    expect(r.value).toBe("def f():\n  ");
  });

  it("splits a matching bracket pair onto its own lines", () => {
    const r = autoIndentOnEnter("cstyle", "  {}", 3, 3);
    expect(r.value).toBe("  {\n    \n  }");
    expect(r.caret).toBe(8);
  });

  it("just keeps indentation in plain text (no bracket magic)", () => {
    expect(autoIndentOnEnter("plain", "  - item", 8, 8).value).toBe("  - item\n  ");
    expect(autoIndentOnEnter("plain", "{}", 1, 1).value).toBe("{\n}");
  });

  it("replaces a selection while indenting from the start line", () => {
    const r = autoIndentOnEnter("cstyle", "  bar", 2, 5);
    expect(r.value).toBe("  \n  ");
  });
});
