import styles from './RenderPanel.module.css';

/** State of an idle / in-flight / finished facade render. */
export interface RenderState {
  status: 'idle' | 'loading' | 'done' | 'error';
  /** Data URL of the generated image (status === 'done'). */
  image?: string;
  /** Human-readable failure message (status === 'error'). */
  error?: string;
  /** How many shapes were sent to the renderer. */
  count: number;
  /** The exact prompt sent to Gemini (shown under the image in Dev mode). */
  prompt?: string;
}

interface RenderPanelProps {
  state: RenderState;
  /** Live count of selected shapes — gates the Render button. */
  selectionCount: number;
  /** When true (Dev mode), the exact Gemini prompt is shown beneath the image. */
  debug?: boolean;
  /** Render (or re-render) the current selection. */
  onRender: () => void;
  onClose: () => void;
}

/**
 * Floating panel for the AI render of the selected facade panels. Opens even with nothing selected
 * (prompting the user to select geometry); shows a spinner while the model works, the returned image
 * when done, or an error. The canvas shapes are left untouched. Closes only via ×.
 */
export function RenderPanel({ state, selectionCount, debug, onRender, onClose }: RenderPanelProps) {
  const loading = state.status === 'loading';
  const buttonLabel = loading ? 'Rendering…' : state.status === 'done' ? 'Regenerate' : 'Render';
  return (
    <div className={styles.panel} role="dialog" aria-label="Facade render">
      <div className={styles.header}>
        <span className={styles.title}>Render</span>
        <button type="button" className={styles.close} aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>

      <div className={styles.body}>
        {state.status === 'idle' && (
          <div className={styles.status}>
            {selectionCount === 0
              ? 'Select geometry to render.'
              : `${selectionCount} panel${selectionCount === 1 ? '' : 's'} selected.`}
          </div>
        )}
        {loading && (
          <div className={styles.status}>
            <span className={styles.spinner} aria-hidden="true" />
            <span>
              Rendering {state.count} panel{state.count === 1 ? '' : 's'}…
            </span>
          </div>
        )}
        {state.status === 'done' && state.image && (
          <img className={styles.image} src={state.image} alt="AI facade render" />
        )}
        {state.status === 'error' && (
          <div className={`${styles.status} ${styles.error}`}>
            {state.error ?? 'Render failed.'}
          </div>
        )}
      </div>

      {/* Dev mode: surface the exact prompt fed to Gemini, beneath the image. */}
      {debug && state.prompt && (
        <div className={styles.promptBlock}>
          <div className={styles.promptLabel}>Prompt sent to Gemini</div>
          <p className={styles.promptText}>{state.prompt}</p>
        </div>
      )}

      <div className={styles.footer}>
        <button
          type="button"
          className={styles.primary}
          onClick={onRender}
          disabled={loading || selectionCount === 0}
        >
          {buttonLabel}
        </button>
      </div>
    </div>
  );
}
