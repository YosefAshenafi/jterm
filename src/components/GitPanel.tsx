import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../state/store";
import { basename, dirname, resolveCwd } from "../workspace";
import { ArrowUpIcon, CheckIcon, MinusIcon, PlusIcon, SyncIcon } from "./icons";

interface GitFile {
  path: string;
  x: string;
  y: string;
}
interface GitStatus {
  is_repo: boolean;
  root: string;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
}

const STATUS: Record<string, { label: string; cls: string; title: string }> = {
  M: { label: "M", cls: "git-mod", title: "Modified" },
  A: { label: "A", cls: "git-add", title: "Added" },
  D: { label: "D", cls: "git-del", title: "Deleted" },
  R: { label: "R", cls: "git-ren", title: "Renamed" },
  C: { label: "C", cls: "git-ren", title: "Copied" },
  "?": { label: "U", cls: "git-add", title: "Untracked" },
};

function StatusBadge({ code }: { code: string }) {
  const s = STATUS[code] ?? { label: code, cls: "", title: code };
  return (
    <span className={`git-badge ${s.cls}`} title={s.title}>
      {s.label}
    </span>
  );
}

// Buttons act on click so they stay keyboard-operable (and ignore right/middle
// presses); pointerdown is only suppressed so clicking never steals focus from
// the terminal.
const preserveFocus = (e: ReactPointerEvent) => e.preventDefault();

// Module scope so the row keeps a stable component identity — defined inside
// GitPanel it would remount every row (dropping focus/hover) on each
// commit-message keystroke.
function FileRow({
  file,
  code,
  staged,
  busy,
  onOpen,
  onAction,
}: {
  file: GitFile;
  code: string;
  staged: boolean;
  busy: boolean;
  onOpen: (file: string) => void;
  onAction: (file: string) => void;
}) {
  return (
    <div className="git-row">
      <button
        className="git-row-main"
        title={file.path}
        onPointerDown={preserveFocus}
        onClick={() => onOpen(file.path)}
      >
        <span className="git-row-name">{basename(file.path)}</span>
        <span className="git-row-dir">{dirname(file.path)}</span>
      </button>
      <button
        className="git-row-action"
        title={staged ? "Unstage" : "Stage"}
        aria-label={staged ? `Unstage ${file.path}` : `Stage ${file.path}`}
        disabled={busy}
        onPointerDown={preserveFocus}
        onClick={() => onAction(file.path)}
      >
        {staged ? <MinusIcon /> : <PlusIcon />}
      </button>
      <StatusBadge code={code} />
    </div>
  );
}

/** Source Control: branch, staged/unstaged changes, commit message + push. */
export function GitPanel() {
  const { activePaneId, openFile } = useStore();
  /** Directory the shown status was resolved from (the active shell's cwd). */
  const [dir, setDir] = useState<string | null>(null);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const seqRef = useRef(0);

  const refresh = useCallback(async () => {
    // Sequence guard (same role as the `alive` flags in ExplorerPanel/SearchPanel):
    // a slow git_status on a big repo can resolve after a newer one — only the
    // latest request may win.
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      // The panel always mirrors where the active terminal's shell is *right
      // now* — never a folder captured earlier. git_status itself walks up to
      // the repository root, so any subdirectory of a repo works.
      const path = await resolveCwd(activePaneId);
      const next = await invoke<GitStatus>("git_status", { path });
      if (seq !== seqRef.current) return;
      setDir(path);
      setStatus(next);
      setError(null);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(String(e));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [activePaneId]);

  // Refresh when the panel opens or another pane takes focus, then keep
  // polling while visible so a `cd` in the shell (or an outside commit)
  // shows up on its own. Porcelain status on a local repo is cheap.
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const root = status?.is_repo ? status.root : dir ?? "";
  const stage = (file: string) => run(() => invoke("git_stage", { path: root, file }));
  const unstage = (file: string) => run(() => invoke("git_unstage", { path: root, file }));
  const stageAll = () => run(() => invoke("git_stage_all", { path: root }));
  const push = () => run(() => invoke("git_push", { path: root }));
  const init = () => run(() => invoke("git_init", { path: dir }));
  const commit = () =>
    run(async () => {
      await invoke("git_commit", { path: root, message });
      setMessage("");
    });

  const open = (file: string) => openFile(`${root}/${file}`);

  const staged = (status?.files ?? []).filter((f) => f.x !== " " && f.x !== "?");
  const changes = (status?.files ?? []).filter((f) => f.y !== " ");
  const canCommit = staged.length > 0 && message.trim().length > 0 && !busy;
  // With a clean tree there's nothing left to commit, so the big button becomes
  // the next action that makes sense (VS Code-style): "Publish Branch" with no
  // upstream, "Push (n)" with commits ahead, and a passive "Up to date" check
  // once everything is pushed.
  const treeClean = status != null && status.files.length === 0;
  const synced = status != null && !!status.upstream && status.ahead === 0;

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">Source Control</span>
        <div className="panel-actions">
          <button
            className="tool-btn icon-btn small"
            title="Refresh"
            aria-label="Refresh git status"
            disabled={busy || loading}
            onPointerDown={preserveFocus}
            onClick={refresh}
          >
            <SyncIcon />
          </button>
        </div>
      </div>

      <div className="panel-body git-body">
        {loading && !status ? (
          <div className="tree-note">Loading…</div>
        ) : status && !status.is_repo ? (
          <div className="git-empty">
            <p>
              Not a Git repository:
              <br />
              <span className="git-empty-path">{dir}</span>
            </p>
            <button className="btn btn-primary" disabled={busy || !dir} onPointerDown={preserveFocus} onClick={init}>
              Initialize Repository
            </button>
          </div>
        ) : status ? (
          <>
            <div className="git-branch">
              <span className="git-repo" title={status.root}>
                {basename(status.root)}
              </span>
              <GitBranchLabel branch={status.branch} />
              <button
                className="git-push"
                title={
                  synced
                    ? "Everything is pushed"
                    : status.upstream
                      ? `Push to ${status.upstream}`
                      : "Publish the current branch"
                }
                aria-label="Push"
                disabled={busy || synced}
                onPointerDown={preserveFocus}
                onClick={push}
              >
                <ArrowUpIcon />
                {status.ahead > 0 ? <span className="git-ahead">{status.ahead}</span> : null}
              </button>
            </div>

            <div className="git-commit">
              <textarea
                className="git-message"
                value={message}
                spellCheck={false}
                placeholder={staged.length > 0 ? `Message (commit ${staged.length} staged)` : "Message"}
                aria-label="Commit message"
                rows={2}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  // ⌘/Ctrl+Enter commits.
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canCommit) commit();
                  e.stopPropagation();
                }}
              />
              {treeClean && synced ? (
                <button
                  className="btn btn-primary git-commit-btn git-uptodate"
                  title={`Everything is pushed to ${status.upstream}`}
                  disabled
                  onPointerDown={preserveFocus}
                >
                  <CheckIcon /> Up to date
                </button>
              ) : treeClean ? (
                <button
                  className="btn btn-primary git-commit-btn"
                  title={
                    status.upstream
                      ? `Push to ${status.upstream}`
                      : "Publish the current branch to its remote"
                  }
                  disabled={busy}
                  onPointerDown={preserveFocus}
                  onClick={push}
                >
                  <ArrowUpIcon />{" "}
                  {status.upstream ? `Push (${status.ahead})` : "Publish Branch"}
                </button>
              ) : (
                <button
                  className="btn btn-primary git-commit-btn"
                  disabled={!canCommit}
                  onPointerDown={preserveFocus}
                  onClick={commit}
                >
                  <CheckIcon /> Commit
                </button>
              )}
            </div>

            {error ? <div className="git-error">⚠ {error}</div> : null}

            {staged.length > 0 && (
              <div className="git-section">
                <div className="git-section-head">
                  <span>Staged Changes</span>
                  <span className="git-section-count">{staged.length}</span>
                </div>
                {staged.map((f) => (
                  <FileRow key={`s:${f.path}`} file={f} code={f.x} staged busy={busy} onOpen={open} onAction={unstage} />
                ))}
              </div>
            )}

            <div className="git-section">
              <div className="git-section-head">
                <span>Changes</span>
                {changes.length > 0 && (
                  <button
                    className="git-section-action"
                    title="Stage all changes"
                    aria-label="Stage all changes"
                    disabled={busy}
                    onPointerDown={preserveFocus}
                    onClick={stageAll}
                  >
                    <PlusIcon />
                  </button>
                )}
                <span className="git-section-count">{changes.length}</span>
              </div>
              {changes.length === 0 && staged.length === 0 ? (
                <div className="tree-note">No changes</div>
              ) : (
                changes.map((f) => (
                  <FileRow
                    key={`c:${f.path}`}
                    file={f}
                    code={f.x === "?" ? "?" : f.y}
                    staged={false}
                    busy={busy}
                    onOpen={open}
                    onAction={stage}
                  />
                ))
              )}
            </div>
          </>
        ) : error ? (
          <div className="git-error">⚠ {error}</div>
        ) : null}
      </div>
    </div>
  );
}

function GitBranchLabel({ branch }: { branch: string }) {
  return (
    <span className="git-branch-name" title={branch}>
      {branch || "(no branch)"}
    </span>
  );
}
