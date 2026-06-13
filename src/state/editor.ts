// State for the file editor that opens beside the folder tree. Each open file
// is a buffer with the on-disk contents (`saved`) and the current editor text
// (`draft`); they differ exactly when the buffer is dirty. Buffers are global —
// independent of which terminal tab is active.

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
}

export interface EditorState {
  /** Open buffers, in tab order. */
  files: FileBuffer[];
  activePath: string | null;
}

export const emptyEditor: EditorState = { files: [], activePath: null };

export type EditorAction =
  | { type: "open"; path: string; name: string }
  | { type: "open-diff"; path: string; name: string; content: string }
  | { type: "loaded"; path: string; text: string }
  | { type: "image-loaded"; path: string; src: string }
  | { type: "edit"; path: string; draft: string }
  | { type: "saved"; path: string; text: string }
  | { type: "error"; path: string; error: string }
  | { type: "select"; path: string }
  | { type: "close"; path: string }
  // Deselect every file → the workspace shows the Terminal tab (the grid).
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
      // Re-opening an already-open file just focuses its tab.
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
    case "loaded":
      return patch(state, action.path, {
        saved: action.text,
        draft: action.text,
        loading: false,
        error: null,
        diff: false,
      });
    case "image-loaded":
      // `saved: ""` marks it loaded (not an error); images aren't editable.
      return patch(state, action.path, {
        saved: "",
        draft: "",
        loading: false,
        error: null,
        diff: false,
        image: true,
        imageSrc: action.src,
      });
    case "edit":
      return patch(state, action.path, { draft: action.draft, error: null, diff: false });
    case "saved":
      // `text` is the content that was actually written, captured before the
      // write. Stamping the *current* draft instead would mark keystrokes typed
      // during the in-flight save as saved when they never reached disk.
      return patch(state, action.path, { saved: action.text, error: null });
    case "error":
      return patch(state, action.path, { loading: false, error: action.error });
    case "select":
      return state.files.some((f) => f.path === action.path)
        ? { ...state, activePath: action.path }
        : state;
    case "show-terminal":
      return state.activePath === null ? state : { ...state, activePath: null };
    case "close": {
      const idx = state.files.findIndex((f) => f.path === action.path);
      if (idx === -1) return state;
      const files = state.files.filter((f) => f.path !== action.path);
      let activePath = state.activePath;
      if (activePath === action.path) {
        // Fall back to the neighbour that slides into this slot.
        activePath = files.length ? files[Math.min(idx, files.length - 1)].path : null;
      }
      return { files, activePath };
    }
    default:
      return state;
  }
}

// Open files are per-tab: each tab id maps to its own EditorState, so a newly
// created tab starts empty instead of inheriting another tab's open files.
export type EditorMap = Record<string, EditorState>;

export type EditorMapAction =
  | (EditorAction & { tabId: string })
  | { type: "prune"; ids: Set<string> };

export function editorMapReducer(state: EditorMap, action: EditorMapAction): EditorMap {
  // Drop entries for tabs that no longer exist.
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
