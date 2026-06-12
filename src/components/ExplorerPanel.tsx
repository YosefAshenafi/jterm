import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useStore } from "../state/store";
import { terminals } from "../terminal/manager";
import { basename, resolveCwd, shellQuote } from "../workspace";
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
        // Act on click so Enter/Space work too; swallowing pointerdown keeps
        // mouse clicks from stealing focus away from the terminal.
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
  const { projectRoot, activePaneId, openFile, editor } = useStore();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [refreshKey, setRefreshKey] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: Entry } | null>(null);
  const [fallbackRoot, setFallbackRoot] = useState<string | null>(null);
  const activePath = editor.activePath;

  // Until the store has a project root (e.g. the sidebar was just peeked open),
  // scope the tree to the active terminal's working directory so it shows the
  // current folder rather than "No folder open".
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

  // Reveal the active file like VS Code: expand the folders that lead to it.
  useEffect(() => {
    if (!activePath || !root) return;
    const base = root.replace(/[\\/]+$/, "");
    if (activePath !== base && !activePath.startsWith(base + "/")) return;
    const parts = activePath.slice(base.length).replace(/^[\\/]+/, "").split("/");
    parts.pop(); // drop the filename — only expand its directories
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

  // Scroll the highlighted row into view once it (and its lazily-loaded parent
  // folders) have rendered.
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
    // "\r" mirrors a real Enter keypress: Unix line discipline maps CR to NL
    // on input, and Windows ConPTY only executes the line on CR — not LF.
    onCd: (path) => activePaneId && terminals.sendText(activePaneId, `cd ${shellQuote(path)}\r`),
    onMenu: (e, entry) => {
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, entry });
    },
  };

  // Right-click actions for a file/folder. "Copy Path" puts the raw path on the
  // system clipboard (ready for ⌘V anywhere); "Paste to Terminal" types the
  // shell-quoted path straight into the focused terminal, ready to run.
  const menuItems = (entry: Entry): MenuItem[] => {
    const items: MenuItem[] = entry.is_dir
      ? [{ label: "Open in Terminal (cd)", disabled: !activePaneId, onClick: () => ctx.onCd(entry.path) }]
      : [{ label: "Open", onClick: () => openFile(entry.path) }];
    items.push(
      { label: "Copy Path", onClick: () => void writeText(entry.path) },
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
          items={menuItems(menu.entry)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
