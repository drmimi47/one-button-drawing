import { useEffect, useRef, useState } from 'react';
import styles from './CellSplitMenu.module.css';
import type { PanelKind } from '../../facade/partition';

/** The assignable panel material kinds + their menu labels (no descriptions, per spec). */
const PANEL_KINDS: { kind: PanelKind; label: string }[] = [
  { kind: 'vision1', label: 'Vision Glass — Single' },
  { kind: 'vision2', label: 'Vision Glass — Double' },
  { kind: 'vision3', label: 'Vision Glass — Triple' },
  { kind: 'spandrel', label: 'Spandrel Glass' },
  { kind: 'solid', label: 'Solid Panel' },
  { kind: 'cladding', label: 'Heavy Cladding' },
  { kind: 'louver', label: 'Louver / Screen' },
];

interface CellSplitMenuProps {
  /** Screen position (client px) to anchor the popover at — the right-click point. */
  x: number;
  y: number;
  onApply: (cols: number, rows: number) => void;
  onClose: () => void;
  /** Fires on mount and on every cols/rows change — drives the faint on-canvas split preview. */
  onChange?: (cols: number, rows: number) => void;
  /** Edit the clicked panel's frame — shown below the split controls. */
  onEdit: () => void;
  /** Assign a material kind to the clicked panel group (null clears it). */
  onAssignKind: (kind: PanelKind | null) => void;
}

/**
 * Right-click popover for the Facade Layers tool: split the clicked cell into `cols × rows`, with Edit /
 * Assign actions for the panel below. A faint preview of the subdivision shows on the canvas as you adjust
 * the counts. Closes on Esc, on Apply, or on an outside click. `1 × 1` collapses the cell back to a leaf.
 */
export function CellSplitMenu({ x, y, onApply, onClose, onChange, onEdit, onAssignKind }: CellSplitMenuProps) {
  const [cols, setCols] = useState(2);
  const [rows, setRows] = useState(2);
  // When true, the popover shows the material-kind picker instead of the split controls.
  const [assigning, setAssigning] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Push the live counts to the canvas preview (on mount and whenever they change).
  useEffect(() => {
    onChange?.(cols, rows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cols, rows]);

  // Close on outside click or Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Keep the popover on-screen (nudge left/up if it would overflow).
  const left = Math.min(x, window.innerWidth - 200);
  const top = Math.min(y, window.innerHeight - (assigning ? 320 : 140));

  // Assign view: a flat list of panel material kinds (plus a "None" to clear the assignment).
  if (assigning) {
    return (
      <div ref={ref} className={styles.menu} style={{ left, top }} role="dialog" aria-label="Assign panel type">
        <div className={styles.title}>Assign panel type</div>
        <div className={styles.kindList}>
          {PANEL_KINDS.map(({ kind, label }) => (
            <button
              key={kind}
              type="button"
              className={styles.kindBtn}
              onClick={() => onAssignKind(kind)}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            className={`${styles.kindBtn} ${styles.kindClear}`}
            onClick={() => onAssignKind(null)}
          >
            None
          </button>
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={() => setAssigning(false)}>
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={ref} className={styles.menu} style={{ left, top }} role="dialog" aria-label="Split cell">
      <div className={styles.title}>Split cell</div>
      <Field label="Cols" value={cols} onChange={setCols} />
      <Field label="Rows" value={rows} onChange={setRows} />
      <div className={styles.actions}>
        <button type="button" className={styles.cancel} onClick={onClose}>
          Cancel
        </button>
        <button type="button" className={styles.apply} onClick={() => onApply(cols, rows)}>
          Apply
        </button>
      </div>
      <div className={styles.panelActions}>
        <button type="button" className={styles.panelBtn} onClick={onEdit}>
          Edit
        </button>
        <button type="button" className={styles.panelBtn} onClick={() => setAssigning(true)}>
          Assign
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  const clamp = (n: number) => Math.max(1, Math.min(20, Math.round(n)));
  return (
    <div className={styles.field}>
      <span className={styles.label}>{label}</span>
      <button type="button" className={styles.step} aria-label={`decrease ${label}`} onClick={() => onChange(clamp(value - 1))}>
        −
      </button>
      <input
        className={styles.input}
        type="number"
        min={1}
        max={20}
        value={value}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
      />
      <button type="button" className={styles.step} aria-label={`increase ${label}`} onClick={() => onChange(clamp(value + 1))}>
        +
      </button>
    </div>
  );
}
