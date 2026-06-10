// Pure operations over the pane tree. Every function returns a new tree so the
// reducer stays immutable and React re-renders predictably.

import { Direction, LeafNode, PaneNode, SplitNode } from "./types";

let counter = 0;
export const newId = (prefix: string): string => `${prefix}-${++counter}`;

export const makeLeaf = (): LeafNode => ({ type: "leaf", id: newId("pane") });

/** The first (top-left-most) leaf under a node. */
export function firstLeaf(node: PaneNode): LeafNode {
  return node.type === "leaf" ? node : firstLeaf(node.children[0]);
}

/** All leaves under a node, left-to-right. */
export function collectLeaves(node: PaneNode): LeafNode[] {
  if (node.type === "leaf") return [node];
  return [...collectLeaves(node.children[0]), ...collectLeaves(node.children[1])];
}

/** Split `targetId` into itself + a sibling leaf. Callers that need the new
 * pane's id before dispatching (e.g. to pre-assign its working directory) can
 * pass a pre-made leaf. */
export function splitPane(
  root: PaneNode,
  targetId: string,
  direction: Direction,
  newLeaf: LeafNode = makeLeaf()
): { root: PaneNode; newLeafId: string } {

  const rec = (node: PaneNode): PaneNode => {
    if (node.type === "leaf") {
      if (node.id !== targetId) return node;
      const split: SplitNode = {
        type: "split",
        id: newId("split"),
        direction,
        children: [node, newLeaf],
        sizes: [0.5, 0.5],
      };
      return split;
    }
    return {
      ...node,
      children: [rec(node.children[0]), rec(node.children[1])],
    };
  };

  return { root: rec(root), newLeafId: newLeaf.id };
}

/** Remove a leaf; collapse any split left with a single child. Returns null if
 * the whole tree is emptied. */
export function removePane(root: PaneNode, targetId: string): PaneNode | null {
  const rec = (node: PaneNode): PaneNode | null => {
    if (node.type === "leaf") {
      return node.id === targetId ? null : node;
    }
    const a = rec(node.children[0]);
    const b = rec(node.children[1]);
    if (a && b) return { ...node, children: [a, b] };
    return a ?? b; // collapse the split into its surviving child
  };
  return rec(root);
}

/** Update the divider fractions of one split node. */
export function setSplitSizes(
  root: PaneNode,
  splitId: string,
  sizes: [number, number]
): PaneNode {
  const rec = (node: PaneNode): PaneNode => {
    if (node.type === "leaf") return node;
    if (node.id === splitId) return { ...node, sizes };
    return { ...node, children: [rec(node.children[0]), rec(node.children[1])] };
  };
  return rec(root);
}

/** Ordered list of leaf ids — used to cycle focus between panes. */
export function leafOrder(root: PaneNode): string[] {
  return collectLeaves(root).map((l) => l.id);
}
