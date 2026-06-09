// Layout model: every tab holds a recursive binary tree of panes.
// A leaf is a single terminal; a split places two children side by side
// (`row` => left/right, vertical divider) or stacked (`column` => top/bottom,
// horizontal divider). Nesting is unlimited in both directions.

export type Direction = "row" | "column";

export interface LeafNode {
  type: "leaf";
  /** Stable pane id; also the key the terminal manager uses for this pane. */
  id: string;
}

export interface SplitNode {
  type: "split";
  id: string;
  direction: Direction;
  children: [PaneNode, PaneNode];
  /** Fractions of the split axis, summing to 1. */
  sizes: [number, number];
}

export type PaneNode = LeafNode | SplitNode;

export interface Tab {
  id: string;
  title: string;
  root: PaneNode;
  /** Pane that currently has focus within this tab. */
  activePaneId: string;
  /** True once the user has renamed the tab; locks out shell-driven titles. */
  titleManual?: boolean;
  /** When set, this pane is zoomed to fill the workspace (others hidden). */
  zoomedPaneId?: string | null;
}

export interface AppState {
  tabs: Tab[];
  activeTabId: string;
}
