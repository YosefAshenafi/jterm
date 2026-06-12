import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../state/store";
import { basename, dirname, resolveCwd } from "../workspace";
import { ArrowUpIcon, CheckIcon, DiscardIcon, MinusIcon, PlusIcon, SyncIcon } from "./icons";

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

const preserveFocus = (e: ReactPointerEvent) => e.preventDefault();

// ── File Row ────────────────────────────────────────────────

function FileRow({
  file,
  code,
  staged,
  busy,
  onOpen,
  onAction,
  onDiscard,
}: {
  file: GitFile;
  code: string;
  staged: boolean;
  busy: boolean;
  onOpen: (file: string, staged: boolean) => void;
  onAction: (file: string) => void;
  onDiscard: (file: string) => void;
}) {
  return (
    <div className="git-row">
      <button
        className="git-row-main"
        title={file.path}
        onPointerDown={preserveFocus}
        onClick={() => onOpen(file.path, staged)}
      >
        <span className="git-row-name">{basename(file.path)}</span>
        <span className="git-row-dir">{dirname(file.path)}</span>
      </button>
      {!staged && (
        <button
          className="git-row-action git-row-discard"
          title="Discard changes"
          aria-label={`Discard changes in ${file.path}`}
          disabled={busy}
          onPointerDown={preserveFocus}
          onClick={() => onDiscard(file.path)}
        >
          <DiscardIcon />
        </button>
      )}
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

// ── Panel ───────────────────────────────────────────────────

/** Source Control: branch, staged/unstaged changes, commit message + push. */
export function GitPanel() {
  const { activePaneId, openDiffView, setGitChangesCount } = useStore();
  const [dir, setDir] = useState<string | null>(null);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const seqRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const path = await resolveCwd(activePaneId);
      const next = await invoke<GitStatus>("git_status", { path });
      if (seq !== seqRef.current) return;
      setDir(path);
      setStatus(next);
      setGitChangesCount(next.files.length);
      setError(null);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(String(e));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [activePaneId, setGitChangesCount]);

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
  const discard = (file: string) => {
    if (window.confirm(`Discard changes in "${file}"?`)) {
      run(() => invoke("git_discard", { path: root, file }));
    }
  };
  const stageAll = () => run(() => invoke("git_stage_all", { path: root }));
  const unstageAll = () => run(() => invoke("git_unstage_all", { path: root }));
  const discardAll = () => {
    if (window.confirm(`Discard ALL ${changes.length} change(s)? This cannot be undone.`)) {
      run(() => invoke("git_discard_all", { path: root }));
    }
  };
  const push = () => run(() => invoke("git_push", { path: root }));
  const init = () => run(() => invoke("git_init", { path: dir }));
  const commit = () =>
    run(async () => {
      await invoke("git_commit", { path: root, message });
      setMessage("");
    });

  const openDiff = async (file: string, staged: boolean) => {
    try {
      const fullPath = `${root}/${file}`;
      const diff = await invoke<string>("git_diff", { path: root, file, staged });
      if (diff.trim()) {
        openDiffView(fullPath, diff);
      } else if (!staged) {
        // Untracked file — show content as all additions
        const content = await invoke<string>("read_file", { path: fullPath });
        const asDiff = content.split("\n").map((l) => `+${l}`).join("\n");
        openDiffView(fullPath, asDiff);
      } else {
        openDiffView(fullPath, diff);
      }
    } catch {
      // Fallback: open normally
    }
  };

  const staged = (status?.files ?? []).filter((f) => f.x !== " " && f.x !== "?");
  const changes = (status?.files ?? []).filter((f) => f.y !== " ");
  const canCommit = staged.length > 0 && message.trim().length > 0 && !busy;
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
                  <button
                    className="git-section-action"
                    title="Unstage all changes"
                    aria-label="Unstage all changes"
                    disabled={busy}
                    onPointerDown={preserveFocus}
                    onClick={unstageAll}
                  >
                    <MinusIcon />
                  </button>
                  <span className="git-section-count">{staged.length}</span>
                </div>
                {staged.map((f) => (
                  <FileRow key={`s:${f.path}`} file={f} code={f.x} staged busy={busy} onOpen={openDiff} onAction={unstage} onDiscard={() => {}} />
                ))}
              </div>
            )}

            <div className="git-section">
              <div className="git-section-head">
                <span>Changes</span>
                {changes.length > 0 && (
                  <>
                    <button
                      className="git-section-action git-section-discard"
                      title="Discard all changes"
                      aria-label="Discard all changes"
                      disabled={busy}
                      onPointerDown={preserveFocus}
                      onClick={discardAll}
                    >
                      <DiscardIcon />
                    </button>
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
                  </>
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
                    onOpen={openDiff}
                    onAction={stage}
                    onDiscard={discard}
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
