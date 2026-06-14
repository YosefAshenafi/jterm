import { useEffect, useMemo, useRef, useState } from "react";
import { findAllOccurrences } from "./textSearch";

interface Props {
  /** The text being searched (the active file's buffer). */
  text: string;
  /** Select/scroll a match range in the editor (does not steal input focus). */
  onSelect: (start: number, end: number) => void;
  onClose: () => void;
}

/** VS Code-style find widget for the open file: type to match, ⏎ / ⇧⏎ to step
 * through matches, Esc to close. The current match is selected in the editor. */
export function FindBar({ text, onSelect, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const matches = useMemo(() => findAllOccurrences(text, query, 20000), [text, query]);

  useEffect(() => {
    setIdx(0);
    if (matches.length) onSelectRef.current(matches[0], matches[0] + query.length);
  }, [matches, query]);

  const go = (delta: number) => {
    if (!matches.length) return;
    const next = (idx + delta + matches.length) % matches.length;
    setIdx(next);
    onSelectRef.current(matches[next], matches[next] + query.length);
  };

  const swallow = (e: React.PointerEvent) => e.preventDefault();

  return (
    <div className="find-bar" onPointerDown={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        className="find-input"
        placeholder="Find"
        value={query}
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            go(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className="find-count">
        {matches.length ? `${idx + 1} of ${matches.length}` : query ? "No results" : ""}
      </span>
      <button
        className="find-btn"
        aria-label="Previous match"
        title="Previous  ·  ⇧⏎"
        disabled={!matches.length}
        onPointerDown={swallow}
        onClick={() => go(-1)}
      >
        ↑
      </button>
      <button
        className="find-btn"
        aria-label="Next match"
        title="Next  ·  ⏎"
        disabled={!matches.length}
        onPointerDown={swallow}
        onClick={() => go(1)}
      >
        ↓
      </button>
      <button
        className="find-btn find-close"
        aria-label="Close find"
        title="Close  ·  Esc"
        onPointerDown={swallow}
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}
