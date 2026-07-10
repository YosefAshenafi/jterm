import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useStore } from "../state/store";
import { terminals } from "../terminal/manager";
import { isMac } from "../platform";
import { basename, dirname, resolveCwd, shellQuote } from "../workspace";
import { ConfirmDialog } from "./ConfirmDialog";
import { ContextMenu, MenuItem } from "./ContextMenu";
import {
  ChevronIcon,
  CollapseAllIcon,
  FileIcon,
  FolderIcon,
  NewFileIcon,
  NewFolderIcon,
  SyncIcon,
} from "./icons";

interface Entry {
  name: string;
  path: string;
  is_dir: boolean;
}

/** A pending "New File"/"New Folder": an inline input rendered inside
 * `parentDir`'s row list until the user names it or presses Escape. */
interface Creating {
  parentDir: string;
  kind: "file" | "folder";
}

/** Where a "New File"/"New Folder" lands relative to an entry: inside a folder,
 * or alongside a file in its own folder — matching VS Code. */
function createDirFor(entry: Entry): string {
  return entry.is_dir ? entry.path : dirname(entry.path);
}

/** Join a directory and a (possibly nested, e.g. "a/b") child name. Forward
 * slashes work for `std::fs` on every platform, so we don't special-case "\". */
function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, "")}/${name.replace(/^[\\/]+/, "")}`;
}

/** Paths the user "Copy"d in the tree, kept in-app so Copy → Paste works the
 * same on every platform without round-tripping through the OS clipboard. */
let fileClipboard: string[] = [];
/** The OS clipboard's change id when `fileClipboard` was set. Lets Paste tell
 * whether the system clipboard has been updated since (a Finder copy), so the
 * more recent of the two wins. */
let fileClipboardCount = -1;

/** Path being dragged in the tree (HTML5 DataTransfer is unreliable in Tauri
 * webviews, so we track it ourselves). */
let dragSourcePath: string | null = null;

const REVEAL_LABEL = isMac ? "Reveal in Finder" : "Reveal in File Explorer";

/** Whether the pointer is over the Explorer. The tree never takes keyboard
 * focus (clicking a row leaves the terminal focused), so hover is what decides
 * whether the copy/paste chord targets the tree or the terminal. */
export function explorerHovered(): boolean {
  return !!document.querySelector(".explorer-panel:hover");
}

/** Mark a path for pasting and remember where the OS clipboard stood, so a later
 * Finder copy is recognised as newer. */
async function copyEntry(path: string) {
  fileClipboard = [path];
  fileClipboardCount = await invoke<number>("clipboard_change_count").catch(() => fileClipboardCount);
}

/** What a Paste would copy. The in-app "Copy" wins only while the OS clipboard
 * hasn't advanced past it; once the user copies anything elsewhere (e.g. files
 * in Finder), that newer copy takes over. */
async function resolvePasteSources(): Promise<string[]> {
  const [systemPaths, count] = await Promise.all([
    invoke<string[]>("clipboard_file_paths").catch(() => [] as string[]),
    invoke<number>("clipboard_change_count").catch(() => fileClipboardCount),
  ]);
  if (fileClipboard.length && count === fileClipboardCount) return fileClipboard;
  return systemPaths;
}

/** Shared callbacks + controlled expansion state threaded through the tree. */
interface ExplorerCtx {
  expanded: Set<string>;
  /** Path of the file currently open in the editor (highlighted in the tree). */
  activePath: string | null;
  /** Path of the last-clicked row — where the toolbar's New File/Folder lands. */
  selected: string | null;
  /** A pending inline create, rendered inside its `parentDir`. */
  creating: Creating | null;
  /** Path of the entry being renamed in place, if any. */
  renaming: string | null;
  /** Path of a folder being hovered as a drag-and-drop target, or null. */
  dropTarget: string | null;
  moveEntries: (sources: string[], destDir: string) => void;
  toggle: (path: string) => void;
  onFile: (path: string) => void;
  onCd: (path: string) => void;
  onMenu: (e: React.MouseEvent, entry: Entry) => void;
  select: (entry: Entry) => void;
  setDropTarget: (path: string | null) => void;
  submitCreate: (name: string) => void;
  cancelCreate: () => void;
  submitRename: (name: string) => void;
  cancelRename: () => void;
}

function indentStyle(depth: number) {
  return { paddingLeft: 8 + depth * 12 };
}

/** The inline name box for a new file/folder. Commits on Enter or blur, cancels
 * on Escape; an empty name just cancels. */
function CreateRow({
  depth,
  kind,
  onSubmit,
  onCancel,
}: {
  depth: number;
  kind: "file" | "folder";
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  // Enter blurs the input, so guard against committing twice.
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onSubmit(ref.current?.value ?? "");
    else onCancel();
  };
  return (
    <div className="tree-row tree-create-row" style={indentStyle(depth)}>
      <span className="tree-chevron-spacer" />
      {kind === "folder" ? (
        <FolderIcon className="tree-icon folder" />
      ) : (
        <FileIcon className="tree-icon file" />
      )}
      <input
        ref={ref}
        className="tree-create-input"
        spellCheck={false}
        autoComplete="off"
        placeholder={kind === "folder" ? "folder name" : "file name"}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            finish(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            finish(false);
          }
        }}
        onBlur={() => finish(true)}
      />
    </div>
  );
}

/** The inline rename box shown in place of an entry's row. Pre-filled with the
 * current name — stem selected so typing replaces the name but keeps the
 * extension, like VS Code. Commits on Enter or blur, cancels on Escape. */
function RenameRow({
  entry,
  depth,
  open,
  onSubmit,
  onCancel,
}: {
  entry: Entry;
  depth: number;
  /** Whether a folder being renamed is currently expanded (keeps its chevron). */
  open: boolean;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  // Enter blurs the input, so guard against committing twice.
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = entry.is_dir ? -1 : entry.name.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
  }, [entry]);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onSubmit(ref.current?.value ?? "");
    else onCancel();
  };
  return (
    <div className="tree-row tree-create-row" style={indentStyle(depth)}>
      {entry.is_dir ? (
        <ChevronIcon className={`tree-chevron${open ? " open" : ""}`} />
      ) : (
        <span className="tree-chevron-spacer" />
      )}
      {entry.is_dir ? (
        <FolderIcon className="tree-icon folder" />
      ) : (
        <FileIcon className="tree-icon file" />
      )}
      <input
        ref={ref}
        className="tree-create-input"
        spellCheck={false}
        autoComplete="off"
        defaultValue={entry.name}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            finish(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            finish(false);
          }
        }}
        onBlur={() => finish(true)}
      />
    </div>
  );
}

function DirChildren({ path, depth, ctx }: { path: string; depth: number; ctx: ExplorerCtx }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setEntries(null);
    setError(null);
    invoke<Entry[]>("read_dir", { path })
      .then((e) => alive && setEntries(e))
      .catch((err) => alive && setError(String(err)));
    return () => {
      alive = false;
    };
  }, [path]);

  const creatingHere =
    ctx.creating && ctx.creating.parentDir === path ? ctx.creating : null;
  const createRow = creatingHere ? (
    <CreateRow
      depth={depth}
      kind={creatingHere.kind}
      onSubmit={ctx.submitCreate}
      onCancel={ctx.cancelCreate}
    />
  ) : null;

  if (error)
    return (
      <>
        {createRow}
        <div className="tree-note" style={indentStyle(depth)}>⚠ {error}</div>
      </>
    );
  if (!entries)
    return (
      <>
        {createRow}
        {!createRow && <div className="tree-note" style={indentStyle(depth)}>…</div>}
      </>
    );

  return (
    <>
      {createRow}
      {entries.length === 0 && !createRow && (
        <div className="tree-note" style={indentStyle(depth)}>(empty)</div>
      )}
      {entries.map((entry) => (
        <EntryRow key={entry.path} entry={entry} depth={depth} ctx={ctx} />
      ))}
    </>
  );
}

function EntryRow({ entry, depth, ctx }: { entry: Entry; depth: number; ctx: ExplorerCtx }) {
  const selected = entry.path === ctx.selected;
  const renaming = entry.path === ctx.renaming;
  const isDropTarget = ctx.dropTarget === entry.path;

  const handleDragStart = (e: React.DragEvent) => {
    dragSourcePath = entry.path;
    e.dataTransfer.setData("text/plain", entry.path);
    e.dataTransfer.effectAllowed = "move";
    // Required so the browser shows a drag image instead of a "no-drop" cursor.
    e.dataTransfer.dropEffect = "move";
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    // Allow default on draggable rows so the browser can detect the drag gesture
    // (preventDefault on pointerdown breaks HTML5 drag initiation).
    if ((e.currentTarget as HTMLElement).draggable) return;
    e.preventDefault();
  };

  if (!entry.is_dir) {
    if (renaming) {
      return (
        <RenameRow
          entry={entry}
          depth={depth}
          open={false}
          onSubmit={ctx.submitRename}
          onCancel={ctx.cancelRename}
        />
      );
    }
    const active = entry.path === ctx.activePath;
    return (
      <button
        className={`tree-row${selected ? " tree-row-selected" : ""}${active ? " tree-row-active" : ""}`}
        style={indentStyle(depth)}
        title={entry.path}
        draggable={!renaming}
        onPointerDown={handlePointerDown}
        onClick={() => {
          ctx.select(entry);
          ctx.onFile(entry.path);
        }}
        onContextMenu={(e) => ctx.onMenu(e, entry)}
        onDragStart={handleDragStart}
      >
        <span className="tree-chevron-spacer" />
        <FileIcon className="tree-icon file" />
        <span className="tree-label">{entry.name}</span>
      </button>
    );
  }

  const open = ctx.expanded.has(entry.path);
  return (
    <>
      {renaming ? (
        <RenameRow
          entry={entry}
          depth={depth}
          open={open}
          onSubmit={ctx.submitRename}
          onCancel={ctx.cancelRename}
        />
      ) : (
        <button
          className={`tree-row${selected ? " tree-row-selected" : ""}${isDropTarget ? " tree-drop-target" : ""}`}
          style={indentStyle(depth)}
          title={`${entry.path}  ·  double-click to cd`}
          draggable={!renaming}
          onPointerDown={handlePointerDown}
          onClick={() => {
            ctx.select(entry);
            ctx.toggle(entry.path);
          }}
          onDoubleClick={() => ctx.onCd(entry.path)}
          onContextMenu={(e) => ctx.onMenu(e, entry)}
          onDragStart={handleDragStart}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move"; }}
          onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move"; ctx.setDropTarget(entry.path); }}
          onDragLeave={(e) => {
            e.stopPropagation();
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              ctx.setDropTarget(null);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            ctx.setDropTarget(null);
            const src = dragSourcePath;
            dragSourcePath = null;
            if (src && src !== entry.path) {
              void ctx.moveEntries([src], entry.path);
            }
          }}
        >
          <ChevronIcon className={`tree-chevron${open ? " open" : ""}`} />
          <FolderIcon className="tree-icon folder" />
          <span className="tree-label">{entry.name}</span>
        </button>
      )}
      {open && <DirChildren path={entry.path} depth={depth + 1} ctx={ctx} />}
    </>
  );
}

/** File-tree view: click a file to open it, double-click a folder to `cd`,
 * single-click a folder to expand/collapse. "Collapse all" folds every folder. */
export function ExplorerPanel() {
  const {
    projectRoot,
    activePaneId,
    activePanelTerminal,
    openFile,
    requestCloseFile,
    renameOpenFiles,
    editor,
    showToast,
  } = useStore();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [refreshKey, setRefreshKey] = useState(0);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    entry: Entry;
    /** Paths available to paste, resolved when the menu opened. */
    pasteSources: string[];
  } | null>(null);
  const [fallbackRoot, setFallbackRoot] = useState<string | null>(null);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [creating, setCreating] = useState<Creating | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    message: string;
    run: () => void;
  } | null>(null);
  const activePath = editor.activePath;

  useEffect(() => {
    if (projectRoot) {
      setFallbackRoot(null);
      return;
    }
    let alive = true;
    resolveCwd(activePaneId).then((cwd) => alive && setFallbackRoot(cwd));
    return () => {
      alive = false;
    };
  }, [projectRoot, activePaneId]);
  const root = projectRoot ?? fallbackRoot;

  useEffect(() => {
    if (!activePath || !root) return;
    const base = root.replace(/[\\/]+$/, "");
    if (activePath !== base && !activePath.startsWith(base + "/")) return;
    const parts = activePath.slice(base.length).replace(/^[\\/]+/, "").split("/");
    parts.pop();
    const ancestors: string[] = [];
    let cur = base;
    for (const p of parts) {
      cur = `${cur}/${p}`;
      ancestors.push(cur);
    }
    if (ancestors.length === 0) return;
    setExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      ancestors.forEach((a) => {
        if (!next.has(a)) {
          next.add(a);
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [activePath, root]);

  useEffect(() => {
    if (!activePath) return;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tryScroll = () => {
      const el = document.querySelector(".tree-row-active");
      if (el) {
        (el as HTMLElement).scrollIntoView({ block: "nearest" });
        return;
      }
      if (tries++ < 25) timer = setTimeout(tryScroll, 70);
    };
    tryScroll();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [activePath, expanded]);

  /** Open the inline name box for a new file/folder inside `targetDir`. */
  const beginCreate = (kind: "file" | "folder", targetDir: string) => {
    setExpanded((prev) => new Set(prev).add(targetDir));
    setCreating({ parentDir: targetDir, kind });
  };

  /** Create the named file/folder, then refresh so it shows; new files open. */
  const submitCreate = async (rawName: string) => {
    const c = creating;
    setCreating(null);
    if (!c) return;
    const name = rawName.trim().replace(/^[\\/]+|[\\/]+$/g, "");
    if (!name) return;
    const path = joinPath(c.parentDir, name);
    try {
      await invoke(c.kind === "folder" ? "create_dir" : "create_file", { path });
      setExpanded((prev) => new Set(prev).add(c.parentDir));
      setRefreshKey((k) => k + 1);
      if (c.kind === "file") openFile(path);
      showToast(`Created ${basename(path)}`);
    } catch (err) {
      showToast(`Could not create: ${err}`);
    }
  };

  /** Rename the entry on disk, then re-key everything that referenced the old
   * path — expanded folders, the selection, and open editor tabs. */
  const submitRename = async (rawName: string) => {
    const path = renaming;
    setRenaming(null);
    if (!path) return;
    const name = rawName.trim();
    const oldName = basename(path);
    if (!name || name === oldName) return;
    try {
      const newPath = await invoke<string>("rename_entry", { path, newName: name });
      const remap = (p: string) =>
        p === path || p.startsWith(path + "/") || p.startsWith(path + "\\")
          ? newPath + p.slice(path.length)
          : p;
      setExpanded((prev) => new Set([...prev].map(remap)));
      setSelected((s) => {
        if (!s) return s;
        const p = remap(s.path);
        return p === s.path ? s : { ...s, path: p, name: basename(p) };
      });
      renameOpenFiles(path, newPath);
      setRefreshKey((k) => k + 1);
      showToast(`Renamed ${oldName} to ${basename(newPath)}`);
    } catch (err) {
      showToast(`Rename failed: ${err}`);
    }
  };

  /** Copy `sources` into `destDir`, then refresh the tree so they appear. */
  const doPaste = async (sources: string[], destDir: string) => {
    try {
      const created = await invoke<string[]>("copy_entries", { sources, destDir });
      setExpanded((prev) => new Set(prev).add(destDir));
      setRefreshKey((k) => k + 1);
      const n = created.length;
      showToast(`Pasted ${n} item${n === 1 ? "" : "s"} into ${basename(destDir)}`);
    } catch (err) {
      showToast(`Paste failed: ${err}`);
    }
  };

  /** Move `sources` into `destDir` (drag-and-drop). */
  const doMove = async (sources: string[], destDir: string) => {
    try {
      const moved = await invoke<string[]>("move_entries", { sources, destDir });
      setExpanded((prev) => new Set(prev).add(destDir));
      setRefreshKey((k) => k + 1);
      const n = moved.length;
      showToast(`Moved ${n} item${n === 1 ? "" : "s"} to ${basename(destDir)}`);
    } catch (err) {
      showToast(`Move failed: ${err}`);
    }
  };

  const ctx: ExplorerCtx = {
    expanded,
    activePath,
    selected: selected?.path ?? null,
    creating,
    renaming,
    dropTarget,
    setDropTarget,
    moveEntries: doMove,
    toggle: (path) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        next.has(path) ? next.delete(path) : next.add(path);
        return next;
      }),
    onFile: (path) => openFile(path),
    onCd: (path) => activePaneId && terminals.sendText(activePaneId, `cd ${shellQuote(path)}\r`),
    onMenu: async (e, entry) => {
      e.preventDefault();
      // Keep the event off the panel body so its root menu doesn't also fire.
      e.stopPropagation();
      setSelected(entry);
      const { clientX: x, clientY: y } = e;
      const pasteSources = await resolvePasteSources();
      setMenu({ x, y, entry, pasteSources });
    },
    select: (entry) => setSelected(entry),
    submitCreate,
    cancelCreate: () => setCreating(null),
    submitRename,
    cancelRename: () => setRenaming(null),
  };

  /** Right-clicking the explorer background (or the header title) targets the
   * project root itself, so you can paste into / reveal / cd the root too. */
  const onRootMenu = (e: React.MouseEvent) => {
    if (!root) return;
    ctx.onMenu(e, { name: basename(root), path: root, is_dir: true });
  };

  /** Delete `entry` from disk, closing any open editor tab it covered, then
   * refresh the tree. Wrapped in a confirmation by `requestDelete`. */
  const doDelete = async (entry: Entry) => {
    try {
      await invoke("delete_entry", { path: entry.path });
      const base = entry.path.replace(/[\\/]+$/, "");
      editor.files.forEach((f) => {
        if (f.path === base || f.path.startsWith(base + "/") || f.path.startsWith(base + "\\")) {
          void requestCloseFile(f.path);
        }
      });
      setSelected((s) => (s?.path === entry.path ? null : s));
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(entry.path);
        return next;
      });
      setRefreshKey((k) => k + 1);
      showToast(`Deleted ${entry.name}`);
    } catch (err) {
      showToast(`Delete failed: ${err}`);
    }
  };

  const requestDelete = (entry: Entry) =>
    setConfirm({
      title: `Delete ${entry.is_dir ? "folder" : "file"}`,
      message: entry.is_dir
        ? `Delete the folder “${entry.name}” and everything inside it? This cannot be undone.`
        : `Delete the file “${entry.name}”? This cannot be undone.`,
      run: () => void doDelete(entry),
    });

  const menuItems = (menu: { entry: Entry; pasteSources: string[] }): MenuItem[] => {
    const { entry, pasteSources } = menu;
    // Pasting onto a folder drops files inside it; onto a file, into its folder.
    const pasteDir = entry.is_dir ? entry.path : dirname(entry.path);
    const newDir = createDirFor(entry);
    const count = pasteSources.length;
    const isRoot = !!root && entry.path === root;
    const items: MenuItem[] = entry.is_dir
      ? [{ label: "Open in Terminal (cd)", disabled: !activePaneId, onClick: () => ctx.onCd(entry.path) }]
      : [{ label: "Open", onClick: () => openFile(entry.path) }];
    items.push(
      { label: "New File…", separator: true, onClick: () => beginCreate("file", newDir) },
      { label: "New Folder…", onClick: () => beginCreate("folder", newDir) },
      { label: REVEAL_LABEL, separator: true, onClick: () => void revealItemInDir(entry.path) },
      { label: "Copy", separator: true, onClick: () => void copyEntry(entry.path) },
      {
        label: count > 1 ? `Paste ${count} Items` : "Paste",
        disabled: count === 0 || !pasteDir,
        onClick: () => void doPaste(pasteSources, pasteDir),
      },
      { label: "Copy Path", separator: true, onClick: () => void writeText(entry.path) },
      { label: "Copy Name", onClick: () => void writeText(entry.name) },
      {
        label: "Paste to Terminal",
        disabled: !activePaneId,
        onClick: () =>
          activePaneId && terminals.sendText(activePaneId, `${shellQuote(entry.path)} `),
      }
    );
    if (!isRoot) {
      items.push(
        { label: "Rename…", separator: true, onClick: () => setRenaming(entry.path) },
        { label: "Delete", danger: true, onClick: () => requestDelete(entry) }
      );
    }
    return items;
  };

  // Where the toolbar's New File/Folder lands: inside the selected folder (or a
  // selected file's folder), else the project root — VS Code's behaviour.
  const createTarget = selected ? createDirFor(selected) : root;
  const createTargetName = createTarget ? basename(createTarget) : null;

  // ⌘C / ⌘V while the pointer is over the Explorer: copy the selected entry,
  // paste into `createTarget` — same sources and destination rules as the
  // context menu, including files copied in Finder. Kept in a ref so the
  // window listener registers once but always sees the latest state.
  const hotkey = useRef<(e: KeyboardEvent) => void>(() => {});
  hotkey.current = (e) => {
    const t = e.target as HTMLElement | null;
    // Typing in the editor or a text field keeps its native copy/paste.
    const inTerminal = !!t?.closest(".terminal-host");
    if (!inTerminal && (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA")) return;
    // Delete / Backspace while the pointer is over the explorer: delete selected.
    if ((e.key === "Backspace" || e.key === "Delete") && explorerHovered()) {
      if (!selected) return;
      e.preventDefault();
      requestDelete(selected);
      return;
    }
    const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && e.shiftKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if ((k !== "c" && k !== "v") || !explorerHovered()) return;
    if (k === "c") {
      // Selected text — in the terminal or elsewhere — outranks the tree.
      const termId = t?.closest(".term-panel") ? activePanelTerminal : activePaneId;
      if (termId && terminals.getSelection(termId)) return;
      if (window.getSelection()?.toString()) return;
      if (!selected) return;
      e.preventDefault();
      const { name, path } = selected;
      void copyEntry(path).then(() => showToast(`Copied ${name}`));
    } else if (createTarget) {
      e.preventDefault();
      const dest = createTarget;
      void resolvePasteSources().then((sources) => {
        if (sources.length) void doPaste(sources, dest);
        else showToast("Nothing to paste");
      });
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => hotkey.current(e);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Toggle a body class during file drags so the cursor becomes a move/copy
  // pointer everywhere, not just over the tree rows.
  useEffect(() => {
    const onStart = () => {
      if (!dragSourcePath) return;
      document.body.classList.add("file-dragging");
    };
    const onEnd = () => {
      dragSourcePath = null;
      document.body.classList.remove("file-dragging");
    };
    window.addEventListener("dragstart", onStart, true);
    window.addEventListener("dragend", onEnd, true);
    return () => {
      window.removeEventListener("dragstart", onStart, true);
      window.removeEventListener("dragend", onEnd, true);
      document.body.classList.remove("file-dragging");
    };
  }, []);

  return (
    <div className="panel explorer-panel">
      <div className="panel-header">
        <span
          className="panel-title"
          title={root ?? undefined}
          onContextMenu={onRootMenu}
        >
          {root ? basename(root) : "Explorer"}
        </span>
        <div className="panel-actions">
          <button
            className="tool-btn icon-btn small"
            title={createTargetName ? `New file in ${createTargetName}` : "New file"}
            aria-label="New file"
            disabled={!createTarget}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => createTarget && beginCreate("file", createTarget)}
          >
            <NewFileIcon />
          </button>
          <button
            className="tool-btn icon-btn small"
            title={createTargetName ? `New folder in ${createTargetName}` : "New folder"}
            aria-label="New folder"
            disabled={!createTarget}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => createTarget && beginCreate("folder", createTarget)}
          >
            <NewFolderIcon />
          </button>
          <button
            className="tool-btn icon-btn small"
            title="Collapse all folders"
            aria-label="Collapse all folders"
            disabled={expanded.size === 0}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => setExpanded(new Set())}
          >
            <CollapseAllIcon />
          </button>
          <button
            className="tool-btn icon-btn small"
            title="Refresh"
            aria-label="Refresh"
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => setRefreshKey((k) => k + 1)}
          >
            <SyncIcon />
          </button>
        </div>
      </div>
      <div
        className="panel-body"
        onContextMenu={onRootMenu}
        onDragOver={(e) => { if (root) { e.preventDefault(); } }}
        onDrop={(e) => {
          if (!root) return;
          e.preventDefault();
          setDropTarget(null);
          const src = dragSourcePath;
          dragSourcePath = null;
          if (src && src !== root) {
            void doMove([src], root);
          }
        }}
      >
        {root ? (
          <DirChildren key={`${root}:${refreshKey}`} path={root} depth={0} ctx={ctx} />
        ) : (
          <div className="tree-note">Resolving folder…</div>
        )}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu)}
          onClose={() => setMenu(null)}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            confirm.run();
            setConfirm(null);
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
