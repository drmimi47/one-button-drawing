import type { ReactNode } from 'react';
import styles from './StatsBar.module.css';

interface StatsBarProps {
  /** The Dev toggle, pinned bottom-left (level with the nav cluster). */
  children: ReactNode;
  /** Element shown beneath the Dev toggle while it's on (the FPS meter). */
  rightAddon?: ReactNode;
  /** Stats fade in once at least one room is on the canvas. */
  visible: boolean;
  roomCount: number;
  /** When true, the global Max Room Count limit is exceeded — flag this readout. */
  roomCountExceeded: boolean;
  /** Gross Internal Area (GIA) — Σ room interiors. */
  totalAreaSqft: number;
  /** When true, the global Max Total Area budget is exceeded — flags the GIA readout. */
  totalAreaExceeded: boolean;
  /** Gross Floor Area (GFA) — Σ room footprints incl. walls. */
  grossAreaSqft: number;
  /** When true, the global Max Total Gross Area budget is exceeded — flags the GFA readout. */
  grossAreaExceeded: boolean;
  /** Usable Floor Area (UFA) — Σ interior of usable rooms (excl. circulation/service). */
  usableAreaSqft: number;
  /** Screen edges of the central nav pill, used to centre each pair beside it. */
  navBounds: { left: number; right: number } | null;
  /** Current viewport width, to centre the right pair against the right edge. */
  viewportWidth: number;
}

/** Space reserved at each screen edge so a stat group never collides with the menu. */
const EDGE_INSET = 120;

function Stat({
  label,
  value,
  unit,
  alert,
  tooltip,
}: {
  label: string;
  value: number;
  /** Shown after the label on the caption line (e.g. "ft²", "%"); omit for none. */
  unit?: string;
  alert?: boolean;
  tooltip?: string;
}) {
  return (
    <span
      className={`${styles.stat}${alert ? ` ${styles.alert}` : ''}`}
      title={tooltip}
    >
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statLabel}>{unit ? `${label} ${unit}` : label}</span>
    </span>
  );
}

/**
 * Live statistics along the bottom edge: two groups of three readouts, each centred on
 * its half of the screen (the central nav menu sits at 50%, so the groups sit at
 * ~25% / ~75%). They fade in the moment the first room is placed and out when emptied.
 * The Dev toggle + FPS meter live separately in the bottom-left corner.
 *
 * Area metrics (all derived from the per-room interior + gross sums):
 *  - GFA — Gross Floor Area, to the outside face of walls (Σ interior + walls).
 *  - GIA — Gross Internal Area, to the inside face of walls (Σ interior).
 *  - UFA — Usable Floor Area (Σ interior of usable rooms; excl. circulation/service).
 *  - NIA % — Net Internal share: UFA ÷ GIA × 100.
 *  - Efficiency — GIA ÷ GFA × 100 (how little floor is lost to wall thickness).
 */
export function StatsBar({
  children,
  rightAddon,
  visible,
  roomCount,
  roomCountExceeded,
  totalAreaSqft,
  totalAreaExceeded,
  grossAreaSqft,
  grossAreaExceeded,
  usableAreaSqft,
  navBounds,
  viewportWidth,
}: StatsBarProps) {
  const show = visible ? styles.show : '';

  // Efficiency: internal area as a share of the gross footprint (100% = zero walls).
  const efficiency = grossAreaSqft > 0 ? Math.round((totalAreaSqft / grossAreaSqft) * 100) : 0;
  // NIA %: usable area as a share of the gross internal area (higher = more efficient).
  const niaPct = totalAreaSqft > 0 ? Math.round((usableAreaSqft / totalAreaSqft) * 100) : 0;

  // Centre each group in the gap between the central menu and the reserved edge
  // (Debug on the left, FPS on the right). Falls back to the screen quarters
  // until the menu has been measured (the groups are hidden then anyway).
  const leftCenter = navBounds
    ? (EDGE_INSET + navBounds.left) / 2
    : viewportWidth * 0.25;
  const rightCenter = navBounds
    ? (navBounds.right + (viewportWidth - EDGE_INSET)) / 2
    : viewportWidth * 0.75;

  return (
    <>
      {/* Bottom-left dev cluster: the Debug toggle, with its tools (FPS/ms, and more
          to come) stacked left-justified above it once Debug is on. */}
      <div className={styles.debug}>
        {children}
        {rightAddon && <div className={styles.devTools}>{rightAddon}</div>}
      </div>

      <div className={`${styles.pair} ${show}`} style={{ left: `${leftCenter}px` }}>
        <Stat
          label="GFA"
          value={grossAreaSqft}
          unit="ft²"
          alert={grossAreaExceeded}
          tooltip="Gross Floor Area"
        />
        <Stat
          label="GIA"
          value={totalAreaSqft}
          unit="ft²"
          alert={totalAreaExceeded}
          tooltip="Gross Internal Area"
        />
        <Stat
          label="Efficiency"
          value={efficiency}
          unit="%"
          tooltip="Gross Internal Area ÷ Gross Floor Area × 100"
        />
      </div>

      <div className={`${styles.pair} ${show}`} style={{ left: `${rightCenter}px` }}>
        <Stat
          label="Room Count"
          value={roomCount}
          alert={roomCountExceeded}
          tooltip="Number of rooms placed"
        />
        <Stat
          label="NIA"
          value={niaPct}
          unit="%"
          tooltip="Net Internal Area"
        />
        <Stat
          label="UFA"
          value={usableAreaSqft}
          unit="ft²"
          tooltip="Usable Floor Area"
        />
      </div>
    </>
  );
}
