import { useEffect, useRef, useState } from 'react';
import styles from './TopBar.module.css';

/** Available editor modes shown in the "Mode:" pill. */
const MODES = ['Plan', 'Facade'] as const;
export type Mode = (typeof MODES)[number];

interface TopBarProps {
  /** Current editor mode (controlled by the parent so other UI can react to it). */
  mode: Mode;
  /** Called with the next mode when the "Mode:" pill is clicked. */
  onModeChange: (mode: Mode) => void;
}

/**
 * Top-left toolbar — a circular menu button, the "Mode:" pill (toggles Plan ⇄ Facade),
 * and the editable document-title pill. The menu is presentational for now; the title can
 * be renamed by clicking it (the pill grows/shrinks to fit). Mode is owned by the parent.
 */
export function TopBar({ mode, onModeChange }: TopBarProps) {
  const [title, setTitle] = useState('Untitled Project');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  // Clicking the "Mode:" pill cycles to the next mode (parent holds the value).
  const cycleMode = () => onModeChange(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);

  // Option pill flyout (the "+ Option" pill below "Option 1").
  const [optionOpen, setOptionOpen] = useState(false);
  const optionWrapRef = useRef<HTMLDivElement>(null);

  // Focus + select the whole title when entering edit mode (easy to replace).
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  // Close the Option flyout on an outside click or Escape.
  useEffect(() => {
    if (!optionOpen) return;
    const onDown = (e: MouseEvent) => {
      if (optionWrapRef.current && !optionWrapRef.current.contains(e.target as Node)) {
        setOptionOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOptionOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [optionOpen]);

  const startEdit = () => {
    setDraft(title);
    setEditing(true);
  };
  const commit = () => {
    setTitle(draft.trim() || 'Untitled Project');
    setEditing(false);
  };

  return (
    <div className={styles.bar}>
      <button type="button" className={styles.menu} aria-label="Menu">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <line x1="4" y1="7" x2="20" y2="7" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="17" x2="20" y2="17" />
        </svg>
      </button>
      <button type="button" className={`${styles.pill} ${styles.modeBtn}`} onClick={cycleMode}>
        Mode: {mode}
      </button>
      <span className={styles.sep} aria-hidden="true">&gt;</span>
      {editing ? (
        <input
          ref={inputRef}
          className={`${styles.pill} ${styles.title} ${styles.titleInput}`}
          value={draft}
          spellCheck={false}
          aria-label="Rename plan"
          // Monospace font → 1ch == one character; + 36px for the pill's padding/border.
          style={{ width: `calc(${Math.max(draft.length, 1)}ch + 36px)` }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className={`${styles.pill} ${styles.title} ${styles.titleBtn}`}
          onClick={startEdit}
          title="Rename"
        >
          {title}
        </button>
      )}
      <span className={styles.sep} aria-hidden="true">/</span>
      <div className={styles.optionWrap} ref={optionWrapRef}>
        <button
          type="button"
          className={`${styles.pill} ${styles.optionBtn}`}
          onClick={() => setOptionOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={optionOpen}
        >
          Option 1
        </button>
        {optionOpen && (
          <div className={styles.optionMenu} role="menu">
            <button type="button" className={styles.optionRow} role="menuitem">
              Option 1
            </button>
            <div className={styles.optionDivider} />
            <button type="button" className={styles.optionRow} role="menuitem">
              + Option
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
