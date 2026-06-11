// Global app state: tabs, the active tab, and each tab's pane tree.
// Exposed to components as a small typed API backed by useReducer.

import {
  createContext,
  Dispatch,
  ReactNode,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { terminals } from "../terminal/manager";
import {
  hexToRgba,
  loadSettings,
  saveSettings,
  Settings,
} from "./settings";
import { AppState, Direction, LeafNode, Tab } from "./types";
import {
  collectLeaves,
  firstLeaf,
  leafOrder,
  makeLeaf,
  newId,
  removePane,
  setSplitSizes,
  splitPane,
} from "./tree";
import { EditorState, editorReducer, emptyEditor, isDirty } from "./editor";
import { basename, resolveCwd } from "../workspace";
import { homeDir } from "@tauri-apps/api/path";

/** Which surface the keyboard (close / save) should act on. */
export type FocusRegion = "terminal" | "editor";

/** Which panel the left sidebar shows. */
export type SidebarView = "explorer" | "search" | "git";

/** A pending request to scroll/select a line once a file is open in the editor. */
export interface RevealTarget {
  path: string;
  line: number;
}

const SNAPSHOT_KEY = "jterm_tab_titles";

interface TabSnapshot {
  title: string;
  titleManual?: boolean;
}

function saveSnapshot(tabs: Tab[], activeTabId: string): void {
  const data = {
    tabs: tabs.map((t) => ({ title: t.title, titleManual: t.titleManual })),
    activeIndex: tabs.findIndex((t) => t.id === activeTabId),
  };
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(data));
  } catch { /* quota exceeded — silently ignore */ }
}

function loadSnapshot(): { tabs: TabSnapshot[]; activeIndex: number } | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function makeTab(): Tab {
  const leaf = makeLeaf();
  return { id: newId("tab"), title: "Terminal", root: leaf, activePaneId: leaf.id };
}

function initialState(): AppState {
  const snap = loadSnapshot();
  if (snap && snap.tabs.length > 0) {
    const tabs = snap.tabs.map((s) => {
      const t = makeTab();
      t.title = s.title;
      t.titleManual = s.titleManual ?? false;
      return t;
    });
    const idx = Math.min(snap.activeIndex, tabs.length - 1);
    return { tabs, activeTabId: tabs[idx].id };
  }
  const tab = makeTab();
  return { tabs: [tab], activeTabId: tab.id };
}

type Action =
  | { type: "new-tab"; leaf: LeafNode; tabId: string; title?: string }
  | { type: "close-tab"; tabId: string }
  | { type: "select-tab"; tabId: string }
  | { type: "select-tab-index"; index: number }
  | { type: "split"; direction: Direction; leaf?: LeafNode }
  | { type: "close-pane"; tabId: string; paneId: string }
  | { type: "focus-pane"; tabId: string; paneId: string }
  | { type: "toggle-zoom"; tabId: string; paneId: string }
  | { type: "cycle-pane"; delta: number }
  | { type: "resize-split"; tabId: string; splitId: string; sizes: [number, number] }
  | { type: "set-title"; tabId: string; title: string }
  | { type: "rename-tab"; tabId: string; title: string };

const activeTab = (s: AppState): Tab | undefined =>
  s.tabs.find((t) => t.id === s.activeTabId);

function updateTab(s: AppState, tabId: string, patch: Partial<Tab>): AppState {
  return {
    ...s,
    tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)),
  };
}

function closeTab(s: AppState, tabId: string): AppState {
  const index = s.tabs.findIndex((t) => t.id === tabId);
  if (index === -1) return s;
  const tabs = s.tabs.filter((t) => t.id !== tabId);
  if (tabs.length === 0) {
    return initialState(); // always keep at least one tab open
  }
  let activeTabId = s.activeTabId;
  if (activeTabId === tabId) {
    const neighbor = tabs[Math.min(index, tabs.length - 1)];
    activeTabId = neighbor.id;
  }
  return { tabs, activeTabId };
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "new-tab": {
      const tab: Tab = {
        id: action.tabId,
        title: action.title ?? "Terminal",
        root: action.leaf,
        activePaneId: action.leaf.id,
      };
      return { tabs: [...state.tabs, tab], activeTabId: tab.id };
    }
    case "select-tab":
      return { ...state, activeTabId: action.tabId };
    case "select-tab-index": {
      const tab = state.tabs[action.index];
      return tab ? { ...state, activeTabId: tab.id } : state;
    }
    case "close-tab":
      return closeTab(state, action.tabId);
    case "split": {
      const tab = activeTab(state);
      if (!tab) return state;
      const { root, newLeafId } = splitPane(
        tab.root,
        tab.activePaneId,
        action.direction,
        action.leaf
      );
      // A new split should be visible, so leave any zoom.
      return updateTab(state, tab.id, { root, activePaneId: newLeafId, zoomedPaneId: null });
    }
    case "close-pane": {
      const tab = state.tabs.find((t) => t.id === action.tabId);
      if (!tab) return state;
      const root = removePane(tab.root, action.paneId);
      if (!root) return closeTab(state, tab.id);
      const leaves = collectLeaves(root);
      const stillActive = leaves.some((l) => l.id === tab.activePaneId);
      const activePaneId = stillActive ? tab.activePaneId : firstLeaf(root).id;
      // Drop the zoom if the zoomed pane is the one that went away.
      const zoomedPaneId =
        tab.zoomedPaneId && leaves.some((l) => l.id === tab.zoomedPaneId)
          ? tab.zoomedPaneId
          : null;
      return updateTab(state, tab.id, { root, activePaneId, zoomedPaneId });
    }
    case "focus-pane":
      return updateTab(state, action.tabId, { activePaneId: action.paneId });
    case "toggle-zoom": {
      const tab = state.tabs.find((t) => t.id === action.tabId);
      if (!tab) return state;
      const zoomedPaneId = tab.zoomedPaneId === action.paneId ? null : action.paneId;
      // Zooming a pane also focuses it.
      return updateTab(state, tab.id, { zoomedPaneId, activePaneId: action.paneId });
    }
    case "cycle-pane": {
      const tab = activeTab(state);
      if (!tab) return state;
      const order = leafOrder(tab.root);
      if (order.length < 2) return state;
      const i = order.indexOf(tab.activePaneId);
      const next = order[(i + action.delta + order.length) % order.length];
      // Cycling navigates the whole layout, so exit zoom.
      return updateTab(state, tab.id, { activePaneId: next, zoomedPaneId: null });
    }
    case "resize-split": {
      const tab = state.tabs.find((t) => t.id === action.tabId);
      if (!tab) return state;
      return updateTab(state, tab.id, {
        root: setSplitSizes(tab.root, action.splitId, action.sizes),
      });
    }
    case "set-title": {
      // Shell-driven title: never override a name the user typed themselves.
      const tab = state.tabs.find((t) => t.id === action.tabId);
      if (!tab || tab.titleManual) return state;
      return updateTab(state, action.tabId, { title: action.title });
    }
    case "rename-tab": {
      const title = action.title.trim();
      return updateTab(state, action.tabId, {
        title: title || "Terminal",
        titleManual: true,
      });
    }
    default:
      return state;
  }
}

interface StoreApi {
  state: AppState;
  dispatch: Dispatch<Action>;
  /** Pane that currently has focus in the active tab, if any. */
  activePaneId: string | null;
  // Project workspace (toolbar + sidebar).
  sidebarOpen: boolean;
  projectRoot: string | null;
  sidebarView: SidebarView;
  /** Bumped each time the search view is (re)opened, so its input can refocus. */
  searchNonce: number;
  toggleSidebar(): void;
  setSidebarOpen(open: boolean): void;
  setProjectRoot(path: string | null): void;
  setSidebarView(view: SidebarView): void;
  /** Open the sidebar to a view, resolving the project folder if not set yet. */
  openSidebarView(view: SidebarView): Promise<void>;
  newTab(): Promise<void>;
  closeTab(tabId: string): void;
  selectTab(tabId: string): void;
  selectTabIndex(index: number): void;
  split(direction: Direction): void;
  closePane(tabId: string, paneId: string): void;
  closeActivePane(): void;
  focusPane(tabId: string, paneId: string): void;
  toggleZoom(tabId: string, paneId: string): void;
  toggleZoomActive(): void;
  cyclePane(delta: number): void;
  resizeSplit(tabId: string, splitId: string, sizes: [number, number]): void;
  setTitle(tabId: string, title: string): void;
  renameTab(tabId: string, title: string): void;
  // User settings (appearance, terminal prefs).
  settings: Settings;
  updateSettings(patch: Partial<Settings>): void;
  // Editor (file viewer/editor beside the folder tree).
  editor: EditorState;
  focusRegion: FocusRegion;
  setFocusRegion(region: FocusRegion): void;
  /** Open a file in the editor; pass `line` (1-based) to reveal/select it. */
  openFile(path: string, line?: number): void;
  /** Open a diff view for a git file. */
  openDiffView(path: string, content: string): void;
  /** Number of changed files shown as a badge on the git icon. */
  gitChangesCount: number;
  setGitChangesCount(n: number): void;
  /** A pending line to reveal once its file is loaded (consumed by the editor). */
  reveal: RevealTarget | null;
  clearReveal(): void;
  selectFile(path: string): void;
  setFileDraft(path: string, draft: string): void;
  markFileLoaded(path: string, text: string): void;
  markFileError(path: string, error: string): void;
  saveFile(path: string): Promise<void>;
  saveActiveFile(): Promise<void>;
  requestCloseFile(path: string): Promise<void>;
  closeActiveFile(): Promise<void>;
}

const StoreContext = createContext<StoreApi | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [projectRootMap, setProjectRootMap] = useState<Record<string, string | null>>({});
  const [sidebarView, setSidebarView] = useState<SidebarView>("explorer");
  const [searchNonce, setSearchNonce] = useState(0);
  const [reveal, setReveal] = useState<RevealTarget | null>(null);
  const [editor, editorDispatch] = useReducer(editorReducer, emptyEditor);
  const [focusRegion, setFocusRegion] = useState<FocusRegion>("terminal");
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [gitChangesCount, setGitChangesCount] = useState(0);

  // Apply settings to the document (CSS variables) and live terminals, and
  // persist them. Runs on mount so a saved accent/font is restored at startup.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--accent", settings.accent);
    root.style.setProperty("--pane-border", hexToRgba(settings.accent, 0.5));
    terminals.setPrefs({
      accent: settings.accent,
      fontSize: settings.fontSize,
      cursorBlink: settings.cursorBlink,
    });
    saveSettings(settings);
  }, [settings]);

  const activeTabId = state.activeTabId;
  const activePaneId =
    state.tabs.find((t) => t.id === activeTabId)?.activePaneId ?? null;
  const projectRoot = projectRootMap[activeTabId] ?? null;

  // Per-tab project root: sync the active pane's CWD into the current tab's
  // entry whenever the sidebar is open. The effect fires on tab switch too.
  useEffect(() => {
    if (!sidebarOpen || !activePaneId) return;
    resolveCwd(activePaneId).then((cwd) => {
      setProjectRootMap((prev) => ({ ...prev, [activeTabId]: cwd }));
    });
  }, [activePaneId, sidebarOpen, activeTabId]);

  // Keep the map tidy — remove entries for closed tabs.
  useEffect(() => {
    const ids = new Set(state.tabs.map((t) => t.id));
    setProjectRootMap((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) if (!ids.has(k)) delete next[k];
      return next;
    });
  }, [state.tabs]);

  // Persist tab titles across restarts.
  useEffect(() => {
    saveSnapshot(state.tabs, state.activeTabId);
  }, [state.tabs, state.activeTabId]);

  const api = useMemo<StoreApi>(
    () => ({
      state,
      dispatch,
      activePaneId,
      sidebarOpen,
      projectRoot,
      sidebarView,
      searchNonce,
      toggleSidebar: () => setSidebarOpen((v) => !v),
      setSidebarOpen,
      setProjectRoot: (root) => {
        setProjectRootMap((prev) => ({ ...prev, [activeTabId]: root }));
      },
      setSidebarView,
      openSidebarView: async (view) => {
        setSidebarView(view);
        setSidebarOpen(true);
        if (view === "search") setSearchNonce((n) => n + 1);
        if (!projectRootMap[activeTabId]) {
          const cwd = await resolveCwd(activePaneId);
          setProjectRootMap((prev) => ({ ...prev, [activeTabId]: cwd }));
        }
      },
      newTab: async () => {
        const leaf = makeLeaf();
        const tabId = newId("tab");
        // Close sidebar first — the folder belongs to the previous tab.
        if (sidebarOpen) {
          setSidebarOpen(false);
        }
        const h = await homeDir();
        terminals.setSpawnCwd(leaf.id, Promise.resolve(h));
        dispatch({ type: "new-tab", leaf, tabId, title: basename(h) });
        setProjectRootMap((prev) => ({ ...prev, [tabId]: h }));
      },
      closeTab: (tabId) => dispatch({ type: "close-tab", tabId }),
      selectTab: (tabId) => dispatch({ type: "select-tab", tabId }),
      selectTabIndex: (index) => dispatch({ type: "select-tab-index", index }),
      split: (direction) => {
        const tab = state.tabs.find((t) => t.id === state.activeTabId);
        if (!tab) return;
        // The new pane's shell starts in the split source's working directory.
        // The leaf is made here (not in the reducer) so its cwd can be handed
        // to the terminal manager before the pane mounts and spawns.
        const leaf = makeLeaf();
        terminals.setSpawnCwd(leaf.id, resolveCwd(tab.activePaneId));
        dispatch({ type: "split", direction, leaf });
      },
      closePane: (tabId, paneId) => dispatch({ type: "close-pane", tabId, paneId }),
      closeActivePane: () => {
        const tab = state.tabs.find((t) => t.id === state.activeTabId);
        if (tab) dispatch({ type: "close-pane", tabId: tab.id, paneId: tab.activePaneId });
      },
      focusPane: (tabId, paneId) => {
        setFocusRegion("terminal");
        dispatch({ type: "focus-pane", tabId, paneId });
      },
      toggleZoom: (tabId, paneId) => {
        setFocusRegion("terminal");
        dispatch({ type: "toggle-zoom", tabId, paneId });
      },
      toggleZoomActive: () => {
        const tab = state.tabs.find((t) => t.id === state.activeTabId);
        if (tab) {
          setFocusRegion("terminal");
          dispatch({ type: "toggle-zoom", tabId: tab.id, paneId: tab.activePaneId });
        }
      },
      cyclePane: (delta) => dispatch({ type: "cycle-pane", delta }),
      resizeSplit: (tabId, splitId, sizes) =>
        dispatch({ type: "resize-split", tabId, splitId, sizes }),
      setTitle: (tabId, title) => dispatch({ type: "set-title", tabId, title }),
      renameTab: (tabId, title) => dispatch({ type: "rename-tab", tabId, title }),

      settings,
      updateSettings: (patch) => setSettings((s) => ({ ...s, ...patch })),

      editor,
      focusRegion,
      setFocusRegion,
      openDiffView: (path, content) => {
        editorDispatch({ type: "open-diff", path, name: basename(path), content });
        setFocusRegion("editor");
      },
      gitChangesCount,
      setGitChangesCount,
      openFile: (path, line) => {
        editorDispatch({ type: "open", path, name: basename(path) });
        setFocusRegion("editor");
        if (line != null) setReveal({ path, line });
      },
      reveal,
      clearReveal: () => setReveal(null),
      selectFile: (path) => {
        editorDispatch({ type: "select", path });
        setFocusRegion("editor");
      },
      setFileDraft: (path, draft) => editorDispatch({ type: "edit", path, draft }),
      markFileLoaded: (path, text) => editorDispatch({ type: "loaded", path, text }),
      markFileError: (path, error) => editorDispatch({ type: "error", path, error }),
      saveFile: async (path) => {
        const f = editor.files.find((x) => x.path === path);
        if (!f || f.saved === null || !isDirty(f)) return;
        const written = f.draft; // snapshot — the user may keep typing mid-save
        try {
          await invoke("write_file", { path, content: written });
          editorDispatch({ type: "saved", path, text: written });
        } catch (e) {
          editorDispatch({ type: "error", path, error: `Save failed: ${e}` });
        }
      },
      saveActiveFile: async () => {
        if (editor.activePath) await api.saveFile(editor.activePath);
      },
      requestCloseFile: async (path) => {
        const f = editor.files.find((x) => x.path === path);
        if (f && isDirty(f)) {
          const discard = window.confirm(
            `"${f.name}" has unsaved changes. Close without saving?`
          );
          if (!discard) return;
        }
        editorDispatch({ type: "close", path });
        // Nothing left to edit — hand the keyboard back to the terminal. The
        // flag alone only reroutes shortcuts; the terminal needs real DOM focus
        // too, or typed characters would land on <body> until a click.
        if (editor.files.length <= 1) {
          setFocusRegion("terminal");
          if (activePaneId) terminals.focus(activePaneId);
        }
      },
      closeActiveFile: async () => {
        if (editor.activePath) await api.requestCloseFile(editor.activePath);
      },
    }),
    [
      state,
      activeTabId,
      activePaneId,
      sidebarOpen,
      projectRoot,
      projectRootMap,
      sidebarView,
      searchNonce,
      reveal,
      editor,
      focusRegion,
      settings,
      gitChangesCount,
      setGitChangesCount,
    ]
  );

  return <StoreContext.Provider value={api}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreApi {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}
