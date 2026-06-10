import { describe, expect, it } from "vitest";
import { isValidElement } from "react";
import { highlight } from "./highlight";

/** Flatten highlight() output into plain strings + marked strings. */
function parts(node: ReturnType<typeof highlight>) {
  if (typeof node === "string") return [{ text: node, marked: false }];
  return (node as React.ReactNode[]).map((n) =>
    isValidElement(n)
      ? { text: (n.props as { children: string }).children, marked: true }
      : { text: String(n), marked: false }
  );
}

describe("highlight", () => {
  it("returns the text untouched for an empty query (regression: the empty-string indexOf loop froze the app when deleting the last character)", () => {
    expect(highlight("some result line", "")).toBe("some result line");
  });

  it("marks case-insensitive occurrences", () => {
    expect(parts(highlight("Hello World", "o"))).toEqual([
      { text: "Hell", marked: false },
      { text: "o", marked: true },
      { text: " W", marked: false },
      { text: "o", marked: true },
      { text: "rld", marked: false },
    ]);
  });

  it("marks a hit at the start and preserves the original casing", () => {
    expect(parts(highlight("Foo bar", "foo"))).toEqual([
      { text: "Foo", marked: true },
      { text: " bar", marked: false },
    ]);
  });

  it("leaves text without hits as a single unmarked chunk", () => {
    expect(parts(highlight("nothing here", "zzz"))).toEqual([
      { text: "nothing here", marked: false },
    ]);
  });
});
