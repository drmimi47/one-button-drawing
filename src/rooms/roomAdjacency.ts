import { findRoomByKey } from './roomCatalog';

export { DEFAULT_ADJACENCY } from './adjacencyDefaults';

/**
 * ============================================================================
 *  ROOM ADJACENCY — a transparent "heat map" of residential room topology.
 * ============================================================================
 *
 * This is the confidence source for the next-room prediction (the 1/2/3 option
 * dots). It is deliberately a plain, hand-tuned table in the codebase — NOT a
 * black-box model — so a developer can read and adjust exactly why "Kitchen"
 * suggests "Dining / Pantry / Breakfast Nook".
 *
 * ADJACENCY[source][neighbour] = a relative likelihood WEIGHT. Only the ratios
 * within a row matter (they're normalised into a confidence share at query time), on a
 * hand-tuned closeness scale of roughly 1 (weak / occasional) … 9 (strong / near-mandatory),
 * higher = closer neighbour. The table is a broad sweep of residential floorplan adjacencies,
 * and EVERY room lists several neighbours so the next-room predictor is never empty (an empty
 * row would read as a broken tool).
 *
 * Rows are keyed by room catalog `key` (see src/rooms/roomCatalog.ts). The special
 * `default` row covers a generic, unrecognised room (e.g. a plain "Room"): the app
 * reasons that such a space could border a Kitchen, Living Room, Garage, etc.
 *
 * Tuning notes:
 *  - Keep it roughly symmetric, or make it intentionally directional where that
 *    reflects how people move through a home (e.g. Garage → Mudroom is strong).
 *  - A source key missing from this table falls back to the `default` row; an
 *    explicit empty row `{}` means that room predicts nothing.
 *  - See the plan's "Fine-tuning & future improvements" for context-aware ideas
 *    (suppress duplicate Kitchens, learn from user picks, size/edge fit, etc.).
 */
export const ADJACENCY: Record<string, Record<string, number>> = {
  kitchen: { dining: 9, pantry: 9, breakfastNook: 8, living: 7, greatRoom: 7, mudroom: 6, laundry: 5, powderRoom: 4, garage2Car: 3, foyer: 3 },
  dining: { kitchen: 9, living: 7, greatRoom: 6, foyer: 5, breakfastNook: 4, pantry: 3 },
  living: { kitchen: 8, dining: 8, foyer: 7, powderRoom: 5, greatRoom: 4, office: 4, stairwell: 4 },
  greatRoom: { kitchen: 9, dining: 6, breakfastNook: 6, foyer: 6, powderRoom: 5, office: 4, stairwell: 3 },
  breakfastNook: { kitchen: 9, living: 5, greatRoom: 5, pantry: 4, mudroom: 4, dining: 3 },
  pantry: { kitchen: 9, mudroom: 5, laundry: 4, dining: 4, breakfastNook: 3, garage2Car: 2 },
  bedroom: { closet: 8, fullBath: 7, bedroom: 4, walkInCloset: 3 },
  primaryBedroom: { fullBath: 9, walkInCloset: 9, closet: 4, office: 3 },
  fullBath: { bedroom: 7, primaryBedroom: 6, closet: 4, walkInCloset: 3, laundry: 3 },
  powderRoom: { foyer: 6, living: 5, kitchen: 4, greatRoom: 4, mudroom: 3, office: 3 },
  closet: { bedroom: 8, primaryBedroom: 4, foyer: 4, fullBath: 3 },
  walkInCloset: { primaryBedroom: 9, fullBath: 6, bedroom: 4, laundry: 3 },
  laundry: { mudroom: 7, kitchen: 5, garage2Car: 4, pantry: 4, utility: 4, walkInCloset: 3 },
  mudroom: { garage2Car: 9, garage1Car: 7, kitchen: 6, laundry: 6, pantry: 4, foyer: 4, powderRoom: 3, closet: 3 },
  office: { foyer: 6, living: 5, greatRoom: 4, closet: 3, stairwell: 3 },
  garage2Car: { mudroom: 9, kitchen: 5, utility: 5, laundry: 4, foyer: 3 },
  garage1Car: { mudroom: 9, kitchen: 5, utility: 5, laundry: 4, foyer: 3 },
  foyer: { living: 8, closet: 7, greatRoom: 6, powderRoom: 6, office: 5, stairwell: 5, dining: 4, kitchen: 3 },
  utility: { garage2Car: 6, laundry: 6, mudroom: 5, garage1Car: 4, kitchen: 3 },
  stairwell: { foyer: 6, living: 5, greatRoom: 4, office: 3, mudroom: 3 },

  // Generic / unrecognised room: a plausible spread of everyday neighbours.
  default: { kitchen: 6, living: 6, bedroom: 6, fullBath: 5, dining: 5, office: 4, foyer: 4, closet: 3 },
};

/**
 * Replace the live {@link ADJACENCY} table in place with `next`. Mutating the existing
 * object (rather than reassigning the binding) means every module that imported `ADJACENCY`
 * — chiefly the prediction functions below — sees the new weights immediately, with no
 * reload. Used by the dev Adjacency Matrix tool to apply edits (and Reset) live; the same
 * edits are also persisted to this source file via the `/__dev/adjacency` endpoint.
 */
export function applyAdjacency(next: Record<string, Record<string, number>>): void {
  for (const key of Object.keys(ADJACENCY)) delete ADJACENCY[key];
  for (const [source, row] of Object.entries(next)) {
    ADJACENCY[source] = { ...row };
  }
}

/** A predicted neighbour: a catalog room resolved to a size, plus its confidence. */
export interface PredictionOption {
  roomKey: string;
  label: string;
  widthFt: number;
  heightFt: number;
  /** Share of this source row's total weight (0..1). */
  confidence: number;
  /** 0 = most confident. */
  rank: number;
}

/**
 * Top `n` likely neighbours for a source room key, ranked by weight. `confidence`
 * is the weight's share of the FULL row total, so the percentages reflect the real
 * spread (the top 3 may sum to less than 100%). Unknown keys use the `default` row.
 */
export function predictNeighbors(
  sourceKey: string,
  n = 3,
): Array<{ key: string; confidence: number }> {
  const row = ADJACENCY[sourceKey] ?? ADJACENCY.default;
  const entries = Object.entries(row).filter(([, w]) => w > 0);
  const total = entries.reduce((sum, [, w]) => sum + w, 0) || 1;
  return entries
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, w]) => ({ key, confidence: w / total }));
}

/**
 * Resolve the top `n` predictions to full {@link PredictionOption}s (label + size
 * from the catalog). Drops any key that isn't a known catalog room.
 */
export function predictRoomOptions(sourceKey: string, n = 3): PredictionOption[] {
  return predictNeighbors(sourceKey, n)
    .map((p, rank) => {
      const def = findRoomByKey(p.key);
      if (!def) return null;
      return {
        roomKey: p.key,
        label: def.label,
        widthFt: def.widthFt,
        heightFt: def.heightFt,
        confidence: p.confidence,
        rank,
      } satisfies PredictionOption;
    })
    .filter((o): o is PredictionOption => o !== null);
}
