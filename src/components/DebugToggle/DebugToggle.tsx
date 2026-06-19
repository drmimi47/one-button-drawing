import styles from './DebugToggle.module.css';

interface DebugToggleProps {
  /** Whether debug overlays (centre numbers, cyan overlap) are shown. */
  on: boolean;
  onChange: (on: boolean) => void;
}

/** Labelled toggle switch (switch then "Dev" label); the knob slides + the track turns grey. */
export function DebugToggle({ on, onChange }: DebugToggleProps) {
  return (
    <div className={styles.wrap}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Dev"
        className={`${styles.switch} ${on ? styles.on : ''}`}
        onClick={() => onChange(!on)}
      >
        <span className={styles.knob} />
      </button>
      <span className={styles.label}>Dev</span>
    </div>
  );
}
