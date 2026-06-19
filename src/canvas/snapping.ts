import type { Square, Camera } from '../types';
import { worldToScreen, type Vec2 } from './coords';
import { footprintWorld } from './shapes';

/**
 * ============================================================================
 *  WALL-BASED ALIGNMENT & SNAPPING (move drags)
 * ============================================================================
 *
 * While a room is dragged, its wall lines snap to other rooms' wall lines and a green
 * guide marks the shared axis. Each wall contributes three candidate lines — inner face,
 * outer face, and centerline. Priority by thickness:
 *   - equal thickness  → ONLY center↔center (seamless: the wall bands merge), wide catch zone
 *   - differing thickness → a wall's OUTER face ↔ another's INNER face — BOTH directions
 *     (outer→inner and inner→outer, covering either room being dragged) is favoured (wide
 *     zone); outer↔outer flush is a narrow fallback that only unlocks AFTER the cross has
 *     fired once this drag; the centerline is skipped (the bands can't merge cleanly)
 *
 * A breakout force (hysteresis) keeps an engaged snap locked until the cursor pulls past a
 * larger threshold, then free dragging resumes. Any shape participates — rectangles, rooms
 * rotated to 90/180/270, edited quads, and irregular boolean N-gons — on a per-EDGE basis:
 * every wall edge that lands world-axis-aligned contributes lines; diagonal edges (off-axis
 * rotation, slanted free-form walls) simply don't, so they neither snap nor get snapped to.
 */

/** A drawn alignment guide: a full-viewport vertical (x) or horizontal (y) world line. */
export interface AlignGuide {
  axis: 'x' | 'y';
  /** World coordinate of the line (an X for 'x', a Y for 'y'). */
  world: number;
}

/** One candidate alignment line of a wall, along one world axis. */
interface SnapLine {
  /** World coordinate (X for a vertical wall, Y for a horizontal wall). */
  pos: number;
  kind: 'inner' | 'outer' | 'center';
  thickness: number;
}

/** A locked axis: the held delta `d`, the guide's world coordinate, and its priority. */
interface AxisLock {
  d: number;
  world: number;
  priority: number;
}

/** A locked vertex snap: the held 2-D delta, the touched world point, and its priority. */
interface CornerLock {
  dx: number;
  dy: number;
  /** World point the dragged corner is pinned to (drives the crossing guides). */
  wx: number;
  wy: number;
  priority: number;
}

/**
 * One snap candidate from a shape's corner — the wall junction's three reference points
 * (interior, outer/mitre, and centerline intersection) plus a representative thickness
 * (mean of the two adjacent walls) used to choose center-overlap vs. nested inner/outer.
 */
interface SnapCorner {
  inner: Vec2;
  outer: Vec2;
  center: Vec2;
  thickness: number;
}

/** Per-axis lock state carried across move frames (null = free on that axis). */
export interface SnapState {
  x: AxisLock | null;
  y: AxisLock | null;
  /** Active vertex (corner-to-corner) lock; when set it owns BOTH axes (x/y stay null). */
  corner: CornerLock | null;
  /**
   * True once a CROSS snap (outer↔inner, p1) has engaged this drag — from either a wall line
   * or a vertex. Until then the outer↔outer flush snap (p2) stays off so it can't pre-empt the
   * cross alignment; afterwards it turns on as a finer secondary option. Latched for the drag.
   */
  crossFired: boolean;
}

export const emptySnapState = (): SnapState => ({ x: null, y: null, corner: null, crossFired: false });

/** Cursor distance (screen px) at which the secondary (like-face flush) snap locks on. */
export const SNAP_ENGAGE_PX = 3;
/**
 * Wider lock-on distance for the FAVOURED snaps — the equal-thickness centerline and the
 * differing-thickness inner face — so they're easy to hit and clearly win over the outer face.
 */
export const SNAP_ENGAGE_WIDE_PX = 12;
/** Cursor distance (screen px) past the lock at which it releases (hysteresis). */
export const SNAP_BREAKOUT_PX = 18;
/** Radius (screen px) within which a dragged corner magnetises to a static corner. */
export const CORNER_ENGAGE_PX = 10;

const AXIS_EPS = 1e-3; // world units — an edge is axis-aligned within this
const THICK_EPS = 0.01; // world units — wall thicknesses are "equal" within this

/**
 * The wall snap lines of a shape, split by orientation. Works for any shape — rectangles,
 * rooms rotated to 90/180/270, edited quads, and irregular boolean N-gons — by walking the
 * world-space interior/outer footprint edge by edge ({@link footprintWorld}). Each edge that
 * lands world-axis-aligned emits inner/outer/center lines along that axis; diagonal edges
 * (off-axis rotation, slanted free-form walls) yield nothing, so they don't participate.
 */
export function wallSnapLines(shape: Square): { vertical: SnapLine[]; horizontal: SnapLine[] } {
  const vertical: SnapLine[] = [];
  const horizontal: SnapLine[] = [];
  const { inner, outer, thickness } = footprintWorld(shape);
  const n = inner.length;

  for (let i = 0; i < n; i++) {
    const ai = inner[i];
    const bi = inner[(i + 1) % n];
    const t = thickness[i];

    if (Math.abs(ai.x - bi.x) < AXIS_EPS) {
      // Vertical wall → constant world X. The outer face X comes from this edge's
      // outer corner (which lies on the outward-offset line of the same edge).
      const innerX = ai.x;
      const outerX = outer[i].x;
      vertical.push(
        { pos: innerX, kind: 'inner', thickness: t },
        { pos: outerX, kind: 'outer', thickness: t },
        { pos: (innerX + outerX) / 2, kind: 'center', thickness: t },
      );
    } else if (Math.abs(ai.y - bi.y) < AXIS_EPS) {
      // Horizontal wall → constant world Y.
      const innerY = ai.y;
      const outerY = outer[i].y;
      horizontal.push(
        { pos: innerY, kind: 'inner', thickness: t },
        { pos: outerY, kind: 'outer', thickness: t },
        { pos: (innerY + outerY) / 2, kind: 'center', thickness: t },
      );
    }
    // else: diagonal edge → not an alignment target.
  }
  return { vertical, horizontal };
}

/**
 * A shape's corner snap candidates — one per wall junction. Each carries the corner's
 * interior point, outer (mitre) point, centerline-intersection point (mean of the two), and
 * the mean of the two adjacent wall thicknesses (so equal walls overlap centerlines and
 * unequal walls nest outer-into-inner). Works for any shape via {@link footprintWorld}.
 */
export function shapeCorners(shape: Square): SnapCorner[] {
  const { inner, outer, thickness } = footprintWorld(shape);
  const n = inner.length;
  const corners: SnapCorner[] = [];
  for (let i = 0; i < n; i++) {
    // Corner i is the junction of edge (i-1) and edge i.
    const t = (thickness[(i + n - 1) % n] + thickness[i]) / 2;
    corners.push({
      inner: inner[i],
      outer: outer[i],
      center: { x: (inner[i].x + outer[i].x) / 2, y: (inner[i].y + outer[i].y) / 2 },
      thickness: t,
    });
  }
  return corners;
}

/**
 * Best vertex (corner-to-corner) snap, applying a 2-D breakout hysteresis (mutates nothing).
 * Matching by thickness, mirroring the wall-line scheme but pinning a full point:
 *   - equal thickness  → centerline corner ↔ centerline corner (priority 0; the bands overlap)
 *   - differing        → dragged OUTER corner ↔ static INNER corner, and dragged INNER ↔ static
 *                        OUTER (priority 1; the thicker wall's outer corner meets the thinner's
 *                        inner corner and vice-versa, so the walls nest at the junction)
 */
function pickCorner(
  dragged: SnapCorner[],
  statics: SnapCorner[],
  freeDx: number,
  freeDy: number,
  scale: number,
  locked: CornerLock | null,
): { dx: number; dy: number; lock: CornerLock | null } {
  // Locked: hold until the cursor pulls past the breakout (2-D), then fall through to re-pick.
  if (locked) {
    if (Math.hypot(freeDx - locked.dx, freeDy - locked.dy) * scale <= SNAP_BREAKOUT_PX) {
      return { dx: locked.dx, dy: locked.dy, lock: locked };
    }
  }

  let best: { dx: number; dy: number; wx: number; wy: number; priority: number; dist: number } | null =
    null;
  for (const dc of dragged) {
    for (const sc of statics) {
      const sameThick = Math.abs(dc.thickness - sc.thickness) <= THICK_EPS;
      // Each candidate pins a dragged point onto a static point.
      const pairs: { dp: Vec2; sp: Vec2; priority: number }[] = sameThick
        ? [{ dp: dc.center, sp: sc.center, priority: 0 }]
        : [
            { dp: dc.outer, sp: sc.inner, priority: 1 },
            { dp: dc.inner, sp: sc.outer, priority: 1 },
          ];
      for (const p of pairs) {
        const candDx = p.sp.x - p.dp.x;
        const candDy = p.sp.y - p.dp.y;
        const dist = Math.hypot(freeDx - candDx, freeDy - candDy) * scale;
        if (dist > CORNER_ENGAGE_PX) continue;
        if (
          !best ||
          p.priority < best.priority ||
          (p.priority === best.priority && dist < best.dist)
        ) {
          best = { dx: candDx, dy: candDy, wx: p.sp.x, wy: p.sp.y, priority: p.priority, dist };
        }
      }
    }
  }
  if (best) {
    return {
      dx: best.dx,
      dy: best.dy,
      lock: { dx: best.dx, dy: best.dy, wx: best.wx, wy: best.wy, priority: best.priority },
    };
  }
  return { dx: freeDx, dy: freeDy, lock: null };
}

/** Best snap offset for one axis, applying the breakout hysteresis (mutates nothing). */
function pickAxis(
  draggedBase: SnapLine[],
  staticLines: SnapLine[],
  freeD: number,
  scale: number,
  locked: AxisLock | null,
  crossFired: boolean,
): { d: number; lock: AxisLock | null } {
  // Locked: hold until the cursor pulls past the breakout, then fall through to re-pick.
  if (locked) {
    if (Math.abs(freeD - locked.d) * scale <= SNAP_BREAKOUT_PX) {
      return { d: locked.d, lock: locked };
    }
  }

  let best: { d: number; world: number; priority: number; dist: number } | null = null;
  for (const dl of draggedBase) {
    for (const sl of staticLines) {
      const sameThick = Math.abs(dl.thickness - sl.thickness) <= THICK_EPS;
      // Priority (lower = preferred):
      //   0 — equal thickness: centerline↔centerline (seamless, the bands merge)
      //   1 — differing thickness, CROSS: a wall's OUTER face ↔ another's INNER face — both
      //       directions (outer→inner and inner→outer), so it works whether the thick or
      //       the thin room is the one being dragged. Favoured, wide catch zone.
      //   2 — differing thickness: outer↔outer flush — only AFTER a cross (p1) snap has
      //       fired once this drag (`crossFired`); narrow catch zone.
      let priority: number;
      let tol: number;
      if (dl.kind === 'center' && sl.kind === 'center') {
        if (!sameThick) continue;
        priority = 0;
        tol = SNAP_ENGAGE_WIDE_PX;
      } else if (
        (dl.kind === 'outer' && sl.kind === 'inner') ||
        (dl.kind === 'inner' && sl.kind === 'outer')
      ) {
        if (sameThick) continue; // equal thickness is handled by the centerline
        priority = 1;
        tol = SNAP_ENGAGE_WIDE_PX;
      } else if (dl.kind === 'outer' && sl.kind === 'outer') {
        if (sameThick) continue;
        if (!crossFired) continue; // outer↔outer only after the cross has fired
        priority = 2;
        tol = SNAP_ENGAGE_PX;
      } else {
        continue; // any other kind combination isn't an alignment
      }
      const cand = sl.pos - dl.pos; // offset that lands the dragged line on the static line
      const dist = Math.abs(freeD - cand) * scale;
      if (dist > tol) continue;
      if (
        !best ||
        priority < best.priority ||
        (priority === best.priority && dist < best.dist)
      ) {
        best = { d: cand, world: sl.pos, priority, dist };
      }
    }
  }
  if (best) return { d: best.d, lock: { d: best.d, world: best.world, priority: best.priority } };
  return { d: freeD, lock: null };
}

/**
 * Resolve the snapped drag delta for a move. `draggedOrig` are the dragged shapes' geometry
 * at drag start (so lines are computed once and offset by the delta); `state` carries the
 * per-axis lock across frames and is mutated here. Returns the delta to apply + active guides.
 */
export function resolveWallSnap(
  draggedOrig: Square[],
  staticShapes: Square[],
  freeDx: number,
  freeDy: number,
  scale: number,
  state: SnapState,
): { dx: number; dy: number; guides: AlignGuide[] } {
  const staticV: SnapLine[] = [];
  const staticH: SnapLine[] = [];
  for (const s of staticShapes) {
    const lines = wallSnapLines(s);
    staticV.push(...lines.vertical);
    staticH.push(...lines.horizontal);
  }
  const baseV: SnapLine[] = [];
  const baseH: SnapLine[] = [];
  for (const s of draggedOrig) {
    const lines = wallSnapLines(s);
    baseV.push(...lines.vertical);
    baseH.push(...lines.horizontal);
  }

  const guides: AlignGuide[] = [];

  // Vertex pass first: a corner-to-corner match is the most specific snap, so when one
  // engages it owns BOTH axes and pre-empts the single-axis wall lines. Only fall through to
  // the line passes when no corner is in range (or an engaged one has just broken out).
  const staticCorners: SnapCorner[] = [];
  for (const s of staticShapes) staticCorners.push(...shapeCorners(s));
  const draggedCorners: SnapCorner[] = [];
  for (const s of draggedOrig) draggedCorners.push(...shapeCorners(s));

  if (staticCorners.length && draggedCorners.length) {
    const c = pickCorner(draggedCorners, staticCorners, freeDx, freeDy, scale, state.corner);
    if (c.lock) {
      state.corner = c.lock;
      state.x = null;
      state.y = null;
      // A cross vertex (p1) latches crossFired, just like a cross wall line.
      if (c.lock.priority === 1) state.crossFired = true;
      guides.push({ axis: 'x', world: c.lock.wx }, { axis: 'y', world: c.lock.wy });
      return { dx: c.dx, dy: c.dy, guides };
    }
  }
  state.corner = null;

  if (staticV.length && baseV.length) {
    const r = pickAxis(baseV, staticV, freeDx, scale, state.x, state.crossFired);
    state.x = r.lock;
    freeDx = r.d;
    if (r.lock) guides.push({ axis: 'x', world: r.lock.world });
  } else {
    state.x = null;
  }

  if (staticH.length && baseH.length) {
    const r = pickAxis(baseH, staticH, freeDy, scale, state.y, state.crossFired);
    state.y = r.lock;
    freeDy = r.d;
    if (r.lock) guides.push({ axis: 'y', world: r.lock.world });
  } else {
    state.y = null;
  }

  // Latch `crossFired` once a CROSS (p1) snap is engaged on either axis — sticky for the
  // rest of the drag, which is what unlocks the outer↔outer (p2) snap. The centerline (p0)
  // does NOT unlock it.
  const crossEngaged =
    (state.x != null && state.x.priority === 1) || (state.y != null && state.y.priority === 1);
  state.crossFired = state.crossFired || crossEngaged;

  return { dx: freeDx, dy: freeDy, guides };
}

/** Draw the active alignment guides as full-viewport green lines (CSS-pixel ctx). */
export function drawAlignmentGuides(
  ctx: CanvasRenderingContext2D,
  guides: AlignGuide[],
  camera: Camera,
  cssWidth: number,
  cssHeight: number,
): void {
  ctx.save();
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 1;
  for (const g of guides) {
    ctx.beginPath();
    if (g.axis === 'x') {
      const sx = Math.round(worldToScreen(g.world, 0, camera).x) + 0.5;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, cssHeight);
    } else {
      const sy = Math.round(worldToScreen(0, g.world, camera).y) + 0.5;
      ctx.moveTo(0, sy);
      ctx.lineTo(cssWidth, sy);
    }
    ctx.stroke();
  }
  ctx.restore();
}
