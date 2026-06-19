/**
 * Structured floorplan constraints — the single source of truth the rest of the
 * app enforces. The natural-language Constraints box is parsed into this shape
 * (by the LLM, or a regex fallback); the canvas reads it every frame to flag any
 * room that breaks a rule. Add fields here as the constraint vocabulary grows.
 */
export interface Constraints {
  /** Every wall side must be at least this thick, in inches. */
  minWallThicknessInches?: number;
  /** No wall side may be thicker than this, in inches. */
  maxWallThicknessInches?: number;
  /** A room's interior area must not exceed this, in square feet. */
  maxRoomAreaSqft?: number;
  /** A room's interior area must be at least this, in square feet. */
  minRoomAreaSqft?: number;
  /** No room side (interior edge) may be shorter than this, in feet. */
  minRoomSideFt?: number;
  /**
   * The summed interior area of ALL rooms must not exceed this, in square feet — a
   * GLOBAL budget (not per-room). Breaking it washes the whole canvas yellow until
   * enough rooms are deleted to get back under budget; it never clamps a drag.
   */
  maxTotalAreaSqft?: number;
  /**
   * The summed GROSS area of ALL rooms — each room's outer footprint (interior plus
   * its wall band) — must not exceed this, in square feet. Like {@link maxTotalAreaSqft}
   * it's a global, flag-only budget: breaking it washes the canvas yellow until rooms
   * are deleted back under budget.
   */
  maxTotalGrossAreaSqft?: number;
  /**
   * The total number of rooms on the floorplan must not exceed this (a global,
   * flag-only count). Breaking it washes the canvas yellow until rooms are deleted
   * back under the limit; it never blocks placement.
   */
  maxRoomCount?: number;
}

/** No rules set — the canvas does zero per-shape work in this state. */
export const EMPTY_CONSTRAINTS: Constraints = {};

/** True when at least one rule is set (lets hot paths skip checks entirely). */
export function hasAnyConstraint(c: Constraints): boolean {
  return (
    c.minWallThicknessInches != null ||
    c.maxWallThicknessInches != null ||
    c.maxRoomAreaSqft != null ||
    c.minRoomAreaSqft != null ||
    c.minRoomSideFt != null ||
    c.maxTotalAreaSqft != null ||
    c.maxTotalGrossAreaSqft != null ||
    c.maxRoomCount != null
  );
}
