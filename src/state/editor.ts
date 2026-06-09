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
}

export interface EditorState {
  /** Open buffers, in tab order. */
  files: FileBuffer[];
  activePath: string | null;
}

export const emptyEditor: EditorState = { files: [], activePath: null };

export type EditorAction =
  | { type: "open"; path: string; name: string }
  | { type: "loaded"; path: string; text: string }
  | { type: "edit"; path: string; draft: string }
  | { type: "saved"; path: string }
  | { type: "error"; path: string; error: string }
  | { type: "select"; path: string }
  | { type: "close"; path: string };

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
      };
      return { files: [...state.files, file], activePath: action.path };
    }
    case "loaded":
      return patch(state, action.path, {
        saved: action.text,
        draft: action.text,
        loading: false,
        error: null,
      });
    case "edit":
      return patch(state, action.path, { draft: action.draft, error: null });
    case "saved": {
      const f = state.files.find((x) => x.path === action.path);
      if (!f) return state;
      return patch(state, action.path, { saved: f.draft, error: null });
    }
    case "error":
      return patch(state, action.path, { loading: false, error: action.error });
    case "select":
      return state.files.some((f) => f.path === action.path)
        ? { ...state, activePath: action.path }
        : state;
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
