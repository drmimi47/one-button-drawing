import { useRef, useState, type PointerEvent } from 'react';
import styles from './AdjacencyMatrix.module.css';
import { ADJACENCY, applyAdjacency, DEFAULT_ADJACENCY } from '../../rooms/roomAdjacency';
import {
  buildRankMatrix,
  composeNext,
  keyLabel,
  SOURCE_KEYS,
  TARGET_KEYS,
  type Adjacency,
  type RankMatrix,
} from './adjacencyMatrixModel';

interface AdjacencyMatrixProps {
  /** Close the window (re-openable from the dev-cluster launcher while Dev mode is on). */
  onClose: () => void;
  /**
   * Called with the new table after Apply/Reset, so the signed-in user's edits can be saved
   * to their account (in addition to the dev source-file write-back). No-op for guests.
   */
  onPersist?: (next: Record<string, Record<string, number>>) => void;
  /**
   * Catalog key of the room the cursor is hovering on the canvas (or null) — its row and
   * column get a grey infill so you can locate that program in the matrix at a glance.
   */
  hoveredKey?: string | null;
}

/** Grey infill for the hovered room's crossing row + column. */
const AXIS_HIGHLIGHT = '#dde1e7';

/** Cell shading: rank 1 is the darkest grey, fading to nothing by rank ~6. */
function cellShade(rank: number | undefined): string | undefined {
  if (!rank) return undefined;
  const alpha = Math.max(0, 0.4 - (rank - 1) * 0.07);
  return alpha > 0 ? `rgba(63, 63, 70, ${alpha.toFixed(3)})` : undefined;
}

/** A short "1. Kitchen · 2. …" preview of a row's top picks, from its current ranks. */
function rowPreview(rankRow: Record<string, number>): string {
  const top = Object.entries(rankRow)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 3)
    .map(([k], i) => `${i + 1}. ${keyLabel(k)}`);
  return top.length ? top.join('  ·  ') : 'no predictions';
}

/** POST the table to the dev write-back endpoint; resolves with ok + an optional message. */
async function persist(adjacency: Adjacency): Promise<{ ok: boolean; msg?: string }> {
  try {
    const res = await fetch('/__dev/adjacency', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adjacency }),
    });
    if (res.status === 204) return { ok: true };
    return { ok: false, msg: (await res.text()) || `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, msg: err instanceof Error ? err.message : 'network error' };
  }
}

/**
 * Dev-only floating window that visualises and edits the real next-room prediction table
 * ({@link ADJACENCY}). Rows/columns are room programs; each cell is the predicted RANK
 * (reverse logic: 1 = most likely, blank = never). Editing a rank and pressing Apply rewrites
 * the underlying weights — applied live to predictions AND persisted to roomAdjacency.ts.
 */
export function AdjacencyMatrix({ onClose, onPersist, hoveredKey }: AdjacencyMatrixProps) {
  const [ranks, setRanks] = useState<RankMatrix>(() => buildRankMatrix(ADJACENCY));
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState('1 = most likely');
  const [minimized, setMinimized] = useState(false);
  const [pos, setPos] = useState({ x: 96, y: 72 });

  const drag = useRef({ active: false, sx: 0, sy: 0, ox: 0, oy: 0 });

  const onTitleDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    drag.current = { active: true, sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onTitleMove = (e: PointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    if (!g.active) return;
    setPos({ x: g.ox + (e.clientX - g.sx), y: g.oy + (e.clientY - g.sy) });
  };
  const onTitleUp = (e: PointerEvent<HTMLDivElement>) => {
    drag.current.active = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone */
    }
  };

  const setCell = (source: string, target: string, raw: string) => {
    setRanks((prev) => {
      const row = { ...prev[source] };
      const n = parseInt(raw, 10);
      if (raw.trim() === '' || !Number.isFinite(n) || n < 1) delete row[target];
      else row[target] = n;
      return { ...prev, [source]: row };
    });
    setDirty((prev) => new Set(prev).add(source));
  };

  const apply = async () => {
    const dirtyRows: RankMatrix = {};
    dirty.forEach((s) => {
      dirtyRows[s] = ranks[s];
    });
    const next = composeNext(ADJACENCY, dirtyRows);
    applyAdjacency(next); // live: predictions change immediately
    onPersist?.(next); // save to the signed-in user's account (no-op for guests)
    setStatus('Saving…');
    const r = await persist(next);
    setDirty(new Set());
    setStatus(r.ok ? 'Saved to source ✓ — predictions updated.' : `Applied live · file write failed: ${r.msg}`);
  };

  const reset = async () => {
    const next: Adjacency = JSON.parse(JSON.stringify(DEFAULT_ADJACENCY));
    applyAdjacency(next);
    onPersist?.(next); // mirror the reset to the signed-in user's account
    setRanks(buildRankMatrix(next));
    setDirty(new Set());
    setStatus('Saving…');
    const r = await persist(next);
    setStatus(r.ok ? 'Reset to defaults ✓' : `Reset live · file write failed: ${r.msg}`);
  };

  const revert = () => {
    setRanks(buildRankMatrix(ADJACENCY));
    setDirty(new Set());
    setStatus('Reverted unsaved edits.');
  };

  const hasEdits = dirty.size > 0;

  return (
    <div className={styles.window} style={{ left: pos.x, top: pos.y }}>
      <div
        className={styles.titlebar}
        onPointerDown={onTitleDown}
        onPointerMove={onTitleMove}
        onPointerUp={onTitleUp}
      >
        <span className={styles.title}>Adjacency Matrix</span>
        <div className={styles.winButtons} onPointerDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            className={styles.winBtn}
            onClick={() => setMinimized((m) => !m)}
            title={minimized ? 'Restore' : 'Minimize'}
            aria-label={minimized ? 'Restore' : 'Minimize'}
          >
            {minimized ? '▢' : '–'}
          </button>
          <button
            type="button"
            className={`${styles.winBtn} ${styles.closeBtn}`}
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            ×
          </button>
        </div>
      </div>

      {!minimized && (
        <>
          <div className={styles.body}>
            <table className={styles.matrix}>
              <thead>
                <tr>
                  <th className={styles.corner} title="row = current room · column = predicted next room">
                    from \ to
                  </th>
                  {TARGET_KEYS.map((t) => (
                    <th
                      key={t}
                      className={styles.colHead}
                      title={keyLabel(t)}
                      style={hoveredKey === t ? { background: AXIS_HIGHLIGHT } : undefined}
                    >
                      <span className={styles.colLabel}>{t}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {SOURCE_KEYS.map((s) => {
                  const rowHi = hoveredKey === s;
                  return (
                  <tr key={s}>
                    <th
                      className={`${styles.rowHead} ${dirty.has(s) ? styles.rowDirty : ''}`}
                      title={`${keyLabel(s)} → ${rowPreview(ranks[s] ?? {})}`}
                      style={rowHi ? { background: AXIS_HIGHLIGHT } : undefined}
                    >
                      {keyLabel(s)}
                    </th>
                    {TARGET_KEYS.map((t) => {
                      const rank = ranks[s]?.[t];
                      const isDiag = s === t;
                      const axisHi = rowHi || hoveredKey === t;
                      return (
                        <td
                          key={t}
                          className={`${styles.cell} ${isDiag ? styles.diag : ''}`}
                          style={{ background: axisHi ? AXIS_HIGHLIGHT : cellShade(rank) }}
                        >
                          <input
                            className={styles.cellInput}
                            value={rank ?? ''}
                            inputMode="numeric"
                            onChange={(e) => setCell(s, t, e.target.value)}
                            title={`${keyLabel(s)} → ${keyLabel(t)}`}
                          />
                        </td>
                      );
                    })}
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className={styles.footer}>
            <span className={styles.status}>{status}</span>
            <div className={styles.actions}>
              <button type="button" className={styles.ghostBtn} onClick={reset} title="Restore the factory prediction table">
                Reset defaults
              </button>
              <button type="button" className={styles.ghostBtn} onClick={revert} disabled={!hasEdits}>
                Revert
              </button>
              <button type="button" className={styles.primaryBtn} onClick={apply} disabled={!hasEdits}>
                Apply{hasEdits ? ` (${dirty.size})` : ''}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
