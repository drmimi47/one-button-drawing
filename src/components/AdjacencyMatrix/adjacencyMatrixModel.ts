import { RESIDENTIAL_ROOMS } from '../../rooms/roomCatalog';

/**
 * ============================================================================
 *  ADJACENCY MATRIX — pure model helpers (no React, no DOM).
 * ============================================================================
 *
 * Translates between the prediction engine's WEIGHT table (`ADJACENCY[source][target] =
 * weight`, higher = more likely) and the matrix tool's RANK view (reverse logic: 1 = most
 * likely, 2 = second, blank = never predicted). Kept dependency-free so it can be unit-probed
 * with `npx tsx`.
 */

export type Adjacency = Record<string, Record<string, number>>;
/** A source row expressed as target → rank (1 = most likely; ties share a rank). */
export type RankRow = Record<string, number>;
export type RankMatrix = Record<string, RankRow>;

/** Column axis: the real catalog room keys, in catalog order (these are the snap targets). */
export const TARGET_KEYS: string[] = RESIDENTIAL_ROOMS.map((r) => r.key);
/** Row axis: every target key as a source, plus the generic `default` row at the end. */
export const SOURCE_KEYS: string[] = [...TARGET_KEYS, 'default'];

/** Display label for a room key; the synthetic `default` row gets a friendly caption. */
export function keyLabel(key: string): string {
  if (key === 'default') return 'Room (default)';
  return RESIDENTIAL_ROOMS.find((r) => r.key === key)?.label ?? key;
}

/**
 * Dense-rank one weight row: entries with weight > 0, ordered by weight desc, numbered
 * 1,2,3… where EQUAL weights share a number (`{a:9,b:8,c:8,d:6}` → `{a:1,b:2,c:2,d:3}`).
 * Absent / non-positive targets are simply omitted (they read as blank in the matrix).
 */
export function denseRankRow(row: Record<string, number>): RankRow {
  const entries = Object.entries(row).filter(([, w]) => w > 0);
  const distinct = [...new Set(entries.map(([, w]) => w))].sort((a, b) => b - a);
  const rankOf = new Map(distinct.map((w, i) => [w, i + 1]));
  const out: RankRow = {};
  for (const [key, w] of entries) out[key] = rankOf.get(w)!;
  return out;
}

/** Dense-rank every source row of a weight table into the matrix's rank view. */
export function buildRankMatrix(adj: Adjacency): RankMatrix {
  const out: RankMatrix = {};
  for (const source of SOURCE_KEYS) {
    out[source] = denseRankRow(adj[source] ?? {});
  }
  return out;
}

/**
 * Invert one rank row back to weights: `weight = maxRank + 1 − rank`, so rank 1 gets the
 * highest weight, equal ranks get equal weights, and the order/ties the matrix shows are
 * preserved exactly. Non-positive / non-finite ranks are dropped. An empty row → `{}`.
 */
export function ranksToWeights(rankRow: RankRow): Record<string, number> {
  const entries = Object.entries(rankRow).filter(([, r]) => Number.isFinite(r) && r >= 1);
  if (entries.length === 0) return {};
  const maxRank = Math.max(...entries.map(([, r]) => r));
  const out: Record<string, number> = {};
  for (const [key, r] of entries) out[key] = maxRank + 1 - r;
  return out;
}

/**
 * Build the next weight table: edited (dirty) source rows are regenerated from their ranks
 * via {@link ranksToWeights}; every untouched row is carried over BY REFERENCE from
 * `original`, so a save with no edits is a perfect no-op (hand-tuned magnitudes preserved).
 */
export function composeNext(original: Adjacency, dirtyRankRows: RankMatrix): Adjacency {
  const next: Adjacency = {};
  for (const [source, row] of Object.entries(original)) next[source] = row;
  for (const [source, rankRow] of Object.entries(dirtyRankRows)) {
    next[source] = ranksToWeights(rankRow);
  }
  return next;
}
