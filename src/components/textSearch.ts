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
