import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useStore } from "../state/store";
import { terminals } from "../terminal/manager";
import { isMac } from "../platform";
import { basename, dirname, resolveCwd, shellQuote } from "../workspace";
import { ContextMenu, MenuItem } from "./ContextMenu";
import {
  ChevronIcon,
  CollapseAllIcon,
  FileIcon,
  FolderIcon,
  SyncIcon,
} from "./icons";

interface Entry {
  name: string;
  path: string;
  is_dir: boolean;
}

/** Paths the user "Copy"d in the tree, kept in-app so Copy → Paste works the
 * same on every platform without round-tripping through the OS clipboard. */
let fileClipboard: string[] = [];
/** The OS clipboard's change id when `fileClipboard` was set. Lets Paste tell
 * whether the system clipboard has been updated since (a Finder copy), so the
 * more recent of the two wins. */
let fileClipboardCount = -1;

const REVEAL_LABEL = isMac ? "Reveal in Finder" : "Reveal in File Explorer";

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
  toggle: (path: string) => void;
  onFile: (path: string) => void;
  onCd: (path: string) => void;
  onMenu: (e: React.MouseEvent, entry: Entry) => void;
}

function indentStyle(depth: number) {
  return { paddingLeft: 8 + depth * 12 };
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

  if (error) return <div className="tree-note" style={indentStyle(depth)}>⚠ {error}</div>;
  if (!entries) return <div className="tree-note" style={indentStyle(depth)}>…</div>;
  if (entries.length === 0) return <div className="tree-note" style={indentStyle(depth)}>(empty)</div>;

  return (
    <>
      {entries.map((entry) => (
        <EntryRow key={entry.path} entry={entry} depth={depth} ctx={ctx} />
      ))}
    </>
  );
}

function EntryRow({ entry, depth, ctx }: { entry: Entry; depth: number; ctx: ExplorerCtx }) {
  if (!entry.is_dir) {
    const active = entry.path === ctx.activePath;
    return (
      <button
        className={`tree-row${active ? " tree-row-active" : ""}`}
        style={indentStyle(depth)}
        title={entry.path}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => ctx.onFile(entry.path)}
        onContextMenu={(e) => ctx.onMenu(e, entry)}
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
      <button
        className="tree-row"
        style={indentStyle(depth)}
        title={`${entry.path}  ·  double-click to cd`}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => ctx.toggle(entry.path)}
        onDoubleClick={() => ctx.onCd(entry.path)}
        onContextMenu={(e) => ctx.onMenu(e, entry)}
      >
        <ChevronIcon className={`tree-chevron${open ? " open" : ""}`} />
        <FolderIcon className="tree-icon folder" />
        <span className="tree-label">{entry.name}</span>
      </button>
      {open && <DirChildren path={entry.path} depth={depth + 1} ctx={ctx} />}
    </>
  );
}

/** File-tree view: click a file to open it, double-click a folder to `cd`,
 * single-click a folder to expand/collapse. "Collapse all" folds every folder. */
export function ExplorerPanel() {
  const { projectRoot, activePaneId, openFile, editor, showToast } = useStore();
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

  const ctx: ExplorerCtx = {
    expanded,
    activePath,
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
      const { clientX: x, clientY: y } = e;
      const pasteSources = await resolvePasteSources();
      setMenu({ x, y, entry, pasteSources });
    },
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

  const menuItems = (menu: { entry: Entry; pasteSources: string[] }): MenuItem[] => {
    const { entry, pasteSources } = menu;
    // Pasting onto a folder drops files inside it; onto a file, into its folder.
    const pasteDir = entry.is_dir ? entry.path : dirname(entry.path);
    const count = pasteSources.length;
    const items: MenuItem[] = entry.is_dir
      ? [{ label: "Open in Terminal (cd)", disabled: !activePaneId, onClick: () => ctx.onCd(entry.path) }]
      : [{ label: "Open", onClick: () => openFile(entry.path) }];
    items.push(
      { label: REVEAL_LABEL, onClick: () => void revealItemInDir(entry.path) },
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
    return items;
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title" title={root ?? undefined}>
          {root ? basename(root) : "Explorer"}
        </span>
        <div className="panel-actions">
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
      <div className="panel-body">
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
    </div>
  );
}
