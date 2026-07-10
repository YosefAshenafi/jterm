import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  readText as clipboardReadText,
  writeText as clipboardWriteText,
} from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useStore } from "./state/store";
import { collectLeaves } from "./state/tree";
import { terminals } from "./terminal/manager";
import { TabBar } from "./components/TabBar";
import { Toolbar } from "./components/Toolbar";
import { Sidebar } from "./components/Sidebar";
import { WorkArea } from "./components/WorkArea";
import { CommandPalette } from "./components/CommandPalette";
import { explorerHovered } from "./components/ExplorerPanel";
import { isMac } from "./platform";

type TextField = HTMLInputElement | HTMLTextAreaElement;

function setFieldValue(el: TextField, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function replaceFieldSelection(el: TextField, text: string) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  setFieldValue(el, el.value.slice(0, start) + text + el.value.slice(end));
  const caret = start + text.length;
  el.setSelectionRange(caret, caret);
}

function fieldClipboard(el: TextField, k: string) {
  const selected = () => el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);
  if (k === "a") {
    el.select();
  } else if (k === "c") {
    const sel = selected();
    if (sel) void clipboardWriteText(sel);
  } else if (k === "x") {
    const sel = selected();
    if (sel) {
      void clipboardWriteText(sel);
      replaceFieldSelection(el, "");
    }
  } else if (k === "v") {
    void clipboardReadText()
      .then((text) => text != null && replaceFieldSelection(el, text))
      .catch(() => {});
  }
}

export default function App() {
  const store = useStore();
  const { state } = store;

  const tabOf = (paneId: string) =>
    state.tabs.find((t) => collectLeaves(t.root).some((l) => l.id === paneId));

  useEffect(() => {
    terminals.onExit = (paneId) => {
      if (store.panelTerminals.includes(paneId)) {
        store.closePanelTerminal(paneId);
        return;
      }
      const tab = tabOf(paneId);
      if (tab) store.closePane(tab.id, paneId);
    };
    terminals.onTitle = undefined;
    terminals.onLinkDownload = (url) => store.downloadUrl(url);
  });

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    const sync = async () => {
      try {
        const fs = await win.isFullscreen();
        document.documentElement.classList.toggle("fullscreen", fs);
      } catch {
      }
    };
    sync();
    win.onResized(sync).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    const live = new Set<string>();
    state.tabs.forEach((t) => collectLeaves(t.root).forEach((l) => live.add(l.id)));
    store.panelTerminals.forEach((id) => live.add(id));
    terminals.reconcile(live);
  }, [state, store.panelTerminals]);

  const storeRef = useRef(store);
  storeRef.current = store;
  useEffect(() => {
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const el = e.target as HTMLElement | null;
      const onEditor = !!el?.closest(".editor-body");
      const onTerminal = !!el?.closest(".terminal-host");
      if (!onEditor && !onTerminal) return;
      e.preventDefault();
      acc += e.deltaY;
      if (Math.abs(acc) < 40) return;
      const delta = acc < 0 ? 1 : -1;
      acc = 0;
      storeRef.current.zoom(onEditor ? "editor" : "terminal", delta);
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, []);

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

      if (k === "b" && !e.shiftKey) return run(() => {
        const showingExplorer =
          (store.sidebarOpen || store.sidebarPeek) && store.sidebarView === "explorer";
        if (showingExplorer) store.hideSidebar();
        else store.openSidebarView("explorer");
      });
      if (k === "f" && e.shiftKey) return run(() => store.openSidebarView("search"));
      if (k === "g" && e.shiftKey) return run(() => store.openSidebarView("git"));
      if (k === "j" && e.shiftKey) return run(() => store.addPanelTerminal());
      if (k === "j" && !e.shiftKey) return run(() => store.togglePanel());
      if (k === "p" && !e.shiftKey) return run(() => store.openQuickFiles());
      if (k === "g" && !e.shiftKey) return run(() => store.openGoToLine());
      if (k === "f" && !e.shiftKey) return run(() => store.openFind());
      if (k === "=" || k === "+" || k === "-" || k === "_" || k === "0") {
        const t = e.target as HTMLElement | null;
        const onEditor =
          !!t?.closest(".editor-body") ||
          (store.focusRegion === "editor" && !!store.editor.activePath);
        const delta = k === "0" ? 0 : k === "-" || k === "_" ? -1 : 1;
        return run(() => store.zoom(onEditor ? "editor" : "terminal", delta));
      }

      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      const inTerminal = !!el?.closest(".terminal-host");
      const inEditor = !!el?.closest(".editor-body");
      const inField = !inTerminal && !inEditor && (tag === "INPUT" || tag === "TEXTAREA");
      const editorFocused =
        inEditor ||
        (!inTerminal && !inField && store.focusRegion === "editor" && !!store.editor.activePath);
      if (inField || editorFocused) {
        if (editorFocused && k === "w") return run(() => store.closeActiveFile());
        if (editorFocused && k === "s") return run(() => store.saveActiveFile());
        if (isMac && inField && (k === "c" || k === "v" || k === "x" || k === "a")) {
          return run(() => fieldClipboard(el as TextField, k));
        }
        return;
      }

      if (k === "t") return run(store.newTab);
      if (k === "w") return run(store.closeActivePane);
      if (k === "m") return run(store.toggleZoomActive);
      if (e.code === "BracketRight") return run(() => store.cyclePane(1));
      if (e.code === "BracketLeft") return run(() => store.cyclePane(-1));
      const focusedTerminal = () =>
        el?.closest(".term-panel") ? store.activePanelTerminal : activePaneId();
      if (k === "v") {
        // Pointing at the Explorer, paste means files into the tree (handled
        // by ExplorerPanel's own listener), not text into the terminal.
        if (explorerHovered()) return;
        const id = focusedTerminal();
        if (id) return run(() => terminals.paste(id));
      }
      if (k === "c") {
        const id = focusedTerminal();
        if (id && terminals.getSelection(id)) return run(() => terminals.copy(id));
        return;
      }
      if (isMac && k >= "1" && k <= "9") {
        return run(() => store.selectTabIndex(Number(k) - 1));
      }
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

  return (
    <div className="app">
      <div className="titlebar" data-tauri-drag-region="deep">
        <TabBar />
      </div>
      <Toolbar />
      <div className="main">
        {!store.sidebarOpen && (
          <div
            className="sidebar-hover-zone"
            onMouseEnter={() => store.setSidebarPeek(true)}
          />
        )}
        {(store.sidebarOpen || store.sidebarPeek) && <Sidebar />}
        <WorkArea />
      </div>
      <CommandPalette />
      {store.toast && (
        <div
          className={`toast${store.toast.url ? " toast-link" : ""}`}
          role="status"
          title={store.toast.url ? "Open in browser" : undefined}
          onClick={() => {
            if (store.toast?.url) void openUrl(store.toast.url);
            store.dismissToast();
          }}
        >
          {store.toast.message}
        </div>
      )}
    </div>
  );
}
