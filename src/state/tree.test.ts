import { describe, expect, it } from "vitest";
import {
  collectLeaves,
  firstLeaf,
  leafOrder,
  makeLeaf,
  removePane,
  setSplitSizes,
  splitPane,
} from "./tree";
import { PaneNode, SplitNode } from "./types";

describe("splitPane", () => {
  it("replaces the target leaf with a split holding it and a new sibling", () => {
    const leaf = makeLeaf();
    const { root, newLeafId } = splitPane(leaf, leaf.id, "row");

    expect(root.type).toBe("split");
    const split = root as SplitNode;
    expect(split.direction).toBe("row");
    expect(split.sizes).toEqual([0.5, 0.5]);
    expect(split.children[0]).toBe(leaf);
    expect(split.children[1].id).toBe(newLeafId);
  });

  it("splits a nested leaf without touching the rest of the tree", () => {
    const a = makeLeaf();
    const { root: r1, newLeafId: b } = splitPane(a, a.id, "row");
    const { root: r2, newLeafId: c } = splitPane(r1, b, "column");

    expect(leafOrder(r2)).toEqual([a.id, b, c]);
    // The original sibling subtree is reused untouched.
    expect((r2 as SplitNode).children[0]).toBe(a);
  });

  it("returns the tree unchanged when the target id does not exist", () => {
    const leaf = makeLeaf();
    const { root } = splitPane(leaf, "nope", "row");
    expect(root).toBe(leaf);
  });
});

describe("removePane", () => {
  it("collapses a split into its surviving child", () => {
    const a = makeLeaf();
    const { root, newLeafId: b } = splitPane(a, a.id, "row");
    const collapsed = removePane(root, b);
    expect(collapsed).toBe(a);
  });

  it("returns null when the last leaf is removed", () => {
    const a = makeLeaf();
    expect(removePane(a, a.id)).toBeNull();
  });

  it("collapses only the affected split in a nested tree", () => {
    const a = makeLeaf();
    const { root: r1, newLeafId: b } = splitPane(a, a.id, "row");
    const { root: r2, newLeafId: c } = splitPane(r1, b, "column");

    const after = removePane(r2, c)!;
    expect(leafOrder(after)).toEqual([a.id, b]);
    expect((after as SplitNode).direction).toBe("row");
  });
});

describe("setSplitSizes", () => {
  it("updates only the addressed split", () => {
    const a = makeLeaf();
    const { root } = splitPane(a, a.id, "row");
    const split = root as SplitNode;

    const resized = setSplitSizes(root, split.id, [0.3, 0.7]) as SplitNode;
    expect(resized.sizes).toEqual([0.3, 0.7]);
    // Immutability: the original node is not mutated.
    expect(split.sizes).toEqual([0.5, 0.5]);
  });
});

describe("traversal helpers", () => {
  it("firstLeaf finds the top-left-most leaf and collectLeaves orders left-to-right", () => {
    const a = makeLeaf();
    const { root: r1, newLeafId: b } = splitPane(a, a.id, "row");
    const { root: r2, newLeafId: c } = splitPane(r1, a.id, "column");

    expect(firstLeaf(r2).id).toBe(a.id);
    expect(collectLeaves(r2).map((l) => l.id)).toEqual([a.id, c, b]);
  });

  it("leafOrder of a lone leaf is itself", () => {
    const a: PaneNode = makeLeaf();
    expect(leafOrder(a)).toEqual([a.id]);
  });
});
