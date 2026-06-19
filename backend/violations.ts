import type { Square } from '../src/types';
import { wallThicknesses, edgeLengthsWorld, shapeAreaInUnit } from '../src/canvas/shapes';
import { WORLD_UNITS_PER_FOOT } from '../src/constants';
import type { Constraints } from './types';

/** A constraint field name — used to report exactly which rule(s) are broken. */
export type ConstraintKey = keyof Constraints;

/** Which rules a single room currently breaks. */
export interface ShapeViolations {
  /**
   * Interior-edge indices to flag (yellow strip): a wall thinner/thicker than the
   * thickness bounds, or a side shorter than the minimum side length.
   */
  flaggedEdges: number[];
  /**
   * Which constraint fields this room breaks (e.g. `minWallThicknessInches`,
   * `minRoomSideFt`, `maxRoomAreaSqft`). Lets callers map a violation back to the
   * exact rule that produced it — used to highlight the offending line in the
   * Constraints box. Per-shape rules only; global budgets are tracked separately.
   */
  flaggedKeys: ConstraintKey[];
  /** True when the interior area exceeds the maximum (yellow outline + readout). */
  areaOver: boolean;
  /** True when the interior area is below the minimum (yellow infill warning). */
  areaUnder: boolean;
  /** True when the room breaks any rule (cheap gate for the renderer). */
  any: boolean;
}

const EPS = 1e-6;

/**
 * Detect which constraints (if any) a single room violates. Pure and read-only —
 * it never mutates the shape: we flag offenders, we don't auto-fix them.
 *
 * Wall thickness compares each interior edge (via {@link wallThicknesses}) to the
 * min/max bound (inches → world). Side length compares each edge (via
 * {@link edgeLengthsWorld}) to the minimum (feet → world). Area always compares in
 * square feet regardless of the canvas's active display unit.
 */
export function findViolations(shape: Square, constraints: Constraints): ShapeViolations {
  const flagged = new Set<number>();
  const keys = new Set<ConstraintKey>();
  let areaOver = false;
  let areaUnder = false;

  if (constraints.minWallThicknessInches != null || constraints.maxWallThicknessInches != null) {
    const minWorld =
      constraints.minWallThicknessInches != null
        ? (constraints.minWallThicknessInches / 12) * WORLD_UNITS_PER_FOOT
        : -Infinity;
    const maxWorld =
      constraints.maxWallThicknessInches != null
        ? (constraints.maxWallThicknessInches / 12) * WORLD_UNITS_PER_FOOT
        : Infinity;
    const thick = wallThicknesses(shape);
    for (let i = 0; i < thick.length; i++) {
      // Flag a wall that is thinner than the minimum OR thicker than the maximum.
      if (thick[i] < minWorld - EPS) {
        flagged.add(i);
        keys.add('minWallThicknessInches');
      }
      if (thick[i] > maxWorld + EPS) {
        flagged.add(i);
        keys.add('maxWallThicknessInches');
      }
    }
  }

  if (constraints.minRoomSideFt != null) {
    const minSideWorld = constraints.minRoomSideFt * WORLD_UNITS_PER_FOOT;
    const lengths = edgeLengthsWorld(shape);
    for (let i = 0; i < lengths.length; i++) {
      if (lengths[i] < minSideWorld - EPS) {
        flagged.add(i);
        keys.add('minRoomSideFt');
      }
    }
  }

  if (constraints.maxRoomAreaSqft != null || constraints.minRoomAreaSqft != null) {
    const areaSqft = shapeAreaInUnit(shape, 'feet');
    if (constraints.maxRoomAreaSqft != null) {
      areaOver = areaSqft > constraints.maxRoomAreaSqft + EPS;
      if (areaOver) keys.add('maxRoomAreaSqft');
    }
    if (constraints.minRoomAreaSqft != null) {
      areaUnder = areaSqft < constraints.minRoomAreaSqft - EPS;
      if (areaUnder) keys.add('minRoomAreaSqft');
    }
  }

  return {
    flaggedEdges: [...flagged],
    flaggedKeys: [...keys],
    areaOver,
    areaUnder,
    any: flagged.size > 0 || areaOver || areaUnder,
  };
}
