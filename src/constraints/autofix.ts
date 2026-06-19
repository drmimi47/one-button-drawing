import type { Square } from '../types';
import {
  wallThicknesses,
  edgeLengthsWorld,
  shapeAreaInUnit,
  shapeGrossAreaInUnit,
  withEdgeThickness,
} from '../canvas/shapes';
import { WORLD_UNITS_PER_FOOT, MIN_WALL_WORLD } from '../constants';
import { worsensConstraints } from '../../backend/clamp';
import type { Constraints } from '../../backend/types';

/**
 * ============================================================================
 *  CONSTRAINT AUTO-FIX — the deterministic brain behind the Constraints "Fix"
 *  wand. Pure + synchronous (no LLM).
 * ============================================================================
 *
 * It works at PER-VIOLATION granularity: one entry per (room, broken rule, edge),
 * each with a single-purpose corrected geometry. The UI steps through them, zooming
 * to each room and showing the proposal as a ghost for Approve/Skip/Reject. Because
 * fixes can interact (growing a room to hit min-area can re-break min-side), the
 * caller RE-ENUMERATES after every applied fix instead of trusting a stale list.
 *
 * Reuses the same thresholds as {@link findViolations} and the geometry primitives
 * ({@link withEdgeThickness}, {@link scaledToArea}) + {@link worsensConstraints}.
 */

const EPS = 1e-6;

export type FixKind = 'wallThin' | 'wallThick' | 'sideShort' | 'areaUnder' | 'areaOver';

/** One concrete rule break on one room (a single step in the Fix flow). */
export interface Violation {
  shapeId: string;
  kind: FixKind;
  /** Interior edge index for wall/side violations; undefined for area. */
  edge?: number;
  /** Short heading, e.g. "Wall too thin". */
  title: string;
  /** Human "current → target", e.g. `North wall 2" → 4"`. */
  detail: string;
}

/** A proposed correction for one {@link Violation}. */
export interface Proposal {
  /** Corrected room, or null when it can't be auto-fixed (e.g. free-polygon side). */
  fixed: Square | null;
  /** True if the proposal actually clears this violation. */
  resolves: boolean;
  /** True if the proposal pushes some OTHER rule further out of spec. */
  worsensOthers: boolean;
}

/** A global budget breach that Fix reports but never edits automatically. */
export interface GlobalNote {
  key: 'maxRoomCount' | 'maxTotalAreaSqft' | 'maxTotalGrossAreaSqft';
  detail: string;
}

/** A stable id for a violation, so the flow can mark one "skipped". */
export function violationKey(v: Violation): string {
  return `${v.shapeId}|${v.kind}|${v.edge ?? ''}`;
}

/** The current step of a running Fix session (one violation under review). */
export interface FixStep {
  done: false;
  shapeId: string;
  /** Heading, e.g. "Wall too thin". */
  title: string;
  /** "current → target" detail line. */
  detail: string;
  /** False when there's no automatic proposal (Approve disabled — manual only). */
  canAutoFix: boolean;
  /** True when the proposal would push another rule out of spec (shown as a caution). */
  worsensOthers: boolean;
  /** Violations resolved so far this session. */
  fixedCount: number;
  /** Violations still outstanding (including this one). */
  remaining: number;
}

/** The terminal state of a Fix session (nothing left to review). */
export interface FixDone {
  done: true;
  fixedCount: number;
  /** Per-room violations still present at the end (skipped or not auto-fixable). */
  unresolved: number;
  globalNotes: GlobalNote[];
}

export type FixResult = FixStep | FixDone;

// ---- unit + formatting helpers ----------------------------------------------

const inchesToWorld = (inch: number) => (inch / 12) * WORLD_UNITS_PER_FOOT;
const worldToInches = (w: number) => (w / WORLD_UNITS_PER_FOOT) * 12;
const worldToFeet = (w: number) => w / WORLD_UNITS_PER_FOOT;

/** Trim to at most one decimal (e.g. 4, 4.5 — never "4.0"). */
function num(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

/** Name an interior edge: N/E/S/W for a rectangle, else "Edge n". */
function edgeName(shape: Square, edge: number): string {
  const count = shape.corners ? shape.corners.length : 4;
  if (count === 4) return ['North', 'East', 'South', 'West'][edge] ?? `Edge ${edge + 1}`;
  return `Edge ${edge + 1}`;
}

// ---- enumeration ------------------------------------------------------------

/**
 * Every per-violation entry for one room, in fix-priority order: room-too-SMALL first, then
 * walls, then sides, then room-too-large. Growing a too-small room is done up front because a
 * uniform area fix lengthens every side in proportion — which often clears too-short walls for
 * free, sparing a flurry of redundant side-length fixes. (Shrinking a too-LARGE room can do the
 * opposite, so that one stays last; the flow re-enumerates after every fix and catches any
 * side it re-breaks.)
 */
function violationsForShape(shape: Square, c: Constraints): Violation[] {
  const out: Violation[] = [];

  const areaSqft =
    c.minRoomAreaSqft != null || c.maxRoomAreaSqft != null ? shapeAreaInUnit(shape, 'feet') : 0;

  // Room too small → fix first (uniform grow).
  if (c.minRoomAreaSqft != null && areaSqft < c.minRoomAreaSqft - EPS) {
    out.push({
      shapeId: shape.id,
      kind: 'areaUnder',
      title: 'Room too small',
      detail: `${num(areaSqft)} ft² → ${num(c.minRoomAreaSqft)} ft²`,
    });
  }

  if (c.minWallThicknessInches != null || c.maxWallThicknessInches != null) {
    const lo = c.minWallThicknessInches != null ? inchesToWorld(c.minWallThicknessInches) : -Infinity;
    const hi = c.maxWallThicknessInches != null ? inchesToWorld(c.maxWallThicknessInches) : Infinity;
    const thick = wallThicknesses(shape);
    for (let i = 0; i < thick.length; i++) {
      if (thick[i] < lo - EPS) {
        out.push({
          shapeId: shape.id,
          kind: 'wallThin',
          edge: i,
          title: 'Wall too thin',
          detail: `${edgeName(shape, i)} wall ${num(worldToInches(thick[i]))}" → ${num(c.minWallThicknessInches!)}"`,
        });
      } else if (thick[i] > hi + EPS) {
        out.push({
          shapeId: shape.id,
          kind: 'wallThick',
          edge: i,
          title: 'Wall too thick',
          detail: `${edgeName(shape, i)} wall ${num(worldToInches(thick[i]))}" → ${num(c.maxWallThicknessInches!)}"`,
        });
      }
    }
  }

  if (c.minRoomSideFt != null) {
    const minSide = c.minRoomSideFt * WORLD_UNITS_PER_FOOT;
    const lens = edgeLengthsWorld(shape);
    for (let i = 0; i < lens.length; i++) {
      if (lens[i] < minSide - EPS) {
        out.push({
          shapeId: shape.id,
          kind: 'sideShort',
          edge: i,
          title: 'Side too short',
          detail: `${edgeName(shape, i)} side ${num(worldToFeet(lens[i]))}' → ${num(c.minRoomSideFt)}'`,
        });
      }
    }
  }

  // Room too large → fix last (shrinking can re-break sides; re-enumeration catches them).
  if (c.maxRoomAreaSqft != null && areaSqft > c.maxRoomAreaSqft + EPS) {
    out.push({
      shapeId: shape.id,
      kind: 'areaOver',
      title: 'Room too large',
      detail: `${num(areaSqft)} ft² → ${num(c.maxRoomAreaSqft)} ft²`,
    });
  }

  return out;
}

/** All per-violation entries across every room, room-by-room in array order. */
export function enumerateViolations(shapes: Square[], c: Constraints): Violation[] {
  const out: Violation[] = [];
  for (const s of shapes) out.push(...violationsForShape(s, c));
  return out;
}

// ---- proposal ---------------------------------------------------------------

const worldCenter = (s: Square) => ({ x: s.x + s.width / 2, y: s.y + s.height / 2 });

/** A throwaway reference shape whose interior area equals `targetSqft` (for scaledToArea). */
/**
 * Re-seat a shape's scaled (centre-origin) local corners: recentre them on their new
 * bbox, sync width/height, and hold the world centre fixed so the room doesn't jump.
 */
function rebuildFromCorners(shape: Square, scaled: { x: number; y: number }[]): Square {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of scaled) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const cxL = (minX + maxX) / 2;
  const cyL = (minY + maxY) / 2;
  const rad = (shape.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const wcx = shape.x + shape.width / 2 + (cxL * cos - cyL * sin);
  const wcy = shape.y + shape.height / 2 + (cxL * sin + cyL * cos);
  const corners = scaled.map((p) => ({ x: p.x - cxL, y: p.y - cyL }));
  const newW = maxX - minX;
  const newH = maxY - minY;
  return { ...shape, corners, width: newW, height: newH, x: wcx - newW / 2, y: wcy - newH / 2 };
}

/**
 * Bring a room's interior area to `targetSqft` by scaling the room UNIFORMLY about its
 * centre — every wall moves out (under-min) or in (over-max) by the same proportion, so the
 * room keeps its exact proportions (no deformation) and simply grows/shrinks evenly on all
 * sides. The linear scale is √(target / current) because area grows with its square.
 */
function fixArea(shape: Square, targetSqft: number): Square | null {
  const cur = shapeAreaInUnit(shape, 'feet');
  if (cur < 1e-9) return null;
  const k = Math.sqrt(targetSqft / cur);
  if (Math.abs(k - 1) < 1e-9) return shape;

  // Rectangle: scale width and height by the same factor, holding the world centre.
  if (!shape.corners) {
    const ctr = worldCenter(shape);
    const width = shape.width * k;
    const height = shape.height * k;
    return { ...shape, width, height, x: ctr.x - width / 2, y: ctr.y - height / 2 };
  }

  // Free polygon: scale every corner uniformly about the centroid (local origin); the world
  // centre is held by rebuildFromCorners, so the room expands/contracts evenly in place.
  const scaled = shape.corners.map((p) => ({ x: p.x * k, y: p.y * k }));
  return rebuildFromCorners(shape, scaled);
}

/** Local centre-origin corners for any room — explicit (free polygon) or derived (rectangle). */
function localPts(shape: Square): { x: number; y: number }[] {
  if (shape.corners && shape.corners.length >= 3) return shape.corners.map((p) => ({ x: p.x, y: p.y }));
  const hw = shape.width / 2;
  const hh = shape.height / 2;
  return [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ];
}

/**
 * The (up to two) single-wall ways to lengthen interior edge `e` to `target`. A too-short edge
 * is bordered by two adjacent walls — the one meeting its START vertex and the one meeting its
 * END vertex — and sliding EITHER of them outward (along the edge's own line) makes the edge
 * legal. Each candidate keeps the moved wall rigid (parallel to itself) and only that one wall
 * moves; the rest of the room stays put. On an irregular room the two moves change the area by
 * different amounts (and one may even shrink it), which is exactly why the caller compares them.
 */
function sideShortCandidates(shape: Square, e: number, target: number): Square[] {
  const pts = localPts(shape);
  const n = pts.length;
  const a = pts[e];
  const b = pts[(e + 1) % n];
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  if (L < 1e-6 || L >= target) return [];
  const ux = (b.x - a.x) / L;
  const uy = (b.y - a.y) / L;
  const d = target - L;

  // A — slide the wall BEFORE the edge (corners e-1 → e) back along -u: the start vertex
  // moves out by d, pinning the end side of the room.
  const A = pts.map((p, i) =>
    i === e || i === (e - 1 + n) % n ? { x: p.x - ux * d, y: p.y - uy * d } : { x: p.x, y: p.y },
  );
  // B — slide the wall AFTER the edge (corners e+1 → e+2) along +u: the end vertex moves out
  // by d, pinning the start side of the room.
  const B = pts.map((p, i) =>
    i === (e + 1) % n || i === (e + 2) % n ? { x: p.x + ux * d, y: p.y + uy * d } : { x: p.x, y: p.y },
  );
  return [rebuildFromCorners(shape, A), rebuildFromCorners(shape, B)];
}

/** Build the corrected geometry for a single violation (or null if not auto-fixable). */
function buildFixed(shape: Square, v: Violation, c: Constraints): Square | null {
  switch (v.kind) {
    case 'wallThin':
      return withEdgeThickness(shape, v.edge!, Math.max(MIN_WALL_WORLD, inchesToWorld(c.minWallThicknessInches!)));
    case 'wallThick':
      return withEdgeThickness(shape, v.edge!, inchesToWorld(c.maxWallThicknessInches!));
    case 'sideShort': {
      const target = c.minRoomSideFt! * WORLD_UNITS_PER_FOOT;
      // Rectangle: extend ONLY the offending dimension, and in a SINGLE direction — pin
      // the NW corner where it is and push the opposite wall out by exactly the shortfall.
      // Holding a corner (rather than the centre) keeps the stretch one-directional, so the
      // room grows on one side instead of bulging out symmetrically into a deformed result.
      if (!shape.corners) {
        const widthEdge = v.edge === 0 || v.edge === 2; // edges 0/2 = width, 1/3 = height
        const newW = widthEdge ? Math.max(shape.width, target) : shape.width;
        const newH = widthEdge ? shape.height : Math.max(shape.height, target);
        const dW = newW - shape.width;
        const dH = newH - shape.height;
        // Slide the centre half the added length along the local growth axis so the NW
        // corner's world position is unchanged (local +x = east, +y = south).
        const rad = (shape.rotation * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const cx = shape.x + shape.width / 2 + (cos * (dW / 2) - sin * (dH / 2));
        const cy = shape.y + shape.height / 2 + (sin * (dW / 2) + cos * (dH / 2));
        return { ...shape, width: newW, height: newH, x: cx - newW / 2, y: cy - newH / 2 };
      }
      // Free quad / polygon: there are two single-wall moves that lengthen the edge (slide the
      // wall on its start side out, or the wall on its end side out). Both reach the minimum
      // length, but on an irregular room they change the area differently. Build both, DROP any
      // that would shrink the room, and keep the one that adds the most square footage — never
      // propose the solution that loses area.
      const before = shapeAreaInUnit(shape, 'feet');
      const cands = sideShortCandidates(shape, v.edge!, target)
        .filter((s) => shapeAreaInUnit(s, 'feet') >= before - EPS)
        .sort((p, q) => shapeAreaInUnit(q, 'feet') - shapeAreaInUnit(p, 'feet'));
      return cands[0] ?? null;
    }
    case 'areaUnder':
      return fixArea(shape, c.minRoomAreaSqft!);
    case 'areaOver':
      return fixArea(shape, c.maxRoomAreaSqft!);
  }
}

/** Propose a correction for one violation, reporting whether it resolves / side-effects. */
export function proposeFix(shape: Square, v: Violation, c: Constraints): Proposal {
  const fixed = buildFixed(shape, v, c);
  if (!fixed) return { fixed: null, resolves: false, worsensOthers: false };
  // Did THIS violation clear? (the same kind+edge must be gone from the fixed shape)
  const still = violationsForShape(fixed, c).some((w) => w.kind === v.kind && w.edge === v.edge);
  return {
    fixed,
    resolves: !still,
    worsensOthers: worsensConstraints(fixed, shape, c),
  };
}

// ---- global budgets (reported only) -----------------------------------------

/** Global budget breaches Fix can't resolve by editing one room — surfaced as notes. */
export function globalNotes(shapes: Square[], c: Constraints): GlobalNote[] {
  const notes: GlobalNote[] = [];

  if (c.maxRoomCount != null && shapes.length > c.maxRoomCount) {
    notes.push({
      key: 'maxRoomCount',
      detail: `${shapes.length} rooms — ${shapes.length - c.maxRoomCount} over the limit of ${c.maxRoomCount}. Delete rooms to resolve.`,
    });
  }

  if (c.maxTotalAreaSqft != null) {
    const total = shapes.reduce((a, s) => a + shapeAreaInUnit(s, 'feet'), 0);
    if (total > c.maxTotalAreaSqft + EPS) {
      notes.push({
        key: 'maxTotalAreaSqft',
        detail: `Total area ${num(total)} ft² — ${num(total - c.maxTotalAreaSqft)} ft² over budget. Shrink or delete rooms.`,
      });
    }
  }

  if (c.maxTotalGrossAreaSqft != null) {
    const gross = shapes.reduce((a, s) => a + shapeGrossAreaInUnit(s, 'feet'), 0);
    if (gross > c.maxTotalGrossAreaSqft + EPS) {
      notes.push({
        key: 'maxTotalGrossAreaSqft',
        detail: `Gross area ${num(gross)} ft² — ${num(gross - c.maxTotalGrossAreaSqft)} ft² over budget. Shrink or delete rooms.`,
      });
    }
  }

  return notes;
}
