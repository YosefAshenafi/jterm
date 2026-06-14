import { describe, expect, it } from "vitest";
import { findAllOccurrences } from "./textSearch";

describe("findAllOccurrences", () => {
  it("finds non-overlapping, case-insensitive matches", () => {
    expect(findAllOccurrences("Hello World", "o")).toEqual([4, 7]);
    expect(findAllOccurrences("aaaa", "aa")).toEqual([0, 2]);
  });

  it("returns no matches for an empty needle (would otherwise loop forever)", () => {
    expect(findAllOccurrences("anything", "")).toEqual([]);
  });

  it("returns no matches when the needle is absent", () => {
    expect(findAllOccurrences("nothing here", "zzz")).toEqual([]);
  });

  it("honors the result limit", () => {
    expect(findAllOccurrences("ababab", "a", 2)).toEqual([0, 2]);
  });
});
