import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { trackPointerDrag } from "../drag";
import { ActivityBar } from "./ActivityBar";
import { ExplorerPanel } from "./ExplorerPanel";
import { SearchPanel } from "./SearchPanel";
import { GitPanel } from "./GitPanel";

/** Left region: a fixed activity rail (Explorer / Search / Source Control) plus
 * the resizable panel for whichever view is active. */
export function Sidebar() {
  const { sidebarView, sidebarOpen, sidebarPeek, setSidebarPeek, sidebarWidth, setSidebarWidth } =
    useStore();
  // Local state for a smooth live drag; seeded from (and saved back to) the
  // remembered width so toggling the sidebar restores its last size.
  const [width, setWidth] = useState(sidebarWidth);
  const cleanupRef = useRef<(() => void) | null>(null);
  // Overlay (floating) mode when revealed by hover rather than pinned open.
  const overlay = !sidebarOpen && sidebarPeek;

  // Tear down a live resize drag if the sidebar unmounts mid-drag so its
  // window listeners don't leak.
  useEffect(() => () => cleanupRef.current?.(), []);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let last = width;
    cleanupRef.current = trackPointerDrag(
      e,
      (ev) => {
        last = Math.min(560, Math.max(180, startW + ev.clientX - startX));
        setWidth(last);
      },
      () => {
        cleanupRef.current = null;
        setSidebarWidth(last); // remember the final size
      }
    );
  };

  return (
    <div
      className={`sidebar${overlay ? " sidebar-overlay" : ""}`}
      onMouseLeave={overlay ? () => setSidebarPeek(false) : undefined}
    >
      <ActivityBar />
      <div className="side-panel" style={{ width }}>
        {sidebarView === "explorer" && <ExplorerPanel />}
        {sidebarView === "search" && <SearchPanel />}
        {sidebarView === "git" && <GitPanel />}
        <div
          className="sidebar-resize"
          onPointerDown={startResize}
          role="separator"
          aria-orientation="vertical"
        />
      </div>
    </div>
  );
}
