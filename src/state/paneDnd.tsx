// Drag-and-drop for terminal panes. A pane is grabbed by its header and can be
// dropped onto an edge of another pane (to split there), onto a tab (to move it
// into that tab), or onto the empty tab-bar (to detach it into a new tab).
//
// Terminals live outside React keyed by pane id (see terminal/manager), so a
// move is purely a tree edit — the running shell follows its leaf wherever it
// lands, across tabs included.

import { createContext, ReactNode, useContext, useMemo, useState } from "react";

/** Which edge of a target pane the pointer is over (4-triangle hit test). */
export type DropZone = "left" | "right" | "top" | "bottom";

export type DropTarget =
  | { kind: "pane"; paneId: string; zone: DropZone }
  | { kind: "tab"; tabId: string }
  | { kind: "new-tab" };

interface PaneDndApi {
  /** Pane currently being dragged, or null when no drag is in progress. */
  draggingPaneId: string | null;
  /** Where a drop would currently land (drives the on-screen indicators). */
  dropTarget: DropTarget | null;
  begin(paneId: string): void;
  setDropTarget(target: DropTarget | null): void;
  end(): void;
}

const Ctx = createContext<PaneDndApi | null>(null);

export function PaneDndProvider({ children }: { children: ReactNode }) {
  const [draggingPaneId, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  const api = useMemo<PaneDndApi>(
    () => ({
      draggingPaneId,
      dropTarget,
      begin: (paneId) => setDragging(paneId),
      setDropTarget,
      end: () => {
        setDragging(null);
        setDropTarget(null);
      },
    }),
    [draggingPaneId, dropTarget]
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function usePaneDnd(): PaneDndApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("usePaneDnd must be used within PaneDndProvider");
  return ctx;
}

/** Closest edge of `rect` to (x, y), splitting the rect into four triangles. */
function quadrant(x: number, y: number, rect: DOMRect): DropZone {
  const dx = (x - (rect.left + rect.width / 2)) / rect.width; // -0.5 … 0.5
  const dy = (y - (rect.top + rect.height / 2)) / rect.height;
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? "left" : "right";
  return dy < 0 ? "top" : "bottom";
}

/** Resolve what's under the pointer into a drop target, or null for none.
 * The dragged pane never targets itself. */
export function computeDropTarget(
  x: number,
  y: number,
  draggingPaneId: string
): DropTarget | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el) return null;

  const tabEl = el.closest<HTMLElement>("[data-tab-id]");
  if (tabEl?.dataset.tabId) return { kind: "tab", tabId: tabEl.dataset.tabId };

  // Anywhere else on the tab strip (gaps, the new-tab button) detaches to a tab.
  if (el.closest("[data-tabbar]")) return { kind: "new-tab" };

  const paneEl = el.closest<HTMLElement>("[data-pane-id]");
  if (paneEl?.dataset.paneId && paneEl.dataset.paneId !== draggingPaneId) {
    return {
      kind: "pane",
      paneId: paneEl.dataset.paneId,
      zone: quadrant(x, y, paneEl.getBoundingClientRect()),
    };
  }
  return null;
}

// ---- Cursor ghost (imperative, so a 60fps drag never re-renders React) -------

let ghostEl: HTMLElement | null = null;

export function showGhost(label: string): void {
  removeGhost();
  const el = document.createElement("div");
  el.className = "pane-drag-ghost";
  el.textContent = label;
  document.body.appendChild(el);
  ghostEl = el;
}

export function moveGhost(x: number, y: number): void {
  if (ghostEl) ghostEl.style.transform = `translate(${x + 12}px, ${y + 12}px)`;
}

export function removeGhost(): void {
  ghostEl?.remove();
  ghostEl = null;
}
