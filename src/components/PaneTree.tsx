import { CSSProperties, useEffect, useRef } from "react";
import { Direction, PaneNode, Tab } from "../state/types";
import { useStore } from "../state/store";
import { collectLeaves, firstLeaf } from "../state/tree";
import { trackPointerDrag } from "../drag";
import { TerminalPane } from "./TerminalPane";
import { basename } from "../workspace";

interface MenuRequest {
  x: number;
  y: number;
  paneId: string;
}

interface TreeProps {
  node: PaneNode;
  tab: Tab;
  onPaneMenu: (req: MenuRequest) => void;
}

/** Flex sizing for one side of a split, leaving room for the 1px divider
 * (each side gives up half of it). */
function basis(fraction: number): CSSProperties {
  return { flex: `0 0 calc(${(fraction * 100).toFixed(4)}% - 0.5px)`, minWidth: 0, minHeight: 0 };
}

/** One terminal leaf, wired to the store. `canZoom` reflects whether the tab
 * has more than one pane (a zoom toggle is meaningless for a lone terminal). */
function PaneLeaf({
  tab,
  paneId,
  canZoom,
  onPaneMenu,
}: {
  tab: Tab;
  paneId: string;
  canZoom: boolean;
  onPaneMenu: (req: MenuRequest) => void;
}) {
  const { focusPane, closePane, toggleZoom, setTitle } = useStore();
  const firstPaneId = firstLeaf(tab.root).id;
  return (
    <TerminalPane
      paneId={paneId}
      active={tab.activePaneId === paneId}
      zoomed={tab.zoomedPaneId === paneId}
      canZoom={canZoom}
      onFocus={() => focusPane(tab.id, paneId)}
      onClose={() => closePane(tab.id, paneId)}
      onToggleZoom={() => toggleZoom(tab.id, paneId)}
      onContextMenu={(x, y) => onPaneMenu({ x, y, paneId })}
      onCwdChange={paneId === firstPaneId ? (cwd) => setTitle(tab.id, basename(cwd)) : undefined}
    />
  );
}

/** Entry point: render the zoomed pane full-size if one is set and still exists,
 * otherwise lay out the whole split tree. */
export function PaneTree({ node, tab, onPaneMenu }: TreeProps) {
  const leaves = collectLeaves(tab.root);
  const multi = leaves.length > 1;
  if (tab.zoomedPaneId && leaves.some((l) => l.id === tab.zoomedPaneId)) {
    return <PaneLeaf tab={tab} paneId={tab.zoomedPaneId} canZoom={multi} onPaneMenu={onPaneMenu} />;
  }
  return <Tree node={node} tab={tab} onPaneMenu={onPaneMenu} />;
}

/** Recursive layout renderer (no zoom logic — that lives in `PaneTree`). */
function Tree({ node, tab, onPaneMenu }: TreeProps) {
  if (node.type === "leaf") {
    return (
      <PaneLeaf
        tab={tab}
        paneId={node.id}
        canZoom={collectLeaves(tab.root).length > 1}
        onPaneMenu={onPaneMenu}
      />
    );
  }
  return <SplitView node={node} tab={tab} onPaneMenu={onPaneMenu} />;
}

function SplitView({ node, tab, onPaneMenu }: TreeProps & { node: Extract<PaneNode, { type: "split" }> }) {
  const { resizeSplit } = useStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const frame = useRef<number | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  // A split can be removed mid-drag (e.g. ⌘W closes a pane); tear the drag
  // down on unmount so its listeners don't outlive the component.
  useEffect(() => () => cleanupRef.current?.(), []);

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const horizontal = node.direction === "row";
    const total = horizontal ? rect.width : rect.height;
    const origin = horizontal ? e.clientX : e.clientY;
    const startFraction = node.sizes[0];

    cleanupRef.current = trackPointerDrag(
      e,
      (ev) => {
        const pos = horizontal ? ev.clientX : ev.clientY;
        let fraction = startFraction + (pos - origin) / total;
        fraction = Math.min(0.9, Math.max(0.1, fraction));
        if (frame.current != null) cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() =>
          resizeSplit(tab.id, node.id, [fraction, 1 - fraction])
        );
      },
      () => {
        // Drop any still-queued frame so a resize can't land after the drag
        // ended (or after this split unmounted).
        if (frame.current != null) {
          cancelAnimationFrame(frame.current);
          frame.current = null;
        }
        cleanupRef.current = null;
      }
    );
  };

  return (
    <div ref={containerRef} className="split" style={{ flexDirection: node.direction }}>
      <div className="split-child" style={basis(node.sizes[0])}>
        <Tree node={node.children[0]} tab={tab} onPaneMenu={onPaneMenu} />
      </div>
      <div
        className={`divider divider-${node.direction}`}
        onPointerDown={startDrag}
        role="separator"
        aria-orientation={node.direction === "row" ? "vertical" : "horizontal"}
      />
      <div className="split-child" style={basis(node.sizes[1])}>
        <Tree node={node.children[1]} tab={tab} onPaneMenu={onPaneMenu} />
      </div>
    </div>
  );
}

export type { MenuRequest, Direction };
