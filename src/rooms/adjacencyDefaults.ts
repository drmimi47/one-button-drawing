/**
 * ============================================================================
 *  ROOM ADJACENCY — factory defaults (frozen snapshot).
 * ============================================================================
 *
 * A verbatim copy of the original hand-tuned {@link ADJACENCY} table, kept in its
 * own file so the dev Adjacency Matrix tool's "Reset to defaults" always has a clean
 * baseline to revert to. The dev write-back endpoint (`/__dev/adjacency`) rewrites the
 * live table in `roomAdjacency.ts` but NEVER touches this file — so no matter how far a
 * developer edits prediction weights, the factory defaults survive and Reset works.
 *
 * If you intentionally want to bless an edited table as the new factory default, update
 * this snapshot to match `ADJACENCY` in roomAdjacency.ts.
 */
export const DEFAULT_ADJACENCY: Record<string, Record<string, number>> = {
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
