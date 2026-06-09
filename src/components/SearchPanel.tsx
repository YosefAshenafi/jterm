import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../state/store";
import { basename, dirname } from "../workspace";
import { ChevronIcon, CollapseAllIcon, SearchIcon } from "./icons";

interface SearchMatch {
  line: number;
  text: string;
}
interface FileResult {
  path: string;
  rel: string;
  matches: SearchMatch[];
}
interface SearchResults {
  results: FileResult[];
  truncated: boolean;
}

/** Wrap case-insensitive occurrences of `query` in <mark> for the result row. */
function highlight(text: string, query: string): ReactNode {
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  const out: ReactNode[] = [];
  let i = 0;
  let n = 0;
  let idx = lower.indexOf(q, i);
  while (idx !== -1) {
    if (idx > i) out.push(text.slice(i, idx));
    out.push(
      <mark key={n++} className="search-hit">
        {text.slice(idx, idx + q.length)}
      </mark>
    );
    i = idx + q.length;
    idx = lower.indexOf(q, i);
  }
  out.push(text.slice(i));
  return out;
}

/** Full-text search across the project folder (⌘⇧F). Debounced; results group
 * by file and link to the matching line in the editor. */
export function SearchPanel() {
  const { projectRoot, searchNonce, openFile } = useStore();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FileResult[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the field whenever the view is (re)opened.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [searchNonce]);

  // Debounced search on query / folder change.
  useEffect(() => {
    const q = query.trim();
    if (!q || !projectRoot) {
      setResults([]);
      setTruncated(false);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    let alive = true;
    const timer = setTimeout(() => {
      invoke<SearchResults>("search_in_folder", { path: projectRoot, query: q })
        .then((r) => {
          if (!alive) return;
          setResults(r.results);
          setTruncated(r.truncated);
          setCollapsed(new Set());
          setError(null);
        })
        .catch((e) => alive && setError(String(e)))
        .finally(() => alive && setLoading(false));
    }, 180);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, projectRoot, searchNonce]);

  const totalMatches = useMemo(
    () => results.reduce((sum, f) => sum + f.matches.length, 0),
    [results]
  );
  const allCollapsed = results.length > 0 && collapsed.size >= results.length;

  const toggleFile = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  const toggleAll = () =>
    setCollapsed(allCollapsed ? new Set() : new Set(results.map((f) => f.path)));

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">Search</span>
        <div className="panel-actions">
          <button
            className="tool-btn icon-btn small"
            title={allCollapsed ? "Expand all" : "Collapse all"}
            aria-label={allCollapsed ? "Expand all" : "Collapse all"}
            disabled={results.length === 0}
            onPointerDown={toggleAll}
          >
            {allCollapsed ? <ChevronIcon /> : <CollapseAllIcon />}
          </button>
        </div>
      </div>

      <div className="search-box">
        <SearchIcon className="search-box-icon" />
        <input
          ref={inputRef}
          className="search-input"
          value={query}
          spellCheck={false}
          placeholder={projectRoot ? "Search in folder…" : "Open a folder to search"}
          aria-label="Search text"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="search-summary">
        {error ? (
          <span className="search-error">⚠ {error}</span>
        ) : loading ? (
          "Searching…"
        ) : query.trim() && results.length === 0 ? (
          "No results"
        ) : results.length > 0 ? (
          <>
            {totalMatches} {totalMatches === 1 ? "result" : "results"} in {results.length}{" "}
            {results.length === 1 ? "file" : "files"}
            {truncated ? " (showing first matches)" : ""}
          </>
        ) : null}
      </div>

      <div className="panel-body">
        {results.map((file) => {
          const open = !collapsed.has(file.path);
          return (
            <div key={file.path} className="search-file">
              <button
                className="search-file-head"
                title={file.path}
                onPointerDown={() => toggleFile(file.path)}
              >
                <ChevronIcon className={`tree-chevron${open ? " open" : ""}`} />
                <span className="search-file-name">{basename(file.rel)}</span>
                <span className="search-file-dir">{dirname(file.rel)}</span>
                <span className="search-file-count">{file.matches.length}</span>
              </button>
              {open &&
                file.matches.map((m, i) => (
                  <button
                    key={`${m.line}:${i}`}
                    className="search-match"
                    title={`Line ${m.line}`}
                    onPointerDown={() => openFile(file.path, m.line)}
                  >
                    <span className="search-match-line">{m.line}</span>
                    <span className="search-match-text">
                      {highlight(m.text.replace(/^\s+/, ""), query.trim())}
                    </span>
                  </button>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
