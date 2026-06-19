import type { OptimizeStrategy } from '../../facade/partition';
import styles from './FacadePanel.module.css';

interface FacadePanelProps {
  layerCount: number;
  activeIndex: number;
  /** True when the active layer has no boundary yet (prompts the user to draw one). */
  drawing: boolean;
  /** Border sub-mode on (editing the trim boundary) vs off (a Panels tab is active, border locked). */
  borderMode: boolean;
  /** Material-ID (segmentation) view on/off. */
  idView: boolean;
  /** Purely-visual drop shadow under the per-group frame bands on/off. */
  frameShadow: boolean;
  /** Whether the Optimize (rationalization) section is expanded (also drives the paint-by-number overlay). */
  optimizeActive: boolean;
  /** Live panel metric for the active layer: total visible panels and how many are unique shapes. */
  total: number;
  unique: number;
  /** Currently selected rationalization strategy. */
  strategy: OptimizeStrategy;
  /** # borders shift-picked for a boolean op (drives the Combine section, Border mode only). */
  borderSelCount: number;
  /** True when exactly two picked borders overlap → unite/difference is available. */
  borderSelCanBoolean: boolean;
  /** Switch to Border mode — the trim boundary becomes editable (draw / move / stretch). */
  onSelectBorder: () => void;
  onSelectLayer: (index: number) => void;
  onToggleIdView: () => void;
  onToggleFrameShadow: () => void;
  onToggleOptimize: () => void;
  onSelectStrategy: (s: OptimizeStrategy) => void;
  /** Apply the selected strategy (undoable). */
  onApply: () => void;
}

/** A rationalization strategy and whether its algorithm is wired up yet. */
const STRATEGIES: { id: OptimizeStrategy; label: string; blurb: string; ready: boolean }[] = [
  {
    id: 'edge-normalize',
    label: 'Edge Normalization',
    blurb: 'Snap the border onto the master grid so the perimeter cut pattern repeats (e.g. a 45° edge → one cut).',
    ready: true,
  },
  {
    id: 'edge-profile',
    label: 'Edge Profile',
    blurb: 'Keep every panel a full rectangle; absorb the diagonal into a single perimeter trim band.',
    ready: true,
  },
  {
    id: 'modular-cluster',
    label: 'Modular Clustering',
    blurb: 'Group perimeter cuts by angle into reusable edge families (length varies, angle/setup constant).',
    ready: true,
  },
  {
    id: 'stepped-edge',
    label: 'Stepped Edge',
    blurb: 'Quantize the diagonal to a stair-step of identical whole panels (pixelated; needs corner flashing).',
    ready: true,
  },
];

/**
 * Right-docked control panel for the Facade Layers tool. Consolidates what used to be the top-center bar and
 * the floating Optimize popup into one side panel (mirroring the right-side Render / left-side Inspector
 * cards): the Border/Panels edit-mode switch, the Material-ID view toggle, and the panel-rationalization
 * (Optimize) section with its live unique-panel count, strategy picker, and Apply. Behaviour is unchanged —
 * only the layout moved.
 */
export function FacadePanel({
  layerCount,
  activeIndex,
  drawing,
  borderMode,
  idView,
  frameShadow,
  optimizeActive,
  total,
  unique,
  strategy,
  borderSelCount,
  borderSelCanBoolean,
  onSelectBorder,
  onSelectLayer,
  onToggleIdView,
  onToggleFrameShadow,
  onToggleOptimize,
  onSelectStrategy,
  onApply,
}: FacadePanelProps) {
  const selected = STRATEGIES.find((s) => s.id === strategy);
  const canApply = total > 0 && selected?.ready === true;

  return (
    <aside className={styles.panel} aria-label="Facade Layers">
      <div className={styles.header}>
        <span className={styles.title}>Facade Layers</span>
      </div>

      <div className={styles.body}>
        {/* Edit mode: Border ⇄ Panels */}
        <div className={styles.group}>
          <div className={styles.groupTitle}>Edit</div>
          <div className={styles.segmented} role="tablist" aria-label="Edit mode">
            <button
              type="button"
              role="tab"
              aria-selected={borderMode}
              className={`${styles.seg} ${borderMode ? styles.segActive : ''}`}
              title="Edit the trim boundary — drag to draw it, move corners, stretch edges"
              onClick={onSelectBorder}
            >
              Border
            </button>
            {Array.from({ length: layerCount }, (_, i) => {
              const isActive = !borderMode && i === activeIndex;
              return (
                <button
                  key={i}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={`${styles.seg} ${isActive ? styles.segActive : ''}`}
                  title="Edit the inner panel grid (the border is locked)"
                  onClick={() => onSelectLayer(i)}
                >
                  {layerCount > 1 ? `Panels ${i + 1}` : 'Panels'}
                </button>
              );
            })}
          </div>
          {borderMode && drawing && (
            <p className={styles.hint}>Drag on the canvas to draw the boundary.</p>
          )}
        </div>

        {/* Combine: boolean unite/difference driven entirely on-canvas (Border mode only). Shift-pick two
            overlapping borders, then click their cyan overlap to unite, or a bounding edge to subtract. */}
        {borderMode && !drawing && (
          <div className={styles.group}>
            <div className={styles.groupTitle}>Combine</div>
            {borderSelCount < 2 ? (
              <p className={styles.hint}>Shift-click two overlapping borders to combine them.</p>
            ) : !borderSelCanBoolean ? (
              <p className={styles.hint}>The two picked borders must overlap to combine.</p>
            ) : (
              <p className={styles.hint}>
                Click the cyan overlap to <strong>unite</strong>, or click a bordering edge to{' '}
                <strong>subtract</strong> that border from the other.
              </p>
            )}
          </div>
        )}

        {/* View: Material-ID segmentation */}
        <div className={styles.group}>
          <div className={styles.groupTitle}>View</div>
          <button
            type="button"
            className={`${styles.toggle} ${idView ? styles.idActive : ''}`}
            aria-pressed={idView}
            title="Toggle the Material-ID (segmentation) view"
            onClick={onToggleIdView}
          >
            <span>Material-ID</span>
            <span className={styles.toggleState}>{idView ? 'On' : 'Off'}</span>
          </button>
          <button
            type="button"
            className={`${styles.toggle} ${frameShadow ? styles.shadowActive : ''}`}
            aria-pressed={frameShadow}
            title="Toggle a purely-visual drop shadow that lifts the frame assembly off the wall"
            onClick={onToggleFrameShadow}
          >
            <span>Frame Shadow</span>
            <span className={styles.toggleState}>{frameShadow ? 'On' : 'Off'}</span>
          </button>
        </div>

        {/* Optimize: panel rationalization */}
        <div className={styles.group}>
          <div className={styles.groupTitle}>Optimize</div>
          <button
            type="button"
            className={`${styles.toggle} ${optimizeActive ? styles.optActive : ''}`}
            aria-pressed={optimizeActive}
            aria-expanded={optimizeActive}
            title="Generate / Optimize panels — reduce the number of unique panel shapes"
            onClick={onToggleOptimize}
          >
            <span>Rationalize panels</span>
            <span className={styles.toggleState}>{optimizeActive ? 'On' : 'Off'}</span>
          </button>

          {optimizeActive && (
            <div className={styles.optimize}>
              {total === 0 ? (
                <p className={styles.empty}>Draw a border first to rationalize its panels.</p>
              ) : (
                <div className={styles.stats}>
                  <span className={styles.statBig}>{unique}</span>
                  <span className={styles.statLabel}>
                    unique {unique === 1 ? 'panel' : 'panels'}
                    <span className={styles.statSub}> · {total} total</span>
                  </span>
                </div>
              )}

              <div className={styles.strategies} role="radiogroup" aria-label="Rationalization strategy">
                {STRATEGIES.map((s) => {
                  const active = s.id === strategy;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={!s.ready}
                      className={`${styles.strategy} ${active ? styles.strategyActive : ''}`}
                      onClick={() => onSelectStrategy(s.id)}
                    >
                      <span className={styles.strategyHead}>
                        <span className={styles.strategyName}>{s.label}</span>
                        {!s.ready && <span className={styles.soon}>coming soon</span>}
                      </span>
                      <span className={styles.strategyBlurb}>{s.blurb}</span>
                    </button>
                  );
                })}
              </div>

              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.apply}
                  disabled={!canApply}
                  title={canApply ? 'Rationalize the active layer' : 'Draw and split a border first'}
                  onClick={onApply}
                >
                  Apply
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
