import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  readText as clipboardReadText,
  writeText as clipboardWriteText,
} from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useStore } from "../state/store";
import { isDirty } from "../state/editor";
import { collectLeaves } from "../state/tree";
import { terminals } from "../terminal/manager";
import { trackPointerDrag } from "../drag";
import { basename, imageMime, resolveCwd } from "../workspace";
import { highlightToHtml, languageFromName } from "./syntax";
import { PaneTree, MenuRequest } from "./PaneTree";
import { ContextMenu, MenuItem } from "./ContextMenu";
import { FindBar } from "./FindBar";

const isMac =
  /mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent);

/**
 * The main content area to the right of the folder tree: one tab strip holding a
 * single Terminal tab (the split-pane grid) plus one tab per open file, with the
 * selected tab filling the body. `editor.activePath === null` means the Terminal
 * tab is active; any non-null path selects that file. With no files open the
 * area is simply the terminal grid. File I/O and buffers live in the store.
 */
export function WorkArea() {
  const store = useStore();
  const { state, editor } = store;
  const [menu, setMenu] = useState<MenuRequest | null>(null);
  const [panelHeight, setPanelHeight] = useState(260);
  const requested = useRef<Set<string>>(new Set());
  const taRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const panelResize = useRef<(() => void) | null>(null);

  // Drop a live panel-resize drag if the area unmounts mid-drag.
  useEffect(() => () => panelResize.current?.(), []);

  const startPanelResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = panelHeight;
    const max = Math.max(160, window.innerHeight - 220);
    panelResize.current = trackPointerDrag(
      e,
      (ev) => {
        // The panel sits at the bottom, so dragging up makes it taller.
        const next = startH + (startY - ev.clientY);
        setPanelHeight(Math.min(max, Math.max(120, next)));
      },
      () => {
        panelResize.current = null;
      }
    );
  };

  // Editor zoom: font size (from settings, ⌘+/⌘-/⌘scroll) and a matching line
  // height that the gutter and scroll math both use.
  const editorFont = store.settings.editorFontSize;
  const editorLine = Math.round(editorFont * 1.45);

  const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
  const hasFiles = editor.files.length > 0;
  const showTerminal = editor.activePath === null;
  const active = editor.files.find((f) => f.path === editor.activePath) ?? null;
  const editing = active && !active.loading && active.saved !== null && !active.image;

  // Read each newly opened file exactly once; forget closed files so a re-open
  // pulls a fresh copy from disk.
  useEffect(() => {
    editor.files.forEach((f) => {
      if (f.loading && !requested.current.has(f.path)) {
        requested.current.add(f.path);
        const mime = imageMime(f.path);
        if (mime) {
          // Images load as base64 and render as a preview, like VS Code.
          invoke<string>("read_file_base64", { path: f.path })
            .then((b64) => store.markFileImage(f.path, `data:${mime};base64,${b64}`))
            .catch((err) => store.markFileError(f.path, String(err)));
        } else {
          invoke<string>("read_file", { path: f.path })
            .then((text) => store.markFileLoaded(f.path, text))
            .catch((err) => store.markFileError(f.path, String(err)));
        }
      }
    });
    const live = new Set(editor.files.map((f) => f.path));
    requested.current.forEach((p) => {
      if (!live.has(p)) requested.current.delete(p);
    });
    // Forget undo history for files that were closed (a re-open starts fresh).
    history.current.forEach((_, p) => {
      if (!live.has(p)) history.current.delete(p);
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
    const lh = editorLine; // matches the editor's line height
    ta.scrollTop = Math.max(0, (line - 1) * lh - ta.clientHeight / 2 + lh);
    syncScroll();
    store.clearReveal();
  }, [reveal, active, editing, editor.activePath]);

  const lineNumbers = useMemo(() => {
    if (!editing || !active) return [];
    const count = Math.max(1, active.draft.split("\n").length);
    return Array.from({ length: count }, (_, i) => i + 1);
  }, [editing, active?.draft]);

  // Syntax-highlighted mirror of the buffer, painted behind a transparent
  // textarea. Memoized so it only recomputes when the text or language changes.
  const language = useMemo(() => languageFromName(active?.name ?? ""), [active?.name]);
  const highlighted = useMemo(
    () => (editing && active && !active.diff ? highlightToHtml(active.draft, language) : ""),
    [editing, active?.draft, active?.diff, language]
  );

  // Keep the gutter and the highlight layer aligned with the text area as it
  // scrolls (the highlight <pre> sits behind the transparent textarea).
  const syncScroll = () => {
    const ta = taRef.current;
    if (!ta) return;
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
    if (preRef.current) {
      preRef.current.scrollTop = ta.scrollTop;
      preRef.current.scrollLeft = ta.scrollLeft;
    }
  };

  // Per-file undo/redo history. The textarea is controlled, so native undo is
  // unreliable; we keep our own snapshot stack and coalesce rapid keystrokes
  // into one step. (The app strips the macOS Edit menu, so these editing
  // shortcuts are handled here rather than by the system.)
  const history = useRef<Map<string, { stack: string[]; index: number; t: number }>>(
    new Map()
  );

  const recordEdit = (path: string, prev: string, next: string) => {
    let h = history.current.get(path);
    if (!h) {
      h = { stack: [prev], index: 0, t: 0 };
      history.current.set(path, h);
    }
    if (h.index < h.stack.length - 1) h.stack.length = h.index + 1; // drop redo branch
    const now = Date.now();
    if (now - h.t < 450 && h.index > 0) {
      h.stack[h.index] = next; // coalesce a burst of typing into the current step
    } else {
      h.stack.push(next);
      h.index = h.stack.length - 1;
      if (h.stack.length > 400) {
        h.stack.shift();
        h.index--;
      }
    }
    h.t = now;
  };

  const applyHistory = (delta: number) => {
    if (!active) return;
    const h = history.current.get(active.path);
    if (!h) return;
    const idx = h.index + delta;
    if (idx < 0 || idx >= h.stack.length) return;
    h.index = idx;
    h.t = 0; // a fresh edit after undo/redo starts a new step
    const value = h.stack[idx];
    store.setFileDraft(active.path, value);
    const ta = taRef.current;
    if (ta) requestAnimationFrame(() => (ta.selectionStart = ta.selectionEnd = value.length));
  };

  const onEditorChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!active) return;
    recordEdit(active.path, active.draft, e.target.value);
    store.setFileDraft(active.path, e.target.value);
  };

  // Standard editing shortcuts inside the file editor: select-all, copy, cut,
  // paste, undo, redo. ⌘W/⌘S are handled by the app-level handler.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!active) return;
    const ta = e.currentTarget;
    const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;

    if (e.key === "Tab" && !mod) {
      // Indent with two spaces instead of leaving the editor.
      e.preventDefault();
      const { selectionStart, selectionEnd, value } = ta;
      const next = value.slice(0, selectionStart) + "  " + value.slice(selectionEnd);
      recordEdit(active.path, value, next);
      store.setFileDraft(active.path, next);
      requestAnimationFrame(() => (ta.selectionStart = ta.selectionEnd = selectionStart + 2));
      return;
    }
    if (!mod) return;
    const k = e.key.toLowerCase();

    if (k === "a") {
      e.preventDefault();
      ta.select();
    } else if (k === "c") {
      e.preventDefault();
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      if (sel) void clipboardWriteText(sel);
    } else if (k === "x") {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en, value } = ta;
      if (s === en) return;
      void clipboardWriteText(value.slice(s, en));
      const next = value.slice(0, s) + value.slice(en);
      recordEdit(active.path, value, next);
      store.setFileDraft(active.path, next);
      requestAnimationFrame(() => (ta.selectionStart = ta.selectionEnd = s));
    } else if (k === "v") {
      e.preventDefault();
      const path = active.path;
      void clipboardReadText()
        .then((text) => {
          const cur = taRef.current;
          if (text == null || !cur) return;
          const { selectionStart: s, selectionEnd: en, value } = cur;
          const next = value.slice(0, s) + text + value.slice(en);
          recordEdit(path, value, next);
          store.setFileDraft(path, next);
          const pos = s + text.length;
          requestAnimationFrame(() => (cur.selectionStart = cur.selectionEnd = pos));
        })
        .catch(() => {});
    } else if (k === "z" && !e.shiftKey) {
      e.preventDefault();
      applyHistory(-1);
    } else if ((k === "z" && e.shiftKey) || k === "y") {
      e.preventDefault();
      applyHistory(1);
    }
  };

  const tabOf = (paneId: string) =>
    state.tabs.find((t) => collectLeaves(t.root).some((l) => l.id === paneId));

  const menuItems = (req: MenuRequest): MenuItem[] => {
    const tab = tabOf(req.paneId);
    const hasSelection = !!terminals.getSelection(req.paneId);
    const items: MenuItem[] = [];
    // When right-clicking a link, offer link actions first.
    if (req.link) {
      const link = req.link;
      items.push(
        { label: "Open Link", onClick: () => void openUrl(link) },
        { label: "Download Link", onClick: () => store.downloadUrl(link) },
        { label: "Copy Link Address", onClick: () => void clipboardWriteText(link) }
      );
    }
    items.push(
      { label: "Split Right", onClick: () => store.split("row") },
      { label: "Split Down", onClick: () => store.split("column") },
      { label: "Copy", disabled: !hasSelection, onClick: () => terminals.copy(req.paneId) },
      { label: "Paste", onClick: () => terminals.paste(req.paneId) },
      { label: "Close Pane", onClick: () => tab && store.closePane(tab.id, req.paneId) }
    );
    return items;
  };

  const selectTerminal = () => store.showTerminalView();
  const saveHint = isMac ? "⌘S" : "Ctrl+Shift+S";

  return (
    <div className="workarea">
      {/* The tab strip only appears once a file is open; with no files the area
          is simply the terminal grid, full height. */}
      {hasFiles && (
      <div className="editor-tabs" role="tablist" aria-label="Workspace tabs">
        {/* Terminal tab — leftmost, shows the split-pane grid. */}
        <div
          className={`etab etab-term${showTerminal ? " etab-active" : ""}`}
          role="tab"
          tabIndex={0}
          aria-selected={showTerminal}
          title="Terminal"
          onPointerDown={(e) => {
            if (e.button === 0) selectTerminal();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              selectTerminal();
            }
          }}
        >
          <span className="etab-term-glyph" aria-hidden="true">{"›_"}</span>
          <span className="etab-title">Terminal</span>
        </div>

        {/* One tab per open file. */}
        {editor.files.map((f) => (
          <div
            key={f.path}
            className={`etab${f.path === editor.activePath ? " etab-active" : ""}`}
            title={f.path}
            role="tab"
            tabIndex={0}
            aria-selected={f.path === editor.activePath}
            // Select on press, not click — but only for the primary button so
            // right/middle clicks don't switch files.
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
            {isDirty(f) ? <span className="etab-dirty" title="Unsaved changes" /> : null}
            <button
              className="etab-close"
              aria-label={`Close ${f.name}`}
              // Swallow the press so it neither selects the tab underneath nor
              // steals focus; the action runs on click so keyboard works too.
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
      )}

      <div className="workarea-body">
        {showTerminal ? (
          <div className="workspace">
            {activeTab && (
              <PaneTree node={activeTab.root} tab={activeTab} onPaneMenu={setMenu} />
            )}
          </div>
        ) : (
          <div
            className="editor-body"
            onPointerDownCapture={() => store.setFocusRegion("editor")}
          >
            {!active ? null : active.loading ? (
              <div className="editor-note">Loading…</div>
            ) : active.image && active.imageSrc ? (
              <ImagePreview src={active.imageSrc} name={active.name} />
            ) : active.saved === null ? (
              <div className="editor-note editor-error">⚠ {active.error}</div>
            ) : active.diff ? (
              <GitDiffView content={active.draft} />
            ) : (
              <>
                {active.error ? <div className="editor-banner">⚠ {active.error}</div> : null}
                <div
                  className="editor-code"
                  style={{ fontSize: editorFont, lineHeight: `${editorLine}px` }}
                >
                  <div className="editor-gutter" ref={gutterRef} aria-hidden="true">
                    {lineNumbers.map((n) => (
                      <div
                        key={n}
                        className="editor-lineno"
                        style={{ height: editorLine, lineHeight: `${editorLine}px` }}
                      >
                        {n}
                      </div>
                    ))}
                  </div>
                  <div className="editor-input-wrap">
                    <pre
                      ref={preRef}
                      className="editor-highlight"
                      aria-hidden="true"
                      dangerouslySetInnerHTML={{ __html: highlighted }}
                    />
                    <textarea
                      ref={taRef}
                      className="editor-input"
                      spellCheck={false}
                      wrap="off"
                      value={active.draft}
                      onChange={onEditorChange}
                      onScroll={syncScroll}
                      onKeyDown={onKeyDown}
                      onFocus={() => store.setFocusRegion("editor")}
                    />
                  </div>
                </div>
              </>
            )}
            {store.findOpen && editing && active && !active.diff && (
              <FindBar
                text={active.draft}
                onSelect={(s, e) => {
                  const ta = taRef.current;
                  if (!ta) return;
                  ta.setSelectionRange(s, e);
                  const line = active.draft.slice(0, s).split("\n").length;
                  ta.scrollTop = Math.max(0, (line - 1) * editorLine - ta.clientHeight / 2 + editorLine);
                  syncScroll();
                }}
                onClose={() => {
                  store.closeFind();
                  taRef.current?.focus();
                }}
              />
            )}
          </div>
        )}
      </div>

      {/* Bottom terminal panel (⌘J) — its own tabs of scratch shells for running
          commands while reading a file. Hidden when toggled off; shells persist. */}
      {store.panelOpen && (
        <div className="term-panel" style={{ height: panelHeight }}>
          <div
            className="term-panel-resize"
            onPointerDown={startPanelResize}
            role="separator"
            aria-orientation="horizontal"
          />
          <div className="term-panel-header">
            <div className="term-panel-tabs" role="tablist" aria-label="Panel terminals">
              {store.panelTerminals.map((id, i) => (
                <div
                  key={id}
                  role="tab"
                  aria-selected={id === store.activePanelTerminal}
                  className={`ptab${id === store.activePanelTerminal ? " ptab-active" : ""}`}
                  onPointerDown={(e) => {
                    if (e.button === 0) store.selectPanelTerminal(id);
                  }}
                >
                  <span className="ptab-glyph" aria-hidden="true">{"›_"}</span>
                  <PanelTabLabel paneId={id} index={i} />
                  <button
                    className="ptab-close"
                    aria-label="Close terminal"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      store.closePanelTerminal(id);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                className="term-panel-add"
                aria-label="New panel terminal"
                title="New terminal  ·  ⌘⇧J"
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => store.addPanelTerminal()}
              >
                +
              </button>
            </div>
            <button
              className="term-panel-close"
              aria-label="Close panel"
              title="Close panel  ·  ⌘J"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => store.closePanel()}
            >
              ×
            </button>
          </div>
          <div className="term-panel-bodies">
            {store.activePanelTerminal && (
              <PanelTerminalHost key={store.activePanelTerminal} paneId={store.activePanelTerminal} />
            )}
          </div>
        </div>
      )}

      {!showTerminal && active ? (
        <div className="editor-status">
          <span className="editor-status-path">{active.path}</span>
          <span className="editor-status-state">
            {editing ? (isDirty(active) ? `Unsaved · ${saveHint} to save` : "Saved") : ""}
          </span>
        </div>
      ) : null}

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

/** Hosts one bottom-panel terminal. The xterm instance lives in the manager
 * (keyed by its pane id) so it survives panel/tab switches. */
function PanelTerminalHost({ paneId }: { paneId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    terminals.attach(paneId, el);
    terminals.spawn(paneId);
    terminals.focus(paneId);
    const ro = new ResizeObserver(() => terminals.fit(paneId));
    ro.observe(el);
    return () => ro.disconnect(); // never dispose here — the manager owns lifetime
  }, [paneId]);
  return (
    <div
      className="term-panel-host"
      ref={ref}
      onPointerDownCapture={() => terminals.focus(paneId)}
    />
  );
}

/** Tab label for a panel terminal: its shell's directory, resolved once. */
function PanelTabLabel({ paneId, index }: { paneId: string; index: number }) {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    resolveCwd(paneId).then((dir) => alive && setLabel(basename(dir)));
    return () => {
      alive = false;
    };
  }, [paneId]);
  return <span className="ptab-title">{label ?? `Terminal ${index + 1}`}</span>;
}

/** Image preview shown in place of the text editor (VS Code-style). */
function ImagePreview({ src, name }: { src: string; name: string }) {
  const [dim, setDim] = useState<{ w: number; h: number } | null>(null);
  return (
    <div className="image-preview">
      <div className="image-preview-canvas">
        <img
          src={src}
          alt={name}
          draggable={false}
          onLoad={(e) =>
            setDim({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
          }
        />
      </div>
      <div className="image-info">
        {name}
        {dim ? ` · ${dim.w} × ${dim.h}` : ""}
      </div>
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
