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
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { terminals } from "../terminal/manager";
import {
  DEFAULT_SETTINGS,
  hexToRgba,
  loadSettings,
  saveSettings,
  Settings,
} from "./settings";
import { AppState, Direction, LeafNode, PaneNode, Tab } from "./types";
import {
  collectLeaves,
  firstLeaf,
  insertSplit,
  leafOrder,
  makeLeaf,
  newId,
  removePane,
  setSplitSizes,
  splitPane,
} from "./tree";
import { DropTarget, DropZone } from "./paneDnd";
import {
  EditorAction,
  editorMapReducer,
  EditorState,
  emptyEditor,
  isDirty,
} from "./editor";
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

/** A transient status message. When `url` is set the toast is a clickable link
 * (e.g. the newly published repository) that opens externally. */
export interface Toast {
  message: string;
  url?: string;
}

const SNAPSHOT_KEY = "jterm_tab_titles";

const SIDEBAR_WIDTH_KEY = "jterm.sidebarWidth";
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 560;
/** Persisted sidebar width, so toggling it open restores the last size. */
function loadSidebarWidth(): number {
  const v = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return v >= SIDEBAR_MIN && v <= SIDEBAR_MAX ? v : 272;
}

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
  | { type: "rename-tab"; tabId: string; title: string }
  | { type: "move-pane"; paneId: string; target: DropTarget };

const activeTab = (s: AppState): Tab | undefined =>
  s.tabs.find((t) => t.id === s.activeTabId);

function updateTab(s: AppState, tabId: string, patch: Partial<Tab>): AppState {
  return {
    ...s,
    tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t)),
  };
}

/** Which split a drop zone produces: `before` puts the dropped pane first. */
function zoneToSplit(zone: DropZone): { direction: Direction; before: boolean } {
  switch (zone) {
    case "left": return { direction: "row", before: true };
    case "right": return { direction: "row", before: false };
    case "top": return { direction: "column", before: true };
    case "bottom": return { direction: "column", before: false };
  }
}

/** Re-validate a tab against a rewritten root: keep the active/zoomed panes if
 * they still exist (preferring `preferActive`), else fall back sensibly. */
function rebindTab(tab: Tab, root: PaneNode, preferActive?: string): Partial<Tab> {
  const leaves = collectLeaves(root);
  const has = (id: string | undefined | null) => !!id && leaves.some((l) => l.id === id);
  const activePaneId = has(preferActive)
    ? (preferActive as string)
    : has(tab.activePaneId)
    ? tab.activePaneId
    : firstLeaf(root).id;
  const zoomedPaneId = has(tab.zoomedPaneId) ? tab.zoomedPaneId : null;
  return { root, activePaneId, zoomedPaneId };
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
    case "move-pane": {
      const { paneId, target } = action;
      const src = state.tabs.find((t) =>
        collectLeaves(t.root).some((l) => l.id === paneId)
      );
      if (!src) return state;
      const leaf: LeafNode = { type: "leaf", id: paneId };

      if (target.kind === "pane") {
        // Rearrange within the visible tab: drop on an edge of another pane.
        if (target.paneId === paneId) return state;
        const inSrc = collectLeaves(src.root).some((l) => l.id === target.paneId);
        if (!inSrc) return state; // only the on-screen tab's panes are targetable
        const removed = removePane(src.root, paneId);
        if (!removed) return state; // target keeps the tree non-empty
        const { direction, before } = zoneToSplit(target.zone);
        const root = insertSplit(removed, target.paneId, leaf, direction, before);
        return updateTab(state, src.id, { root, activePaneId: paneId, zoomedPaneId: null });
      }

      if (target.kind === "tab") {
        if (target.tabId === src.id) return state; // already lives here
        const dest = state.tabs.find((t) => t.id === target.tabId);
        if (!dest) return state;
        const destRoot = insertSplit(dest.root, dest.activePaneId, leaf, "row", false);
        const srcRoot = removePane(src.root, paneId);
        let tabs = state.tabs.map((t) => {
          if (t.id === dest.id) return { ...t, ...rebindTab(dest, destRoot, paneId), zoomedPaneId: null };
          if (t.id === src.id && srcRoot) return { ...t, ...rebindTab(src, srcRoot) };
          return t;
        });
        if (!srcRoot) tabs = tabs.filter((t) => t.id !== src.id); // source emptied
        return { tabs, activeTabId: dest.id };
      }

      // new-tab: detach into a fresh tab (no-op if it is the tab's only pane).
      const srcRoot = removePane(src.root, paneId);
      if (!srcRoot) return state;
      const newTab: Tab = {
        id: newId("tab"),
        title: "Terminal",
        root: leaf,
        activePaneId: paneId,
      };
      const tabs = state.tabs.map((t) =>
        t.id === src.id ? { ...t, ...rebindTab(src, srcRoot) } : t
      );
      return { tabs: [...tabs, newTab], activeTabId: newTab.id };
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
  /** Sidebar is temporarily revealed by hovering the left edge (not pinned). */
  sidebarPeek: boolean;
  setSidebarPeek(v: boolean): void;
  /** Remembered sidebar width (persists across toggles and restarts). */
  sidebarWidth: number;
  setSidebarWidth(w: number): void;
  projectRoot: string | null;
  sidebarView: SidebarView;
  /** Bumped each time the search view is (re)opened, so its input can refocus. */
  searchNonce: number;
  toggleSidebar(): void;
  /** Fully hide the sidebar: drops both the pinned-open and hover-peek state, so
   * it disappears immediately even while the pointer is still over it. */
  hideSidebar(): void;
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
  /** Move a pane to a drop target (another pane's edge, a tab, or a new tab). */
  movePane(paneId: string, target: DropTarget): void;
  // Bottom terminal panel (⌘J): VS Code-style, with its own tabs of terminals.
  panelOpen: boolean;
  /** Pane ids of the terminals living in the bottom panel, in tab order. */
  panelTerminals: string[];
  activePanelTerminal: string | null;
  togglePanel(): void;
  closePanel(): void;
  /** Add a new terminal tab to the panel (⌘⇧J / the + button). */
  addPanelTerminal(): void;
  closePanelTerminal(id: string): void;
  selectPanelTerminal(id: string): void;
  // User settings (appearance, terminal prefs).
  settings: Settings;
  updateSettings(patch: Partial<Settings>): void;
  /** Zoom a surface's font: delta +1/-1 steps, 0 resets to default. */
  zoom(surface: "editor" | "terminal", delta: number): void;
  // Editor (file viewer/editor beside the folder tree).
  editor: EditorState;
  focusRegion: FocusRegion;
  setFocusRegion(region: FocusRegion): void;
  /** Switch the workspace to the Terminal tab (the split grid). */
  showTerminalView(): void;
  /** Open a file in the editor; pass `line` (1-based) to reveal/select it. */
  openFile(path: string, line?: number): void;
  // VS Code-style quick-open / go-to-line palette and the find bar.
  paletteMode: "files" | "goto" | null;
  openQuickFiles(): void;
  openGoToLine(): void;
  closePalette(): void;
  /** Reveal/select a 1-based line in the active file. */
  goToLine(line: number): void;
  findOpen: boolean;
  openFind(): void;
  closeFind(): void;
  /** Download an http(s) URL to the Downloads folder (terminal links). */
  downloadUrl(url: string): void;
  /** Transient status message (e.g. download result); null when hidden. */
  toast: Toast | null;
  /** Show a transient toast; pass `url` to make it a clickable external link. */
  showToast(message: string, opts?: { url?: string; duration?: number }): void;
  dismissToast(): void;
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
  markFileImage(path: string, src: string): void;
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
  const [sidebarPeek, setSidebarPeek] = useState(false);
  const [sidebarWidth, setSidebarWidthState] = useState<number>(loadSidebarWidth);
  const [projectRootMap, setProjectRootMap] = useState<Record<string, string | null>>({});
  const [sidebarView, setSidebarView] = useState<SidebarView>("explorer");
  const [searchNonce, setSearchNonce] = useState(0);
  const [reveal, setReveal] = useState<RevealTarget | null>(null);
  const [editorMap, editorMapDispatch] = useReducer(editorMapReducer, {});
  const [focusRegion, setFocusRegion] = useState<FocusRegion>("terminal");
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [gitChangesCount, setGitChangesCount] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTerminals, setPanelTerminals] = useState<string[]>([]);
  const [activePanelTerminal, setActivePanelTerminal] = useState<string | null>(null);
  const [paletteMode, setPaletteMode] = useState<"files" | "goto" | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashToast = (message: string, opts?: { url?: string; duration?: number }) => {
    setToast({ message, url: opts?.url });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), opts?.duration ?? 4000);
  };

  // Apply settings to the document (CSS variables) and live terminals, and
  // persist them. Runs on mount so a saved accent/font is restored at startup.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--accent", settings.accent);
    root.style.setProperty("--pane-border", hexToRgba(settings.accent, 0.5));
    root.style.setProperty("--accent-soft", hexToRgba(settings.accent, 0.18));
    terminals.setPrefs({
      accent: settings.accent,
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      cursorStyle: settings.cursorStyle,
      cursorBlink: settings.cursorBlink,
      scrollback: settings.scrollback,
    });
    saveSettings(settings);
  }, [settings]);

  const activeTabId = state.activeTabId;
  const activePaneId =
    state.tabs.find((t) => t.id === activeTabId)?.activePaneId ?? null;
  const projectRoot = projectRootMap[activeTabId] ?? null;

  // The editor (open files) is per-tab; the active tab's buffers are what the
  // workspace renders, and `editorDispatch` always targets the active tab.
  const editor = editorMap[activeTabId] ?? emptyEditor;
  const editorDispatch = (action: EditorAction) =>
    editorMapDispatch({ ...action, tabId: activeTabId });

  // Per-tab project root: track the active pane's CWD while the sidebar is open
  // so the file tree (and search/git) scope to the current folder. Polled so a
  // `cd` in the terminal re-scopes the explorer without re-toggling it.
  useEffect(() => {
    if (!(sidebarOpen || sidebarPeek) || !activePaneId) return;
    let cancelled = false;
    const sync = () =>
      resolveCwd(activePaneId).then((cwd) => {
        if (cancelled) return;
        setProjectRootMap((prev) =>
          prev[activeTabId] === cwd ? prev : { ...prev, [activeTabId]: cwd }
        );
      });
    sync();
    const id = setInterval(sync, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [activePaneId, sidebarOpen, sidebarPeek, activeTabId]);

  // Keep the maps tidy — remove entries for closed tabs.
  useEffect(() => {
    const ids = new Set(state.tabs.map((t) => t.id));
    setProjectRootMap((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(next)) if (!ids.has(k)) delete next[k];
      return next;
    });
    editorMapDispatch({ type: "prune", ids });
  }, [state.tabs]);

  // Peek (hover-reveal) is meaningful only while the sidebar isn't pinned. Once
  // it's pinned open, drop any leftover peek so it can't linger as a stale
  // "still visible" flag — otherwise hiding the sidebar would wait for the
  // pointer to leave (the only thing that normally clears peek).
  useEffect(() => {
    if (sidebarOpen) setSidebarPeek(false);
  }, [sidebarOpen]);

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
      hideSidebar: () => {
        setSidebarOpen(false);
        setSidebarPeek(false);
      },
      setSidebarOpen,
      sidebarPeek,
      setSidebarPeek,
      sidebarWidth,
      setSidebarWidth: (w) => {
        const clamped = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w)));
        setSidebarWidthState(clamped);
        try {
          localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clamped));
        } catch {
          /* storage unavailable — width just won't persist across restarts */
        }
      },
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
      // Each tab keeps its own open files, so switching restores whatever that
      // tab was last showing — the file it was viewing, or the terminal grid.
      selectTab: (tabId) => {
        const target = editorMap[tabId] ?? emptyEditor;
        setFocusRegion(target.activePath ? "editor" : "terminal");
        dispatch({ type: "select-tab", tabId });
      },
      selectTabIndex: (index) => {
        const tab = state.tabs[index];
        const target = (tab && editorMap[tab.id]) || emptyEditor;
        setFocusRegion(target.activePath ? "editor" : "terminal");
        dispatch({ type: "select-tab-index", index });
      },
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
      movePane: (paneId, target) => dispatch({ type: "move-pane", paneId, target }),
      panelOpen,
      panelTerminals,
      activePanelTerminal,
      togglePanel: () => {
        const willOpen = !panelOpen;
        // Opening an empty panel spawns its first terminal in the active
        // terminal's directory so README commands run where the project lives.
        if (willOpen && panelTerminals.length === 0) {
          const id = newId("panel");
          terminals.setSpawnCwd(id, resolveCwd(activePaneId));
          setPanelTerminals([id]);
          setActivePanelTerminal(id);
        }
        setPanelOpen(willOpen);
      },
      closePanel: () => setPanelOpen(false),
      addPanelTerminal: () => {
        const id = newId("panel");
        terminals.setSpawnCwd(id, resolveCwd(activePaneId));
        setPanelTerminals((prev) => [...prev, id]);
        setActivePanelTerminal(id);
        setPanelOpen(true);
      },
      closePanelTerminal: (id) => {
        const idx = panelTerminals.indexOf(id);
        if (idx === -1) return;
        const next = panelTerminals.filter((x) => x !== id);
        setPanelTerminals(next);
        if (activePanelTerminal === id) {
          setActivePanelTerminal(next.length ? next[Math.min(idx, next.length - 1)] : null);
        }
        if (next.length === 0) setPanelOpen(false);
        terminals.disposePane(id);
      },
      selectPanelTerminal: (id) => {
        setActivePanelTerminal(id);
        terminals.focus(id);
      },

      settings,
      updateSettings: (patch) => setSettings((s) => ({ ...s, ...patch })),
      zoom: (surface, delta) => {
        const key = surface === "editor" ? "editorFontSize" : "fontSize";
        setSettings((s) => {
          const base = delta === 0 ? DEFAULT_SETTINGS[key] : s[key] + delta;
          return { ...s, [key]: Math.min(40, Math.max(8, base)) };
        });
      },

      editor,
      focusRegion,
      setFocusRegion,
      openDiffView: (path, content) => {
        editorDispatch({ type: "open-diff", path, name: basename(path), content });
        setFocusRegion("editor");
      },
      gitChangesCount,
      setGitChangesCount,
      showTerminalView: () => {
        editorDispatch({ type: "show-terminal" });
        setFocusRegion("terminal");
        if (activePaneId) terminals.focus(activePaneId);
      },
      openFile: (path, line) => {
        editorDispatch({ type: "open", path, name: basename(path) });
        setFocusRegion("editor");
        if (line != null) setReveal({ path, line });
      },
      paletteMode,
      openQuickFiles: () => {
        // Ensure the active tab has a resolved project root for the picker.
        if (!projectRootMap[activeTabId]) {
          resolveCwd(activePaneId).then((cwd) =>
            setProjectRootMap((prev) => ({ ...prev, [activeTabId]: cwd }))
          );
        }
        setPaletteMode("files");
      },
      openGoToLine: () => {
        if (editor.activePath) setPaletteMode("goto");
      },
      closePalette: () => setPaletteMode(null),
      goToLine: (line) => {
        if (editor.activePath) {
          setReveal({ path: editor.activePath, line });
          setFocusRegion("editor");
        }
      },
      findOpen,
      openFind: () => {
        if (editor.activePath) setFindOpen(true);
      },
      closeFind: () => setFindOpen(false),
      downloadUrl: (url) => {
        flashToast("Downloading…");
        invoke<string>("download_url", { url })
          .then((path) => flashToast(`Downloaded · ${basename(path)}`))
          .catch((e) => flashToast(`Download failed: ${e}`));
      },
      toast,
      showToast: flashToast,
      dismissToast: () => setToast(null),
      reveal,
      clearReveal: () => setReveal(null),
      selectFile: (path) => {
        editorDispatch({ type: "select", path });
        setFocusRegion("editor");
      },
      setFileDraft: (path, draft) => editorDispatch({ type: "edit", path, draft }),
      markFileLoaded: (path, text) => editorDispatch({ type: "loaded", path, text }),
      markFileImage: (path, src) => editorDispatch({ type: "image-loaded", path, src }),
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
      sidebarPeek,
      sidebarWidth,
      projectRoot,
      projectRootMap,
      sidebarView,
      searchNonce,
      reveal,
      editor,
      editorMap,
      focusRegion,
      settings,
      gitChangesCount,
      setGitChangesCount,
      panelOpen,
      panelTerminals,
      activePanelTerminal,
      paletteMode,
      findOpen,
      toast,
    ]
  );

  return <StoreContext.Provider value={api}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreApi {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}
