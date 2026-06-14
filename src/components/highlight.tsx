import { ReactNode } from "react";
import { findAllOccurrences } from "./textSearch";

/** Wrap case-insensitive occurrences of `query` in <mark> for a search result
 * row. An empty or non-matching query returns the text untouched. */
export function highlight(text: string, query: string): ReactNode {
  const hits = findAllOccurrences(text, query);
  if (!hits.length) return text;
  const len = query.length;
  const out: ReactNode[] = [];
  let i = 0;
  let n = 0;
  for (const idx of hits) {
    if (idx > i) out.push(text.slice(i, idx));
    out.push(
      <mark key={n++} className="search-hit">
        {text.slice(idx, idx + len)}
      </mark>
    );
    i = idx + len;
  }
  out.push(text.slice(i));
  return out;
}
