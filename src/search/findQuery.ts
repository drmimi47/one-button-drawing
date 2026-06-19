import type { Square } from '../types';
import { type HandleId, shapeAreaInUnit } from '../canvas/shapes';
import { RESIDENTIAL_ROOMS, findRoomDef } from '../rooms/roomCatalog';
import { WORLD_UNITS_PER_FOOT } from '../constants';

/**
 * ============================================================================
 *  SMART FIND / SEARCH — the "Ctrl+F" half of the Generate box.
 * ============================================================================
 *
 * A prompt is routed to this module (instead of the LLM room generator) when it
 * READS like a search — "show me all kitchens", "highlight all 6\" walls". The
 * matching is fully local and synchronous (no API call), so it feels instant and
 * works with no API key. {@link findMatches} returns the rooms and wall segments
 * to wash in the accent blue; the draw layer (drawShapes) renders the highlight.
 *
 * This file is the tuning surface for what the search understands — add verbs to
 * {@link FIND_VERBS} or new matchers in {@link findMatches}.
 */

/** Phrases that mark a prompt as a find/search rather than a generate request. */
const FIND_VERBS = [
  'show me',
  'show all',
  'show the',
  'find',
  'highlight',
  'where',
  'which',
  'select all',
  'locate',
];

/** True when the prompt reads as a find/search (vs. a request to create rooms). */
export function isFindQuery(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  return FIND_VERBS.some((v) => t.startsWith(v) || t.includes(` ${v} `) || t.includes(v));
}

/** What a search resolved to: matched room ids, matched wall segments, and a total. */
export interface FindResult {
  /** Ids of rooms matched by type (e.g. every Kitchen) — washed blue whole. */
  roomIds: Set<string>;
  /** Per-room list of wall sides matched by thickness — only those bands wash blue. */
  wallMap: Map<string, HandleId[]>;
  /** roomIds.size + total matched wall sides; 0 means nothing matched. */
  count: number;
}

/** Every catalog key whose alias/label/key appears as a whole word in the query. */
function matchedRoomKeys(query: string): Set<string> {
  const keys = new Set<string>();
  for (const def of RESIDENTIAL_ROOMS) {
    const terms = [def.key, def.label, ...def.aliases].map((s) => s.toLowerCase());
    for (const term of terms) {
      // Whole-word match, tolerating a trailing plural "s" ("kitchens", "bedrooms").
      const re = new RegExp(`\\b${escapeRe(term)}s?\\b`, 'i');
      if (re.test(query)) {
        keys.add(def.key);
        break;
      }
    }
  }
  return keys;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse a thickness target out of the query, in WORLD units, or null if none.
 * Understands feet (`0.5'`, `0.5 ft`), inches (`6"`, `6 in`, `6 inch`), and a bare
 * number near the word "wall" (defaulting to inches, the natural wall unit).
 */
function wallThicknessTarget(query: string): number | null {
  // A wall query must actually mention "wall(s)". This both matches intent and keeps
  // an AREA query ("rooms over 150 ft²") from being misread as a wall search — the
  // "ft" inside "ft²"/"ft^2" would otherwise look like a feet unit.
  if (!/\bwalls?\b/i.test(query)) return null;

  const inch = query.match(/(\d+(?:\.\d+)?)\s*(?:"|''|in\b|inch(?:es)?\b)/i);
  if (inch) return (parseFloat(inch[1]) / 12) * WORLD_UNITS_PER_FOOT;

  const feet = query.match(/(\d+(?:\.\d+)?)\s*(?:'|ft\b|foot\b|feet\b)/i);
  if (feet) return parseFloat(feet[1]) * WORLD_UNITS_PER_FOOT;

  // Bare number alongside "wall" → treat as inches ("walls at 6").
  const bare = query.match(/\b(\d+(?:\.\d+)?)\b/);
  if (bare) return (parseFloat(bare[1]) / 12) * WORLD_UNITS_PER_FOOT;
  return null;
}

/** The default name given to a plain placed room/space (Square.name falls back to it). */
const DEFAULT_ROOM_NAME = 'room';

/** True when a shape carries the generic default name ("Room") rather than a type. */
function isDefaultRoom(shape: Square): boolean {
  return (shape.name ?? 'Room').trim().toLowerCase() === DEFAULT_ROOM_NAME;
}

/**
 * True when the query refers to the generic default rooms by the bare word
 * "room"/"rooms" — but only when no specific catalog type was named (so "living
 * rooms" stays a Living-Room search, while a plain "rooms" means the default ones).
 */
function wantsDefaultRooms(query: string, typeKeys: Set<string>): boolean {
  return typeKeys.size === 0 && /\brooms?\b/i.test(query);
}

/**
 * Parse an interior-area filter (ft²) from the query, or null if none. Understands
 * ft²/ft2/sqft/"sq ft"/"square feet"/sf, with a comparator: over/larger/bigger/
 * above/"more than"/"at least" → ≥; under/smaller/below/"less than"/"at most" → ≤;
 * none → approximately equal. Returns a predicate over a shape's ft² interior area.
 */
function areaPredicate(query: string): ((areaFt2: number) => boolean) | null {
  // Accept ft², ft2, ft^2 (caret), "ft 2", sqft, "sq ft", "square feet", sf.
  const unit = '(?:ft²|ft\\s*\\^?\\s*2|sq\\.?\\s*ft|sqft|square\\s*feet|square\\s*foot|sf)';
  const m = query.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${unit}`, 'i'));
  if (!m) return null;
  const value = parseFloat(m[1]);

  const greater =
    /\b(over|above|more than|greater than|larger than|bigger than|at least|min(?:imum)?)\b/i.test(
      query,
    ) || query.includes('>');
  const less =
    /\b(under|below|less than|smaller than|fewer than|at most|max(?:imum)?)\b/i.test(query) ||
    query.includes('<');

  if (greater && !less) return (a) => a >= value - 0.5; // forgiving of rounding
  if (less && !greater) return (a) => a <= value + 0.5;
  const tol = Math.max(5, value * 0.03); // "at 150 ft²" → within a small band
  return (a) => Math.abs(a - value) <= tol;
}

/** Thickness of one edge of a shape (named side for rects, indexed for free polys). */
function edgeThickness(shape: Square, side: 'n' | 'e' | 's' | 'w', index: number): number {
  if (shape.wallEdges && shape.wallEdges.length > index) return shape.wallEdges[index];
  return shape.walls[side];
}

const SIDES: ('n' | 'e' | 's' | 'w')[] = ['n', 'e', 's', 'w'];

/** Match a thickness in world units (±0.5 wu ≈ ±0.05 ft tolerance). */
const THICK_TOL = 0.5;

/**
 * Resolve a find query against the current shapes. Room-type and wall-thickness
 * matchers run independently and both contribute (so "kitchen walls at 6\"" can
 * highlight Kitchen interiors AND their 6" wall bands).
 */
export function findMatches(text: string, shapes: Square[]): FindResult {
  const query = text.toLowerCase();
  const roomIds = new Set<string>();
  const wallMap = new Map<string, HandleId[]>();

  const keys = matchedRoomKeys(query);
  const wantsDefault = wantsDefaultRooms(query, keys);
  const areaTest = areaPredicate(query);
  const target = wallThicknessTarget(query);

  const hasTypeCriteria = keys.size > 0 || wantsDefault;
  const hasWallQuery = target != null;
  // Nothing to search for (e.g. an unrecognised find phrase) → no matches.
  if (!hasTypeCriteria && areaTest == null && !hasWallQuery) {
    return { roomIds, wallMap, count: 0 };
  }

  // A shape passes the type gate when no type was named, or its name resolves to one
  // of the named catalog types, or it's a default "Room" and the query said "rooms".
  const passesType = (shape: Square): boolean => {
    if (!hasTypeCriteria) return true;
    const def = shape.name ? findRoomDef(shape.name) : null;
    if (def != null && keys.has(def.key)) return true;
    return wantsDefault && isDefaultRoom(shape);
  };

  for (const shape of shapes) {
    // 1) Filter by TYPE first — only shapes of the asked-for kind go further.
    if (!passesType(shape)) continue;
    // 2) Then filter by AREA (the room's white-infill ft²), if the query gave one.
    if (areaTest != null && !areaTest(shapeAreaInUnit(shape, 'feet'))) continue;

    if (hasWallQuery) {
      // 3a) Wall query: wash just the matching wall bands of this (already type/area
      // filtered) shape. When a type was named ("rooms with 6\" walls") the room is
      // also washed so it clearly reads as a match; a bare wall query lights only walls.
      const edges = shape.wallEdges ? shape.wallEdges.length : SIDES.length;
      const hit: HandleId[] = [];
      for (let i = 0; i < edges; i++) {
        const side = SIDES[i] ?? 'n';
        if (Math.abs(edgeThickness(shape, side, i) - target) <= THICK_TOL) {
          // Free polygons key their walls by numeric edge index; rects by side.
          hit.push(shape.wallEdges ? i : side);
        }
      }
      if (hit.length > 0) {
        wallMap.set(shape.id, hit);
        if (hasTypeCriteria) roomIds.add(shape.id);
      }
    } else {
      // 3b) Room/area query: wash the whole interior of the matching room.
      roomIds.add(shape.id);
    }
  }

  // Walls on a shape already washed as a room don't add to the count twice.
  let wallCount = 0;
  for (const [id, sides] of wallMap) if (!roomIds.has(id)) wallCount += sides.length;

  return { roomIds, wallMap, count: roomIds.size + wallCount };
}
