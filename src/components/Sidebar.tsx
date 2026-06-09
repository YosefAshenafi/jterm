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
  const { sidebarView } = useStore();
  const [width, setWidth] = useState(272);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Tear down a live resize drag if the sidebar unmounts mid-drag so its
  // window listeners don't leak.
  useEffect(() => () => cleanupRef.current?.(), []);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    cleanupRef.current = trackPointerDrag(
      e,
      (ev) => setWidth(Math.min(560, Math.max(180, startW + ev.clientX - startX))),
      () => {
        cleanupRef.current = null;
      }
    );
  };

  return (
    <div className="sidebar">
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
