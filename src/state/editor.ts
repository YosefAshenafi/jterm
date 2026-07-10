export interface FileBuffer {
  path: string;
  name: string;
  /** Last content read from / written to disk; null until the read resolves. */
  saved: string | null;
  /** Current editor content; differs from `saved` when the buffer is dirty. */
  draft: string;
  loading: boolean;
  /** Load or save failure message, if any. */
  error: string | null;
  /** True = render as a coloured diff view instead of a textarea. */
  diff: boolean;
  /** Set for image files: rendered as a preview (`imageSrc` data URL) not text. */
  image?: boolean;
  imageSrc?: string;
  /** Unsaved draft carried over from the previous session, re-applied once the
   * disk read lands (unless the disk already matches it). */
  pendingDraft?: string;
}

export interface EditorState {
  /** Open buffers, in tab order. */
  files: FileBuffer[];
  activePath: string | null;
}

export const emptyEditor: EditorState = { files: [], activePath: null };

/** A buffer recreated from a saved session: its content re-reads from disk
 * when the tab is next shown, and a dirty `draft` from the previous run is
 * re-applied on top once the read lands. */
export function restoredBuffer(path: string, name: string, draft?: string): FileBuffer {
  return {
    path,
    name,
    saved: null,
    draft: draft ?? "",
    loading: true,
    error: null,
    diff: false,
    pendingDraft: draft,
  };
}

export type EditorAction =
  | { type: "open"; path: string; name: string }
  | { type: "open-diff"; path: string; name: string; content: string }
  | { type: "loaded"; path: string; text: string }
  | { type: "image-loaded"; path: string; src: string }
  | { type: "edit"; path: string; draft: string }
  | { type: "saved"; path: string; text: string }
  | { type: "error"; path: string; error: string }
  | { type: "select"; path: string }
  | { type: "rename-path"; from: string; to: string }
  | { type: "close"; path: string }
  | { type: "show-terminal" };

/** A buffer is dirty once its draft diverges from the saved contents. */
export function isDirty(f: FileBuffer): boolean {
  return f.saved !== null && f.draft !== f.saved;
}

function patch(state: EditorState, path: string, p: Partial<FileBuffer>): EditorState {
  return {
    ...state,
    files: state.files.map((f) => (f.path === path ? { ...f, ...p } : f)),
  };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "open": {
      if (state.files.some((f) => f.path === action.path)) {
        return { ...state, activePath: action.path };
      }
      const file: FileBuffer = {
        path: action.path,
        name: action.name,
        saved: null,
        draft: "",
        loading: true,
        error: null,
        diff: false,
      };
      return { files: [...state.files, file], activePath: action.path };
    }
    case "open-diff": {
      const file: FileBuffer = {
        path: action.path,
        name: action.name,
        saved: action.content,
        draft: action.content,
        loading: false,
        error: null,
        diff: true,
      };
      if (state.files.some((f) => f.path === action.path)) {
        return {
          ...state,
          files: state.files.map((f) =>
            f.path === action.path ? { ...file, diff: true, loading: false } : f
          ),
          activePath: action.path,
        };
      }
      return { files: [...state.files, file], activePath: action.path };
    }
    case "loaded": {
      const prev = state.files.find((f) => f.path === action.path);
      // A restored dirty draft survives the reload; if the disk caught up with
      // it (saved elsewhere before the restart) the buffer opens clean.
      const draft =
        prev?.pendingDraft != null && prev.pendingDraft !== action.text
          ? prev.pendingDraft
          : action.text;
      return patch(state, action.path, {
        saved: action.text,
        draft,
        loading: false,
        error: null,
        diff: false,
        pendingDraft: undefined,
      });
    }
    case "image-loaded":
      return patch(state, action.path, {
        saved: "",
        draft: "",
        loading: false,
        error: null,
        diff: false,
        image: true,
        imageSrc: action.src,
        pendingDraft: undefined,
      });
    case "edit":
      return patch(state, action.path, { draft: action.draft, error: null, diff: false });
    case "saved":
      return patch(state, action.path, { saved: action.text, error: null });
    case "error":
      return patch(state, action.path, { loading: false, error: action.error });
    case "select":
      return state.files.some((f) => f.path === action.path)
        ? { ...state, activePath: action.path }
        : state;
    case "rename-path": {
      // Re-key buffers under a renamed file/folder so tabs — dirty drafts
      // included — survive an explorer rename instead of pointing at a path
      // that no longer exists. A folder rename re-keys everything inside it.
      const remap = (p: string) =>
        p === action.from || p.startsWith(action.from + "/") || p.startsWith(action.from + "\\")
          ? action.to + p.slice(action.from.length)
          : p;
      let changed = false;
      const files = state.files.map((f) => {
        const path = remap(f.path);
        if (path === f.path) return f;
        changed = true;
        return { ...f, path, name: path.split(/[\\/]/).pop() ?? path };
      });
      if (!changed) return state;
      const activePath = state.activePath === null ? null : remap(state.activePath);
      return { files, activePath };
    }
    case "show-terminal":
      return state.activePath === null ? state : { ...state, activePath: null };
    case "close": {
      const idx = state.files.findIndex((f) => f.path === action.path);
      if (idx === -1) return state;
      const files = state.files.filter((f) => f.path !== action.path);
      let activePath = state.activePath;
      if (activePath === action.path) {
        activePath = files.length ? files[Math.min(idx, files.length - 1)].path : null;
      }
      return { files, activePath };
    }
    default:
      return state;
  }
}

export type EditorMap = Record<string, EditorState>;

export type EditorMapAction =
  | (EditorAction & { tabId: string })
  | { type: "prune"; ids: Set<string> };

export function editorMapReducer(state: EditorMap, action: EditorMapAction): EditorMap {
  if (action.type === "prune") {
    let changed = false;
    const next: EditorMap = {};
    for (const id of Object.keys(state)) {
      if (action.ids.has(id)) next[id] = state[id];
      else changed = true;
    }
    return changed ? next : state;
  }
  const current = state[action.tabId] ?? emptyEditor;
  const updated = editorReducer(current, action);
  return updated === current ? state : { ...state, [action.tabId]: updated };
}
