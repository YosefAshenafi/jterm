import { ReactNode } from "react";
import { useStore } from "../state/store";
import { SidebarView } from "../state/store";
import { ExplorerIcon, GitBranchIcon, SearchIcon } from "./icons";

const ITEMS: { view: SidebarView; label: string; icon: ReactNode }[] = [
  { view: "explorer", label: "Explorer", icon: <ExplorerIcon /> },
  { view: "search", label: "Search  ·  ⌘⇧F", icon: <SearchIcon /> },
  { view: "git", label: "Source Control  ·  ⌘⇧G", icon: <GitBranchIcon /> },
];

/** Vertical icon rail that switches the sidebar between Explorer / Search /
 * Source Control. Re-clicking the search icon refocuses its input. */
export function ActivityBar() {
  const { sidebarView, openSidebarView } = useStore();
  return (
    <div className="activity-bar">
      {ITEMS.map((it) => (
        <button
          key={it.view}
          className={`activity-btn${sidebarView === it.view ? " active" : ""}`}
          title={it.label}
          aria-label={it.label}
          aria-pressed={sidebarView === it.view}
          // preventDefault on pointerdown keeps focus in the terminal; the
          // action runs on click so keyboard activation works and right/middle
          // clicks are ignored.
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => openSidebarView(it.view)}
        >
          {it.icon}
        </button>
      ))}
    </div>
  );
}
