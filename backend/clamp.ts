import type { Square } from '../src/types';
import { wallThicknesses, edgeLengthsWorld, shapeAreaInUnit } from '../src/canvas/shapes';
import { WORLD_UNITS_PER_FOOT } from '../src/constants';
import { hasAnyConstraint, type Constraints } from './types';

const EPS = 1e-6;

/**
 * Would `candidate` push a metric the WRONG way past a bound it must respect?
 *
 * Each metric may never move further beyond its bound than where it started:
 *  - A compliant metric is held at the bound — it can't be carried across (the
 *    original hard lock).
 *  - An already-violating metric (the shape is flagged on it) is held at its CURRENT
 *    value — the user may only adjust it toward compliance (or leave it as is), never
 *    make it worse. The flagged part can be kept; it just can't get more out of spec.
 *
 * Concretely, for a minimum bound `lo` the allowed floor is `min(original, lo)`, and
 * for a maximum bound `hi` the allowed ceiling is `max(original, hi)`. This is
 * per-metric and per-edge, so one flagged side never freezes the rest of the shape —
 * any edit that doesn't worsen that side's own metric is still allowed.
 */
export function worsensConstraints(candidate: Square, original: Square, c: Constraints): boolean {
  // Wall thickness — each side within [min, max] inches (→ world units).
  if (c.minWallThicknessInches != null || c.maxWallThicknessInches != null) {
    const lo =
      c.minWallThicknessInches != null
        ? (c.minWallThicknessInches / 12) * WORLD_UNITS_PER_FOOT
        : -Infinity;
    const hi =
      c.maxWallThicknessInches != null
        ? (c.maxWallThicknessInches / 12) * WORLD_UNITS_PER_FOOT
        : Infinity;
    const ct = wallThicknesses(candidate);
    const ot = wallThicknesses(original);
    const n = Math.min(ct.length, ot.length);
    for (let i = 0; i < n; i++) {
      if (ct[i] < Math.min(ot[i], lo) - EPS) return true; // thinner than allowed
      if (ct[i] > Math.max(ot[i], hi) + EPS) return true; // thicker than allowed
    }
  }

  // Side length — each interior edge ≥ min feet. A too-short side may only grow.
  if (c.minRoomSideFt != null) {
    const lo = c.minRoomSideFt * WORLD_UNITS_PER_FOOT;
    const cl = edgeLengthsWorld(candidate);
    const ol = edgeLengthsWorld(original);
    const n = Math.min(cl.length, ol.length);
    for (let i = 0; i < n; i++) {
      if (cl[i] < Math.min(ol[i], lo) - EPS) return true; // shorter than allowed
    }
  }

  // Interior area — within [min, max] square feet. A too-small room may only grow; a
  // too-large one may only shrink.
  if (c.minRoomAreaSqft != null || c.maxRoomAreaSqft != null) {
    const ca = shapeAreaInUnit(candidate, 'feet');
    const oa = shapeAreaInUnit(original, 'feet');
    if (c.minRoomAreaSqft != null && ca < Math.min(oa, c.minRoomAreaSqft) - EPS) return true;
    if (c.maxRoomAreaSqft != null && ca > Math.max(oa, c.maxRoomAreaSqft) + EPS) return true;
  }

  return false;
}

/**
 * Clamp a drag so it never worsens a constraint. `makeCandidate(dx, dy)` builds
 * the proposed geometry from a world delta; we apply the full delta when it's
 * acceptable, otherwise binary-search the largest fraction of it that is — so the
 * dragged edge stops at the constraint boundary instead of crossing it.
 */
export function clampDragToConstraints(
  makeCandidate: (dx: number, dy: number) => Square,
  original: Square,
  dx: number,
  dy: number,
  constraints: Constraints,
): Square {
  const full = makeCandidate(dx, dy);
  if (!hasAnyConstraint(constraints) || !worsensConstraints(full, original, constraints)) {
    return full;
  }
  let lo = 0; // fraction of the delta that is acceptable
  let hi = 1; // fraction known to violate
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (worsensConstraints(makeCandidate(mid * dx, mid * dy), original, constraints)) hi = mid;
    else lo = mid;
  }
  return makeCandidate(lo * dx, lo * dy);
}
