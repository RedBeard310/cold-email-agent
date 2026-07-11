// Deterministic, ~even bucketing so each lead always lands in the same campaign
// across re-runs (FNV-1a 32-bit hash of the email).
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function bucketOf(key: string, buckets: number): number {
  return hash32(key.toLowerCase()) % buckets;
}

/** Exactly-even split: sort by key for determinism, then round-robin into N buckets. */
export function equalSplit<T>(items: T[], keyOf: (t: T) => string, n: number): T[][] {
  const sorted = [...items].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  const buckets: T[][] = Array.from({ length: n }, () => []);
  sorted.forEach((it, i) => buckets[i % n]!.push(it));
  return buckets;
}
