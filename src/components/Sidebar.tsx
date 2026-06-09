import { useState } from "react";
import { useStore } from "../state/store";
import { ActivityBar } from "./ActivityBar";
import { ExplorerPanel } from "./ExplorerPanel";
import { SearchPanel } from "./SearchPanel";
import { GitPanel } from "./GitPanel";

/** Left region: a fixed activity rail (Explorer / Search / Source Control) plus
 * the resizable panel for whichever view is active. */
export function Sidebar() {
  const { sidebarView } = useStore();
  const [width, setWidth] = useState(272);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: PointerEvent) =>
      setWidth(Math.min(560, Math.max(180, startW + ev.clientX - startX)));
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
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
