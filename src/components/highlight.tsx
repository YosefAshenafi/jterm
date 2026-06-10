import { ReactNode } from "react";

/** Wrap case-insensitive occurrences of `query` in <mark> for a search result
 * row. An empty query returns the text untouched — `indexOf("")` matches at
 * every position without ever advancing, which would loop forever (the panel
 * renders once with stale results right as the query is cleared). */
export function highlight(text: string, query: string): ReactNode {
  const q = query.toLowerCase();
  if (!q) return text;
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
