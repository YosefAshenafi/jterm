import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../state/store";
import { resolveCwd } from "../workspace";

interface FileEntry {
  rel: string;
  path: string;
}

/** Subsequence fuzzy match with light scoring (consecutive runs, word/segment
 * starts, and basename matches score higher). Returns null when `query` isn't a
 * subsequence of `target`. */
function fuzzyMatch(
  query: string,
  target: string
): { score: number; positions: number[] } | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const positions: number[] = [];
  let qi = 0;
  let prev = -2;
  let score = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      let s = 1;
      if (ti === prev + 1) s += 5; // consecutive characters
      if (ti === 0 || /[/_\-. ]/.test(t[ti - 1])) s += 8; // start of a path segment / word
      score += s;
      positions.push(ti);
      prev = ti;
      qi++;
    }
  }
  if (qi < q.length) return null;
  const slash = t.lastIndexOf("/");
  score += positions.filter((p) => p > slash).length * 2; // favor basename hits
  score -= t.length * 0.01; // gently prefer shorter paths
  return { score, positions };
}

/** Bold the matched characters; basename brighter than the parent directory. */
function FileLabel({ rel, positions }: { rel: string; positions: number[] }) {
  const slash = rel.lastIndexOf("/");
  const dir = slash >= 0 ? rel.slice(0, slash) : "";
  const nameStart = slash + 1;
  const set = new Set(positions);
  const render = (text: string, offset: number): ReactNode[] =>
    Array.from(text, (ch, i) =>
      set.has(offset + i) ? <b key={i}>{ch}</b> : <span key={i}>{ch}</span>
    );
  return (
    <span className="palette-label">
      <span className="palette-name">{render(rel.slice(nameStart), nameStart)}</span>
      {dir && <span className="palette-dir">{render(dir, 0)}</span>}
    </span>
  );
}

/** ⌘P fuzzy file picker over the current project. */
function FilePalette() {
  const store = useStore();
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      // Use the terminal's *current* directory (not the possibly-stale stored
      // project root); list_files resolves it to the git/project root so the
      // whole project is searched.
      const root = (await resolveCwd(store.activePaneId)) || store.projectRoot;
      if (!root) {
        if (alive) setFiles([]);
        return;
      }
      try {
        const f = await invoke<FileEntry[]>("list_files", { root });
        if (alive) setFiles(f);
      } catch {
        if (alive) setFiles([]);
      }
    })();
    return () => {
      alive = false;
    };
    // Resolve once when the palette opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const results = useMemo(() => {
    if (!files) return [];
    const q = query.trim();
    if (!q) return files.slice(0, 100).map((f) => ({ f, positions: [] as number[] }));
    const scored: { f: FileEntry; score: number; positions: number[] }[] = [];
    for (const f of files) {
      const m = fuzzyMatch(q, f.rel);
      if (m) scored.push({ f, score: m.score, positions: m.positions });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 100);
  }, [files, query]);

  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    (listRef.current?.children[sel] as HTMLElement | undefined)?.scrollIntoView({
      block: "nearest",
    });
  }, [sel, results]);

  const open = (i: number) => {
    const r = results[i];
    if (!r) return;
    store.openFile(r.f.path);
    store.closePalette();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(results.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      open(sel);
    } else if (e.key === "Escape") {
      e.preventDefault();
      store.closePalette();
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        className="palette-input"
        placeholder="Search files by name…"
        value={query}
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="palette-list" ref={listRef}>
        {files === null ? (
          <div className="palette-empty">Indexing files…</div>
        ) : results.length === 0 ? (
          <div className="palette-empty">No matching files</div>
        ) : (
          results.map((r, i) => (
            <button
              key={r.f.path}
              className={`palette-row${i === sel ? " selected" : ""}`}
              onPointerDown={(e) => e.preventDefault()}
              onMouseMove={() => sel !== i && setSel(i)}
              onClick={() => open(i)}
            >
              <FileLabel rel={r.f.rel} positions={r.positions} />
            </button>
          ))
        )}
      </div>
    </>
  );
}

/** ⌘G go-to-line for the active file. */
function GotoPalette() {
  const store = useStore();
  const active = store.editor.files.find((f) => f.path === store.editor.activePath);
  const total = active ? active.draft.split("\n").length : 1;
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    const n = parseInt(value, 10);
    if (!Number.isNaN(n)) store.goToLine(Math.min(total, Math.max(1, n)));
    store.closePalette();
  };

  return (
    <input
      ref={inputRef}
      className="palette-input"
      inputMode="numeric"
      placeholder={`Go to line (1–${total})`}
      value={value}
      onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ""))}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          store.closePalette();
        }
      }}
    />
  );
}

/** VS Code-style quick input: ⌘P file picker and ⌘G go-to-line. */
export function CommandPalette() {
  const store = useStore();
  const mode = store.paletteMode;
  if (!mode) return null;
  return (
    <div className="palette-overlay" onPointerDown={() => store.closePalette()}>
      <div
        className={`palette${mode === "goto" ? " palette-goto" : ""}`}
        role="dialog"
        aria-modal="true"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {mode === "files" ? <FilePalette /> : <GotoPalette />}
      </div>
    </div>
  );
}
