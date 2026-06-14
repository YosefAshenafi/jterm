// Shared case-insensitive substring search: the start offsets of every
// non-overlapping occurrence of `needle` in `haystack`. An empty needle yields
// no matches — `indexOf("")` matches at every position without advancing, which
// would loop forever. `limit` caps the result count to keep huge buffers
// responsive (the find bar passes one; the result-row highlighter doesn't need to).
export function findAllOccurrences(
  haystack: string,
  needle: string,
  limit = Infinity
): number[] {
  if (!needle) return [];
  const hay = haystack.toLowerCase();
  const q = needle.toLowerCase();
  const out: number[] = [];
  let i = hay.indexOf(q);
  while (i !== -1 && out.length < limit) {
    out.push(i);
    i = hay.indexOf(q, i + q.length);
  }
  return out;
}
