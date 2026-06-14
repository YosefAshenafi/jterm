import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  readText as clipboardReadText,
  writeText as clipboardWriteText,
} from "@tauri-apps/plugin-clipboard-manager";
import { useStore } from "./state/store";
import { collectLeaves } from "./state/tree";
import { terminals } from "./terminal/manager";
import { TabBar } from "./components/TabBar";
import { Toolbar } from "./components/Toolbar";
import { Sidebar } from "./components/Sidebar";
import { WorkArea } from "./components/WorkArea";
import { CommandPalette } from "./components/CommandPalette";

const isMac =
  /mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent);

type TextField = HTMLInputElement | HTMLTextAreaElement;

// These inputs are React-controlled, so assigning `.value` directly is ignored.
// Go through the prototype's native value setter and dispatch an `input` event —
// the change React's onChange actually listens for.
function setFieldValue(el: TextField, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

// Replace the current selection (or insert at the caret), leaving the caret
// after the inserted text.
function replaceFieldSelection(el: TextField, text: string) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  setFieldValue(el, el.value.slice(0, start) + text + el.value.slice(end));
  const caret = start + text.length;
  el.setSelectionRange(caret, caret);
}

// macOS strips the native Edit menu (see src-tauri/src/lib.rs) so the webview
// never wires Cmd+C/V/X/A in plain text fields like the ⌘P palette. Service them
// via the clipboard plugin, mirroring how the terminal and editor already do.
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

  // Find which tab owns a pane (used by the shell-exit callback).
  const tabOf = (paneId: string) =>
    state.tabs.find((t) => collectLeaves(t.root).some((l) => l.id === paneId));

  // Bridge the imperative terminal manager back into store actions.
  useEffect(() => {
    terminals.onExit = (paneId) => {
      // A bottom-panel terminal's shell exited: drop that tab (and hide the
      // panel if it was the last one).
      if (store.panelTerminals.includes(paneId)) {
        store.closePanelTerminal(paneId);
        return;
      }
      const tab = tabOf(paneId);
      if (tab) store.closePane(tab.id, paneId);
    };
    // Intentionally NOT wiring shell-emitted titles to the tab name: a tab is
    // named once from its first terminal's directory and then stays put. Letting
    // every active pane's shell title rewrite it made the top tab name flip on
    // each new inner terminal / command. Users can still rename a tab manually.
    terminals.onTitle = undefined;
    // Option/Alt-click on a terminal link downloads it to the Downloads folder.
    terminals.onLinkDownload = (url) => store.downloadUrl(url);
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

  // Tear down terminals whose panes were closed. Bottom-panel terminals live
  // outside the pane tree, so keep them alive explicitly.
  useEffect(() => {
    const live = new Set<string>();
    state.tabs.forEach((t) => collectLeaves(t.root).forEach((l) => live.add(l.id)));
    store.panelTerminals.forEach((id) => live.add(id));
    terminals.reconcile(live);
  }, [state, store.panelTerminals]);

  // ⌘/Ctrl + scroll zooms the surface under the cursor (terminal or editor),
  // like iTerm. Deltas are accumulated so a step is one notch / a bit of trackpad.
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
      e.preventDefault(); // stop the webview's own page zoom / scroll
      acc += e.deltaY;
      if (Math.abs(acc) < 40) return;
      const delta = acc < 0 ? 1 : -1; // scroll up = zoom in
      acc = 0;
      storeRef.current.zoom(onEditor ? "editor" : "terminal", delta);
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, []);

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
      // Bottom terminal panel toggles from anywhere — including while typing in a
      // file or terminal. ⌘⇧J adds a new terminal tab to it (VS Code-style).
      if (k === "j" && e.shiftKey) return run(() => store.addPanelTerminal());
      if (k === "j" && !e.shiftKey) return run(() => store.togglePanel());
      // VS Code-style: ⌘P quick-open files, ⌘G go-to-line, ⌘F find-in-file. These
      // must work even while the editor/terminal has focus, so they sit here
      // (before the field/editor guard below).
      if (k === "p" && !e.shiftKey) return run(() => store.openQuickFiles());
      if (k === "g" && !e.shiftKey) return run(() => store.openGoToLine());
      if (k === "f" && !e.shiftKey) return run(() => store.openFind());
      // iTerm-style zoom: ⌘=/⌘+ in, ⌘- out, ⌘0 reset — on the focused surface.
      if (k === "=" || k === "+" || k === "-" || k === "_" || k === "0") {
        const t = e.target as HTMLElement | null;
        const onEditor =
          !!t?.closest(".editor-body") ||
          (store.focusRegion === "editor" && !!store.editor.activePath);
        const delta = k === "0" ? 0 : k === "-" || k === "_" ? -1 : 1;
        return run(() => store.zoom(onEditor ? "editor" : "terminal", delta));
      }

      // xterm types into a hidden helper <textarea>, so anything inside a
      // terminal host is the terminal, not a text field.
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      const inTerminal = !!el?.closest(".terminal-host");
      const inEditor = !!el?.closest(".editor-body");
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
        // Cmd+C/V/X/A in a plain text field (e.g. the ⌘P search box). On macOS
        // the native Edit menu is gone, so service these ourselves; elsewhere
        // the webview handles them natively, so leave them alone.
        if (isMac && inField && (k === "c" || k === "v" || k === "x" || k === "a")) {
          return run(() => fieldClipboard(el as TextField, k));
        }
        return;
      }

      if (k === "t") return run(store.newTab);
      if (k === "w") return run(store.closeActivePane);
      if (k === "m") return run(store.toggleZoomActive); // maximize/restore pane
      // Brackets by physical key: with Shift held (the Windows/Linux chord),
      // e.key reports "}"/"{" and would never match "]"/"[".
      if (e.code === "BracketRight") return run(() => store.cyclePane(1));
      if (e.code === "BracketLeft") return run(() => store.cyclePane(-1));
      // Copy/paste must target the terminal that actually has focus: the bottom
      // panel's terminal when the keystroke came from inside it, else the grid's
      // active pane. (Previously these always used the grid pane, so pasting into
      // the panel silently went to a hidden terminal.)
      const focusedTerminal = () =>
        el?.closest(".term-panel") ? store.activePanelTerminal : activePaneId();
      if (k === "v") {
        const id = focusedTerminal();
        if (id) return run(() => terminals.paste(id));
      }
      if (k === "c") {
        const id = focusedTerminal();
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
        {/* Hover the left edge to peek the sidebar when it isn't pinned open. */}
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
        <div className="toast" role="status" onPointerDown={() => store.dismissToast()}>
          {store.toast}
        </div>
      )}
    </div>
  );
}
