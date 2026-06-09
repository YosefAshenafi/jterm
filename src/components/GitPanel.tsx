import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../state/store";
import { basename, dirname } from "../workspace";
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

/** Source Control: branch, staged/unstaged changes, commit message + push. */
export function GitPanel() {
  const { projectRoot, openFile } = useStore();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectRoot) {
      setStatus(null);
      return;
    }
    setLoading(true);
    try {
      setStatus(await invoke<GitStatus>("git_status", { path: projectRoot }));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [projectRoot]);

  useEffect(() => {
    refresh();
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

  const root = status?.root ?? projectRoot ?? "";
  const stage = (file: string) => run(() => invoke("git_stage", { path: root, file }));
  const unstage = (file: string) => run(() => invoke("git_unstage", { path: root, file }));
  const stageAll = () => run(() => invoke("git_stage_all", { path: root }));
  const push = () => run(() => invoke("git_push", { path: root }));
  const init = () => run(() => invoke("git_init", { path: projectRoot }));
  const commit = () =>
    run(async () => {
      await invoke("git_commit", { path: root, message });
      setMessage("");
    });

  const open = (file: string) => openFile(`${root}/${file}`);

  const staged = (status?.files ?? []).filter((f) => f.x !== " " && f.x !== "?");
  const changes = (status?.files ?? []).filter((f) => f.y !== " ");
  const canCommit = staged.length > 0 && message.trim().length > 0 && !busy;

  const FileRow = ({ file, code, staged: isStaged }: { file: GitFile; code: string; staged: boolean }) => (
    <div className="git-row">
      <button className="git-row-main" title={file.path} onPointerDown={() => open(file.path)}>
        <span className="git-row-name">{basename(file.path)}</span>
        <span className="git-row-dir">{dirname(file.path)}</span>
      </button>
      <button
        className="git-row-action"
        title={isStaged ? "Unstage" : "Stage"}
        aria-label={isStaged ? `Unstage ${file.path}` : `Stage ${file.path}`}
        disabled={busy}
        onPointerDown={() => (isStaged ? unstage(file.path) : stage(file.path))}
      >
        {isStaged ? <MinusIcon /> : <PlusIcon />}
      </button>
      <StatusBadge code={code} />
    </div>
  );

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
            onPointerDown={refresh}
          >
            <SyncIcon />
          </button>
        </div>
      </div>

      <div className="panel-body git-body">
        {!projectRoot ? (
          <div className="tree-note">Open a folder to use Source Control</div>
        ) : loading && !status ? (
          <div className="tree-note">Loading…</div>
        ) : status && !status.is_repo ? (
          <div className="git-empty">
            <p>This folder is not a Git repository.</p>
            <button className="btn btn-primary" disabled={busy} onPointerDown={init}>
              Initialize Repository
            </button>
          </div>
        ) : status ? (
          <>
            <div className="git-branch">
              <GitBranchLabel branch={status.branch} />
              <button
                className="git-push"
                title={status.upstream ? `Push to ${status.upstream}` : "Push"}
                aria-label="Push"
                disabled={busy}
                onPointerDown={push}
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
                placeholder={`Message (commit ${staged.length} staged)`}
                aria-label="Commit message"
                rows={2}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  // ⌘/Ctrl+Enter commits.
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canCommit) commit();
                  e.stopPropagation();
                }}
              />
              <button className="btn btn-primary git-commit-btn" disabled={!canCommit} onPointerDown={commit}>
                <CheckIcon /> Commit
              </button>
            </div>

            {error ? <div className="git-error">⚠ {error}</div> : null}

            {staged.length > 0 && (
              <div className="git-section">
                <div className="git-section-head">
                  <span>Staged Changes</span>
                  <span className="git-section-count">{staged.length}</span>
                </div>
                {staged.map((f) => (
                  <FileRow key={`s:${f.path}`} file={f} code={f.x} staged />
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
                    onPointerDown={stageAll}
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
                  <FileRow key={`c:${f.path}`} file={f} code={f.x === "?" ? "?" : f.y} staged={false} />
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
