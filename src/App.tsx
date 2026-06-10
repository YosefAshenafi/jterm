import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStore } from "./state/store";
import { collectLeaves } from "./state/tree";
import { terminals } from "./terminal/manager";
import { TabBar } from "./components/TabBar";
import { Toolbar } from "./components/Toolbar";
import { Sidebar } from "./components/Sidebar";
import { EditorArea } from "./components/EditorArea";
import { PaneTree, MenuRequest } from "./components/PaneTree";
import { ContextMenu, MenuItem } from "./components/ContextMenu";

const isMac =
  /mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent);

export default function App() {
  const store = useStore();
  const { state } = store;
  const [menu, setMenu] = useState<MenuRequest | null>(null);

  const activeTab = state.tabs.find((t) => t.id === state.activeTabId);

  // Find which tab owns a pane (used by shell-exit / title callbacks).
  const tabOf = (paneId: string) =>
    state.tabs.find((t) => collectLeaves(t.root).some((l) => l.id === paneId));

  // Bridge the imperative terminal manager back into store actions.
  useEffect(() => {
    terminals.onExit = (paneId) => {
      const tab = tabOf(paneId);
      if (tab) store.closePane(tab.id, paneId);
    };
    terminals.onTitle = (paneId, title) => {
      const tab = tabOf(paneId);
      if (tab && title && tab.activePaneId === paneId) store.setTitle(tab.id, title);
    };
  });

  // Reflect native full-screen state as a `fullscreen` class on <html> so the
  // shell floats as a bordered "modal" with a margin only in full-screen, and
  // stays edge-to-edge in a normal window. Resizing fires on fullscreen toggle.
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    const sync = async () => {
      try {
        const fs = await win.isFullscreen();
        document.documentElement.classList.toggle("fullscreen", fs);
      } catch {
        /* not running inside a Tauri window (e.g. plain browser preview) */
      }
    };
    sync();
    win.onResized(sync).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  // Tear down terminals whose panes were closed.
  useEffect(() => {
    const live = new Set<string>();
    state.tabs.forEach((t) => collectLeaves(t.root).forEach((l) => live.add(l.id)));
    terminals.reconcile(live);
  }, [state]);

  // Keyboard shortcuts (Cmd on macOS, Ctrl+Shift elsewhere to avoid clobbering
  // terminal control characters like ^C/^D/^W).
  useEffect(() => {
    const activePaneId = () =>
      state.tabs.find((t) => t.id === state.activeTabId)?.activePaneId;

    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && e.shiftKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      const run = (fn: () => void) => {
        e.preventDefault();
        fn();
      };

      // Sidebar views work from anywhere (⌘B explorer toggle, ⌘⇧F search, ⌘⇧G source control).
      if (k === "b" && !e.shiftKey) return run(() => {
        if (store.sidebarOpen && store.sidebarView === "explorer") store.toggleSidebar();
        else store.openSidebarView("explorer");
      });
      if (k === "f" && e.shiftKey) return run(() => store.openSidebarView("search"));
      if (k === "g" && e.shiftKey) return run(() => store.openSidebarView("git"));

      // xterm types into a hidden helper <textarea>, so anything inside a
      // terminal host is the terminal, not a text field.
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      const inTerminal = !!el?.closest(".terminal-host");
      const inEditor = !!el?.closest(".editor");
      // In any other text field (search box, commit message, folder path) every
      // shortcut stays native — Cmd+W there must not close an editor file the
      // user isn't even looking at.
      const inField = !inTerminal && !inEditor && (tag === "INPUT" || tag === "TEXTAREA");
      // Close/save route to the editor when the keystroke comes from inside it,
      // or when it logically holds the keyboard (e.g. its tab strip was clicked).
      const editorFocused =
        inEditor ||
        (!inTerminal && !inField && store.focusRegion === "editor" && !!store.editor.activePath);
      if (inField || editorFocused) {
        if (editorFocused && k === "w") return run(() => store.closeActiveFile());
        if (editorFocused && k === "s") return run(() => store.saveActiveFile());
        return;
      }

      if (k === "t") return run(store.newTab);
      if (k === "w") return run(store.closeActivePane);
      if (k === "m") return run(store.toggleZoomActive); // maximize/restore pane
      // Brackets by physical key: with Shift held (the Windows/Linux chord),
      // e.key reports "}"/"{" and would never match "]"/"[".
      if (e.code === "BracketRight") return run(() => store.cyclePane(1));
      if (e.code === "BracketLeft") return run(() => store.cyclePane(-1));
      if (k === "v") {
        const id = activePaneId();
        if (id) return run(() => terminals.paste(id));
      }
      if (k === "c") {
        const id = activePaneId();
        if (id && terminals.getSelection(id)) return run(() => terminals.copy(id));
        return; // no selection: let ^C pass through to the shell
      }
      if (isMac && k >= "1" && k <= "9") {
        return run(() => store.selectTabIndex(Number(k) - 1));
      }
      // Split: vertical (left/right) vs horizontal (top/bottom).
      if (isMac) {
        if (k === "d" && !e.shiftKey) return run(() => store.split("row"));
        if (k === "d" && e.shiftKey) return run(() => store.split("column"));
      } else {
        if (k === "d") return run(() => store.split("row"));
        if (k === "e") return run(() => store.split("column"));
      }
    };

    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [state, store]);

  const menuItems = (req: MenuRequest): MenuItem[] => {
    const tab = tabOf(req.paneId);
    const hasSelection = !!terminals.getSelection(req.paneId);
    return [
      { label: "Split Right", onClick: () => store.split("row") },
      { label: "Split Down", onClick: () => store.split("column") },
      { label: "Copy", disabled: !hasSelection, onClick: () => terminals.copy(req.paneId) },
      { label: "Paste", onClick: () => terminals.paste(req.paneId) },
      {
        label: "Close Pane",
        onClick: () => tab && store.closePane(tab.id, req.paneId),
      },
    ];
  };

  return (
    <div className="app">
      {/* "deep" makes the whole bar a drag region (interactive children like
          tabs/buttons are excluded automatically). Tauri's drag script also
          toggles maximize — macOS zoom, not full screen — on double-click. */}
      <div className="titlebar" data-tauri-drag-region="deep">
        <TabBar />
      </div>
      <Toolbar />
      <div className="main">
        {store.sidebarOpen && <Sidebar />}
        {store.editor.files.length > 0 && <EditorArea />}
        <div className="workspace">
          {activeTab && (
            <PaneTree node={activeTab.root} tab={activeTab} onPaneMenu={setMenu} />
          )}
        </div>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
