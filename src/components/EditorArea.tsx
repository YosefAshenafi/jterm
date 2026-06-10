import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../state/store";
import { isDirty } from "../state/editor";
import { trackPointerDrag } from "../drag";

const isMac =
  /mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent);

/**
 * The file editor column that opens to the right of the folder tree, between it
 * and the terminal workspace. Holds a tab strip of open files (close on hover,
 * dirty marker) and an editable code view with a line-number gutter. File I/O
 * goes through the `read_file` / `write_file` Tauri commands; buffers and dirty
 * state live in the store so close/save shortcuts can act on the active file.
 */
export function EditorArea() {
  const store = useStore();
  const { editor } = store;
  const [width, setWidth] = useState(560);
  const requested = useRef<Set<string>>(new Set());
  const taRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Tear down a live resize drag if the editor unmounts mid-drag (the column
  // closes with its last file) so its window listeners don't leak.
  useEffect(() => () => cleanupRef.current?.(), []);

  const active = editor.files.find((f) => f.path === editor.activePath) ?? null;
  const editing = active && !active.loading && active.saved !== null;

  // Read each newly opened file exactly once; forget closed files so a re-open
  // pulls a fresh copy from disk.
  useEffect(() => {
    editor.files.forEach((f) => {
      if (f.loading && !requested.current.has(f.path)) {
        requested.current.add(f.path);
        invoke<string>("read_file", { path: f.path })
          .then((text) => store.markFileLoaded(f.path, text))
          .catch((err) => store.markFileError(f.path, String(err)));
      }
    });
    const live = new Set(editor.files.map((f) => f.path));
    requested.current.forEach((p) => {
      if (!live.has(p)) requested.current.delete(p);
    });
  }, [editor.files, store]);

  // Move focus into the text area when the active file changes by user intent.
  useEffect(() => {
    if (editing && store.focusRegion === "editor") taRef.current?.focus();
  }, [editor.activePath, editing, store.focusRegion]);

  // Reveal a line requested from search: once the target file is loaded and
  // active, select that line and scroll it into view, then clear the request.
  const reveal = store.reveal;
  useEffect(() => {
    if (!reveal || !active || !editing) return;
    if (active.path !== reveal.path || editor.activePath !== reveal.path) return;
    const ta = taRef.current;
    if (!ta) return;
    const lines = active.draft.split("\n");
    const line = Math.min(Math.max(1, reveal.line), lines.length);
    let start = 0;
    for (let i = 0; i < line - 1; i++) start += lines[i].length + 1;
    const end = start + lines[line - 1].length;
    ta.focus();
    ta.setSelectionRange(start, end);
    const lh = 18; // matches .editor-input line-height
    ta.scrollTop = Math.max(0, (line - 1) * lh - ta.clientHeight / 2 + lh);
    syncScroll();
    store.clearReveal();
  }, [reveal, active, editing, editor.activePath]);

  const lineNumbers = useMemo(() => {
    if (!editing || !active) return [];
    const count = Math.max(1, active.draft.split("\n").length);
    return Array.from({ length: count }, (_, i) => i + 1);
  }, [editing, active?.draft]);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const max = Math.max(360, window.innerWidth - 360);
    cleanupRef.current = trackPointerDrag(
      e,
      (ev) => setWidth(Math.min(max, Math.max(320, startW + ev.clientX - startX))),
      () => {
        cleanupRef.current = null;
      }
    );
  };

  // Keep the gutter aligned with the text area as it scrolls.
  const syncScroll = () => {
    if (gutterRef.current && taRef.current) {
      gutterRef.current.scrollTop = taRef.current.scrollTop;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab" || !active) return;
    // Indent with two spaces instead of leaving the editor.
    e.preventDefault();
    const ta = e.currentTarget;
    const { selectionStart, selectionEnd, value } = ta;
    const next = value.slice(0, selectionStart) + "  " + value.slice(selectionEnd);
    store.setFileDraft(active.path, next);
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = selectionStart + 2;
    });
  };

  const saveHint = isMac ? "⌘S" : "Ctrl+Shift+S";

  return (
    <div
      className="editor"
      style={{ width }}
      onPointerDownCapture={() => store.setFocusRegion("editor")}
    >
      <div className="editor-tabs" role="tablist" aria-label="Open files">
        {editor.files.map((f) => (
          <div
            key={f.path}
            className={`etab${f.path === editor.activePath ? " etab-active" : ""}`}
            title={f.path}
            role="tab"
            tabIndex={0}
            aria-selected={f.path === editor.activePath}
            // Tab-strip convention: select on press, not click — but only for
            // the primary button so right/middle clicks don't switch files.
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              store.selectFile(f.path);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                store.selectFile(f.path);
              }
            }}
          >
            <span className="etab-title">{f.name}</span>
            {isDirty(f) ? (
              <span className="etab-dirty" title="Unsaved changes" />
            ) : null}
            <button
              className="etab-close"
              aria-label={`Close ${f.name}`}
              // Swallow the press so it neither selects the tab underneath nor
              // steals focus; the action runs on click so keyboard Enter/Space
              // still works.
              onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
              }}
              onClick={(e) => {
                e.stopPropagation();
                store.requestCloseFile(f.path);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="editor-body">
        {!active ? null : active.loading ? (
          <div className="editor-note">Loading…</div>
        ) : active.saved === null ? (
          <div className="editor-note editor-error">⚠ {active.error}</div>
        ) : active.diff ? (
          <GitDiffView content={active.draft} />
        ) : (
          <>
            {active.error ? <div className="editor-banner">⚠ {active.error}</div> : null}
            <div className="editor-code">
              <div className="editor-gutter" ref={gutterRef} aria-hidden="true">
                {lineNumbers.map((n) => (
                  <div key={n} className="editor-lineno">
                    {n}
                  </div>
                ))}
              </div>
              <textarea
                ref={taRef}
                className="editor-input"
                spellCheck={false}
                wrap="off"
                value={active.draft}
                onChange={(e) => store.setFileDraft(active.path, e.target.value)}
                onScroll={syncScroll}
                onKeyDown={onKeyDown}
                onFocus={() => store.setFocusRegion("editor")}
              />
            </div>
          </>
        )}
      </div>

      {active ? (
        <div className="editor-status">
          <span className="editor-status-path">{active.path}</span>
          <span className="editor-status-state">
            {editing ? (isDirty(active) ? `Unsaved · ${saveHint} to save` : "Saved") : ""}
          </span>
        </div>
      ) : null}

      <div
        className="editor-resize"
        onPointerDown={startResize}
        role="separator"
        aria-orientation="vertical"
      />
    </div>
  );
}

function GitDiffView({ content }: { content: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const syncRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { syncRef.current?.(); }, []);

  const lines = useMemo(() => {
    const result: { kind: string; prefix: string; text: string }[] = [];
    for (const line of content.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        result.push({ kind: "add", prefix: "+", text: line.slice(1) });
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        result.push({ kind: "del", prefix: "-", text: line.slice(1) });
      } else if (line.startsWith("@@")) {
        result.push({ kind: "hdr", prefix: "@@", text: line.slice(2).trim() });
      } else {
        result.push({ kind: "ctx", prefix: " ", text: line });
      }
    }
    return result;
  }, [content]);

  return (
    <div className="editor-diff" ref={scrollRef}>
      <div className="git-diff">
        {lines.map((l, i) => (
          <div key={i} className={`git-diff-line git-diff-${l.kind}`}>
            <span className="git-diff-prefix">{l.prefix}</span>
            <span className="git-diff-text">{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
