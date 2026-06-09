import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../state/store";
import { terminals } from "../terminal/manager";
import { basename, shellQuote } from "../workspace";
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
  toggle: (path: string) => void;
  onFile: (path: string) => void;
  onCd: (path: string) => void;
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
    return (
      <button
        className="tree-row"
        style={indentStyle(depth)}
        title={entry.path}
        // Act on click so Enter/Space work too; swallowing pointerdown keeps
        // mouse clicks from stealing focus away from the terminal.
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => ctx.onFile(entry.path)}
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
  const { projectRoot, activePaneId, openFile } = useStore();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [refreshKey, setRefreshKey] = useState(0);

  const ctx: ExplorerCtx = {
    expanded,
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
  };

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">{projectRoot ? basename(projectRoot) : "Explorer"}</span>
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
        {projectRoot ? (
          <DirChildren key={`${projectRoot}:${refreshKey}`} path={projectRoot} depth={0} ctx={ctx} />
        ) : (
          <div className="tree-note">No folder open</div>
        )}
      </div>
    </div>
  );
}
