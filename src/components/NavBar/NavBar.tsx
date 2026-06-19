import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { parseConstraintsLocally } from '../../../backend/parseConstraints';
import type { CanvasHandle } from '../InfiniteCanvas/InfiniteCanvas';
import type { LibraryCluster } from '../../library';
import type { PanelType } from '../../facade/standardize';
import { LibraryPanel } from '../Library/LibraryPanel';
import styles from './NavBar.module.css';

type Panel = 'constraints' | 'prompt' | 'library' | 'analyze' | null;

/**
 * Example prompts cycled through the Generate box's placeholder, so a user unsure
 * what to type can see the kind of thing that works. A mix of GENERATE prompts
 * (build new rooms) and FIND prompts ("show me / find / highlight…", which search
 * and highlight existing rooms). Shown one at a time on a slow rotation while the
 * box is open and empty; the runtime shuffle makes the order random each visit.
 */
const PROMPT_EXAMPLES = [
  "I want 1 kitchen, a foyer, and a 18'x12' bedroom...",
  'Show me all the kitchens...',
  'A 3-bedroom house with 2 bathrooms...',
  'Find every bathroom...',
  'Open-plan kitchen, dining, and living room...',
  'Highlight all 6" walls...',
  "5 offices and a 20'x15' conference room...",
  'Where are the bedrooms?...',
  'A primary suite with a walk-in closet and full bath...',
  'Select all the closets...',
  "Two 12'x12' bedrooms sharing a bathroom...",
  'A garage, mudroom, and laundry room...',
  'A studio apartment with a kitchenette and bath...',
  'A lobby, 4 patient rooms, and a nurse station...',
  'Kitchen, pantry, dining, and a powder room...',
];

/** A fresh Fisher-Yates shuffle of `arr` (used to randomise the example order). */
function shuffled<T>(arr: readonly T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** How long each example prompt stays before the next (ms) — a slow, calm rotation. */
const PROMPT_EXAMPLE_INTERVAL = 5500;
/** Fade-out/in duration (ms) when swapping to the next example. */
const PROMPT_EXAMPLE_FADE = 300;

/** Shared SVG attributes for the nav-button glyphs (inherit the button's colour). */
const ICON_PROPS = {
  className: styles.icon,
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

/** Constraints → a flag on a pole. */
function ConstraintsIcon() {
  return (
    <svg {...ICON_PROPS}>
      <line x1="6" y1="3" x2="6" y2="21" />
      <path d="M6 4 H18 L15.5 7.75 L18 11.5 H6 Z" />
    </svg>
  );
}

/** Analyze → a line graph with axes (analytics). */
function AnalyzeIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M5 4 V19 H20" />
      <polyline points="7.5,15 10.5,11 13.5,13 18,7.5" />
      <circle cx="7.5" cy="15" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="10.5" cy="11" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="13.5" cy="13" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="18" cy="7.5" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Placeholder → a map-pin (teardrop with a hole). Now an inert button (the Facade Layers tool moved to the cube). */
function PlaceholderIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

/** Render → a picture/image icon (frame with a sun and a mountain). */
function RenderIcon() {
  return (
    <svg {...ICON_PROPS}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9" r="1.6" />
      <path d="M21 16l-5-5-5 5" />
      <path d="M14 19l-3-3-6 4" />
    </svg>
  );
}

/** Generate → a magnifying glass with a sparkle at its centre (AI-powered search). */
function GenerateIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="10" cy="10" r="6.2" />
      <line x1="14.5" y1="14.5" x2="20.5" y2="20.5" />
      <path
        d="M10 6.9 l0.85 2.25 2.25 0.85 -2.25 0.85 -0.85 2.25 -0.85 -2.25 -2.25 -0.85 2.25 -0.85 z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

/** Library → a folder (the saved-arrangements collection). */
function LibraryIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M3 6.5 a1.5 1.5 0 0 1 1.5 -1.5 H9 l2 2.5 H19.5 a1.5 1.5 0 0 1 1.5 1.5 V17.5 a1.5 1.5 0 0 1 -1.5 1.5 H4.5 A1.5 1.5 0 0 1 3 17.5 Z" />
    </svg>
  );
}

interface NavBarProps {
  children: ReactNode;
  /** Saved constraints text (owned by App, seeded from constraints_file.txt). */
  constraintsText: string;
  /** Called only when the user clicks Save; App then re-parses the new text. */
  onConstraintsTextChange: (text: string) => void;
  /** The built-in default constraints text, applied by the "Reset defaults" button. */
  defaultConstraintsText: string;
  /** True while a Save'd constraints text is being parsed/applied (shows "Saving…"). */
  constraintsBusy?: boolean;
  /**
   * Names of the constraint fields currently being violated on the canvas (each a
   * `keyof Constraints`). Any constraint line whose rule is in this set is washed
   * the same warning yellow as the canvas flags, so opening the box shows at a
   * glance which rule to adjust.
   */
  violatedConstraintKeys?: string[];
  /** Whether the canvas's yellow constraint highlights are currently shown (the
   *  Constraints "Visibility" eye reflects + toggles this). */
  constraintHighlightsVisible?: boolean;
  /** Toggle the canvas's yellow constraint highlights on/off (the eye's action). */
  onToggleConstraintHighlights?: () => void;
  /** Whether the Analyze view is active (ghosts the canvas) — Plan mode only. */
  analyzeActive?: boolean;
  /** Toggle the Analyze view on/off (Plan mode). */
  onToggleAnalyze?: () => void;
  /** Fires true/false as the Facade Analyze popup opens/closes (drives the standardization view). */
  onAnalyzeOpenChange?: (open: boolean) => void;
  /** Standardized panel types shown in the Facade Analyze popup (colour-coded, with counts). */
  panelTypes?: PanelType[];
  /** Select every panel of a type (its shape ids) — clicking a type row in the Analyze popup. */
  onSelectPanelType?: (shapeIds: string[]) => void;
  /** Whether Facade mode is active — gates the Render button (Facade-only). */
  facadeActive?: boolean;
  /** Render the current selection (Facade mode); same action the right-click menu had. */
  onRender?: () => void;
  /** Fires true/false as a nav popup (Constraints/Generate/Library) opens/closes — lets the App
   *  close the Render popup so only one top-right popup is open at a time. */
  onPanelOpenChange?: (open: boolean) => void;
  /** Start the guided constraint auto-fix flow (the Fix wand's action). */
  onFix?: () => void;
  /** True while a fix session is running — shows the Skip/Approve pill above Constraints. */
  fixActive?: boolean;
  /** Whether the current fix step has an applicable auto-fix (enables Approve). */
  fixCanApprove?: boolean;
  /** Apply the current fix step and advance. */
  onFixApprove?: () => void;
  /** Leave the current fix step and advance. */
  onFixSkip?: () => void;
  /**
   * Live smart-find match count, or null when no search is active. Shown as a small
   * pill above the Generate button (hidden while the Generate panel is open so it
   * doesn't collide with that button's tool menu).
   */
  findMatchCount?: number | null;
  /** Reports the pill's left/right screen edges so the StatsBar can centre the
   *  stat pairs in the gaps beside it. Re-fires on resize and font load. */
  onBoundsChange?: (bounds: { left: number; right: number }) => void;
  /**
   * Called when the user submits the Prompt box (Enter). App either runs an instant
   * find-highlight or parses + builds rooms (async); the box awaits this before closing.
   */
  onPromptSubmit?: (text: string) => void | Promise<void>;
  /** True while the prompt's LLM request is in flight (shows "Generating…"). */
  promptBusy?: boolean;
  /** Imperative canvas handle, so the Library can arm cluster placement. */
  canvasRef: RefObject<CanvasHandle>;
  /** Saved Library clusters (newest first). */
  library: LibraryCluster[];
  /** Live count of rooms currently flagged for a constraint violation. */
  constraintFlagCount: number;
  /** Remove a saved cluster by id. */
  onDeleteCluster: (id: string) => void;
  /** Rename a saved cluster (empty title reverts to the live count). */
  onRenameCluster: (id: string, name: string) => void;
  /** Persist a reordered saved-cluster list (full id order, top to bottom). */
  onReorderClusters: (orderedIds: string[]) => void;
  /** Publishes the Library button's client rect (the canvas's save drop-target). */
  onLibraryBoundsChange?: (rect: DOMRect) => void;
  /** Publishes the open Library popup's client rect (or null when closed) — a second drop-target. */
  onLibraryPopupBoundsChange?: (rect: DOMRect | null) => void;
  /** True while a canvas selection is being dragged over the Library button. */
  libraryDragActive?: boolean;
}

/**
 * Floating pill at the bottom centre. The cube (`children`) sits dead-centre,
 * flanked by two equal-width label groups so it stays on the pill's centre line
 * regardless of the labels' differing widths. "Constraints" and "Prompt" each
 * open a centred input (only one at a time).
 */
export function NavBar({
  children,
  constraintsText,
  onConstraintsTextChange,
  defaultConstraintsText,
  constraintsBusy = false,
  violatedConstraintKeys,
  constraintHighlightsVisible = true,
  onToggleConstraintHighlights,
  analyzeActive = false,
  onToggleAnalyze,
  onAnalyzeOpenChange,
  panelTypes,
  onSelectPanelType,
  facadeActive = false,
  onRender,
  onPanelOpenChange,
  onFix,
  fixActive = false,
  fixCanApprove = false,
  onFixApprove,
  onFixSkip,
  findMatchCount,
  onBoundsChange,
  onPromptSubmit,
  promptBusy = false,
  canvasRef,
  library,
  constraintFlagCount,
  onDeleteCluster,
  onRenameCluster,
  onReorderClusters,
  onLibraryBoundsChange,
  onLibraryPopupBoundsChange,
  libraryDragActive = false,
}: NavBarProps) {
  const [panel, setPanel] = useState<Panel>(null);
  const navRef = useRef<HTMLElement>(null);
  const libraryButtonRef = useRef<HTMLButtonElement>(null);
  const libraryPopupRef = useRef<HTMLDivElement>(null);
  // The Constraints button + its measured rect, so a tool menu (the magic-wand
  // sub-button) can float centred just above it, mirroring the Generate menu.
  const constraintsButtonRef = useRef<HTMLButtonElement>(null);
  const [constraintsRect, setConstraintsRect] = useState<DOMRect | null>(null);
  // Measure when the Constraints tool menu opens OR a fix pill needs to float above the
  // button — both anchor to the same screen rect.
  useLayoutEffect(() => {
    if (panel !== 'constraints' && !fixActive) return;
    const measure = () => {
      if (constraintsButtonRef.current) {
        setConstraintsRect(constraintsButtonRef.current.getBoundingClientRect());
      }
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [panel, fixActive]);
  // The Generate button + its measured screen rect, so the tool menu can float
  // centred just above it (anchored to the nav pill, not the centred prompt box).
  const generateButtonRef = useRef<HTMLButtonElement>(null);
  const [generateRect, setGenerateRect] = useState<DOMRect | null>(null);
  // Measure the Generate button when its tool menu opens (panel === 'prompt') OR when
  // a find-match pill needs to float above it — both anchor to the same screen rect.
  useLayoutEffect(() => {
    if (panel !== 'prompt' && findMatchCount == null) return;
    const measure = () => {
      if (generateButtonRef.current) {
        setGenerateRect(generateButtonRef.current.getBoundingClientRect());
      }
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [panel, findMatchCount]);

  // Publish the pill's horizontal extent so the StatsBar can place the stat pairs
  // in the open space on each side of it (re-measured on resize and font load).
  useEffect(() => {
    const measure = () => {
      const el = navRef.current;
      if (el) {
        const b = el.getBoundingClientRect();
        onBoundsChange?.({ left: b.left, right: b.right });
      }
      const lib = libraryButtonRef.current;
      if (lib) onLibraryBoundsChange?.(lib.getBoundingClientRect());
    };
    measure();
    window.addEventListener('resize', measure);
    document.fonts?.ready.then(measure);
    return () => window.removeEventListener('resize', measure);
  }, [onBoundsChange, onLibraryBoundsChange]);

  // Tell the App whether a nav popup is open, so it can close the Render popup (they share the
  // top-right spot — only one should be open at a time).
  useEffect(() => {
    onPanelOpenChange?.(panel !== null);
  }, [panel, onPanelOpenChange]);

  // The Analyze popup is Facade-only; if the user leaves Facade mode while it's open, close it.
  useEffect(() => {
    if (!facadeActive && panel === 'analyze') setPanel(null);
  }, [facadeActive, panel]);

  // Tell the App when the Facade Analyze popup is open, so it can turn on the canvas's
  // standardization view (colour panels by type + type-group click-select).
  useEffect(() => {
    onAnalyzeOpenChange?.(panel === 'analyze');
  }, [panel, onAnalyzeOpenChange]);

  // Publish the open Library popup's rect (null when closed) so the canvas can treat the popup
  // itself as a save drop-target. Re-measured on resize (it's right-anchored, so its left moves).
  useEffect(() => {
    if (panel !== 'library') {
      onLibraryPopupBoundsChange?.(null);
      return;
    }
    const measure = () => {
      const el = libraryPopupRef.current;
      if (el) onLibraryPopupBoundsChange?.(el.getBoundingClientRect());
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [panel, onLibraryPopupBoundsChange]);

  const [prompt, setPrompt] = useState('');
  // Randomise the example order once per page load, so they don't follow the same
  // sequence on every visit.
  const examples = useMemo(() => shuffled(PROMPT_EXAMPLES), []);

  // Rotating example-prompt placeholder: advances on a timer while the Generate box
  // is open. The start index is seeded randomly up front (not reset after mount) so
  // the first paint already shows its final text — avoiding an on-appear swap/jitter.
  // Each swap fades the old text out, switches it while invisible, then fades it in.
  const [exampleIndex, setExampleIndex] = useState(
    () => Math.floor(Math.random() * PROMPT_EXAMPLES.length),
  );
  const [exampleOpacity, setExampleOpacity] = useState(1);
  useEffect(() => {
    if (panel !== 'prompt') return;
    setExampleOpacity(1);
    let swap = 0;
    const id = window.setInterval(() => {
      setExampleOpacity(0); // fade out the current example
      swap = window.setTimeout(() => {
        setExampleIndex((i) => (i + 1) % examples.length);
        setExampleOpacity(1); // fade the next one in
      }, PROMPT_EXAMPLE_FADE);
    }, PROMPT_EXAMPLE_INTERVAL);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(swap);
    };
  }, [panel, examples]);
  // Local draft for the Constraints box: edits stay here until "Save" commits
  // them to App (which re-parses). Closing without saving discards the draft.
  const [constraintsDraft, setConstraintsDraft] = useState(constraintsText);
  const constraintsDirty = constraintsDraft !== constraintsText;

  // Backdrop that renders the draft with #-comment lines greyed and violated
  // constraint lines washed yellow; kept scroll-synced with the textarea so the
  // highlighted text always sits under the typed text.
  const highlightRef = useRef<HTMLDivElement>(null);
  const constraintsTextareaRef = useRef<HTMLTextAreaElement>(null);
  const violatedSet = useMemo(
    () => new Set(violatedConstraintKeys ?? []),
    [violatedConstraintKeys],
  );
  // The magic wand only lights up while at least one constraint is violated (a
  // flagged room or a breached global budget); otherwise it stays greyed out.
  const hasViolation = (violatedConstraintKeys?.length ?? 0) > 0 || constraintFlagCount > 0;
  const highlightedDraft = useMemo(() => {
    const lines = constraintsDraft.split('\n');
    return lines.map((line, i) => {
      const newline = i < lines.length - 1 ? '\n' : '';
      // Comment lines (ignored by the parser) are greyed and never count as violated.
      if (/^\s*#/.test(line)) {
        return (
          <span key={i}>
            <span className={styles.comment}>{line}</span>
            {newline}
          </span>
        );
      }
      // Map this line to the constraint field(s) it defines via the same local parser
      // the app uses, then flag it if any of those fields is currently violated.
      const lineKeys = Object.keys(parseConstraintsLocally(line));
      const violated = lineKeys.some((k) => violatedSet.has(k));
      return (
        <span key={i}>
          {violated ? <span className={styles.violated}>{line}</span> : line}
          {newline}
        </span>
      );
    });
  }, [constraintsDraft, violatedSet]);

  // The open panel is "locked" while its async work runs (Constraints saving,
  // Prompt generating): every close path — Escape, backdrop click, the nav toggle —
  // is suppressed so the user can't dismiss it mid-request.
  const panelBusy =
    panel === 'constraints' ? constraintsBusy : panel === 'prompt' ? promptBusy : false;

  const toggle = (next: Panel) =>
    setPanel((cur) => {
      if (panelBusy) return cur; // don't switch away from / close a busy panel
      return cur === next ? null : next;
    });

  // Submit the prompt (Enter): hand the text to App and wait for it to settle, then
  // clear + close. For a GENERATE prompt the awaited call holds the box open (showing
  // "Generating…" via `promptBusy`) until the LLM resolves; a FIND prompt resolves
  // instantly (local search), so the box closes right away and the highlight appears.
  const submitPrompt = async () => {
    const text = prompt.trim();
    if (!text || promptBusy) return;
    await onPromptSubmit?.(text);
    setPrompt('');
    setPanel((cur) => (cur === 'prompt' ? null : cur));
  };

  // Opening the Constraints panel reloads the draft from the saved text, so any
  // edits abandoned on a previous open are discarded rather than lingering.
  useEffect(() => {
    if (panel === 'constraints') setConstraintsDraft(constraintsText);
  }, [panel, constraintsText]);

  // On open, drop the caret at the very end (the blank line under the last
  // constraint) so the user can immediately type a new one. Deferred a frame so the
  // reloaded draft is in the textarea before the caret is positioned.
  useEffect(() => {
    if (panel !== 'constraints') return;
    const id = requestAnimationFrame(() => {
      const ta = constraintsTextareaRef.current;
      if (ta) {
        const end = ta.value.length;
        ta.focus();
        ta.setSelectionRange(end, end);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [panel]);

  // Save hands the draft to App; the box shows "Saving…" then "Saved" once it lands (busy
  // true → false). The popup stays open — it closes only via the × button.
  const saveConstraints = () => {
    if (!constraintsDirty || constraintsBusy) return;
    onConstraintsTextChange(constraintsDraft);
  };

  // Restore the built-in default constraints: refill the editor and apply immediately
  // (App re-parses, and persists for a signed-in user).
  const resetConstraints = () => {
    if (constraintsBusy) return;
    setConstraintsDraft(defaultConstraintsText);
    onConstraintsTextChange(defaultConstraintsText);
  };

  // Escape closes the Generate prompt only. The Constraints and Library popups close solely via
  // their × button (so they survive canvas edits + stray keypresses).
  useEffect(() => {
    if (panel !== 'prompt') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !promptBusy) setPanel(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [panel, promptBusy]);

  return (
    <>
      <nav ref={navRef} className={styles.nav} aria-label="Tools">
        <div className={`${styles.side} ${styles.left}`}>
          <button
            ref={constraintsButtonRef}
            type="button"
            className={`${styles.item} ${panel === 'constraints' ? styles.active : ''}`}
            aria-pressed={panel === 'constraints'}
            aria-label="Constraints"
            title="Constraints"
            onClick={() => toggle('constraints')}
          >
            <ConstraintsIcon />
            {constraintFlagCount > 0 && (
              <sup className={`${styles.badge} ${styles.badgeAlert}`}>{constraintFlagCount}</sup>
            )}
          </button>
          {/* Facade Layers tool — its functions are now launched from the bottom-centre cube, so this button
              is kept only as an inert (disabled) placeholder. */}
          <button
            type="button"
            className={styles.item}
            aria-label="Facade layers"
            title="Facade layers"
            disabled
          >
            <PlaceholderIcon />
          </button>
          {/* Analyze behaves differently per mode: in Plan it ghosts the canvas (a view toggle);
              in Facade it opens an empty top-right popup like Constraints/Library (no ghosting). */}
          <button
            type="button"
            className={`${styles.item} ${
              (facadeActive ? panel === 'analyze' : analyzeActive) ? styles.active : ''
            }`}
            aria-pressed={facadeActive ? panel === 'analyze' : analyzeActive}
            aria-label="Analyze"
            title="Analyze"
            onClick={() => {
              if (facadeActive) toggle('analyze');
              else onToggleAnalyze?.();
            }}
          >
            <AnalyzeIcon />
          </button>
        </div>
        {children}
        <div className={`${styles.side} ${styles.right}`}>
          <button
            ref={generateButtonRef}
            type="button"
            className={`${styles.item} ${panel === 'prompt' ? styles.active : ''}`}
            aria-pressed={panel === 'prompt'}
            aria-label="Generate"
            title="Generate"
            onClick={() => toggle('prompt')}
          >
            <GenerateIcon />
          </button>
          <button
            type="button"
            className={styles.item}
            aria-label="Render"
            title={facadeActive ? 'Render selected panels' : 'Render — Facade mode only'}
            disabled={!facadeActive}
            onClick={() => {
              setPanel(null); // close any open nav popup — Render takes the top-right spot
              onRender?.();
            }}
          >
            <RenderIcon />
          </button>
          <button
            ref={libraryButtonRef}
            type="button"
            className={`${styles.item} ${panel === 'library' ? styles.active : ''} ${
              libraryDragActive ? styles.dropTarget : ''
            }`}
            aria-pressed={panel === 'library'}
            aria-label="Library"
            title="Library"
            onClick={() => toggle('library')}
          >
            <LibraryIcon />
            {library.length > 0 && <sup className={styles.badge}>{library.length}</sup>}
          </button>
        </div>
      </nav>

      {/* Guided constraint-fix pill — floats above the Constraints button (same pill as
          its tool menu) while a fix session steps through violations. Hidden when the
          Constraints panel is open so it never overlaps that button's tool menu. */}
      {fixActive && panel !== 'constraints' && constraintsRect && (
        <div
          className={styles.toolMenu}
          style={{
            left: constraintsRect.left + constraintsRect.width / 2,
            top: constraintsRect.top - 18,
          }}
        >
          <button type="button" className={styles.fixSkip} onClick={() => onFixSkip?.()}>
            Skip
          </button>
          <button
            type="button"
            className={styles.fixApprove}
            disabled={!fixCanApprove}
            onClick={() => onFixApprove?.()}
          >
            Approve
          </button>
        </div>
      )}

      {/* Only the Generate prompt closes on an outside click. The Constraints and Library
          popups have no backdrop — they persist during canvas edits and close only via their ×. */}
      {panel === 'prompt' && (
        <div
          className={styles.backdrop}
          onMouseDown={() => {
            if (!promptBusy) setPanel(null);
          }}
          aria-hidden="true"
        />
      )}

      {panel === 'constraints' && (
        <>
          {/* Sub-rounded tool menu floating centred just above the Constraints button
              (anchored to the nav pill, mirroring the Generate menu). */}
          {constraintsRect && (
            <div
              className={styles.toolMenu}
              style={{
                left: constraintsRect.left + constraintsRect.width / 2,
                top: constraintsRect.top - 18,
              }}
            >
              <button
                type="button"
                className={styles.tool}
                aria-label="Fix"
                title="Fix"
                disabled={!hasViolation}
                onClick={() => {
                  onFix?.();
                  setPanel(null); // close the panel so the zoomed room is visible
                }}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                  <g
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="4.5" y1="19.5" x2="14.5" y2="9.5" />
                    <path d="M17.5 3 l1 2.6 2.6 1 -2.6 1 -1 2.6 -1 -2.6 -2.6 -1 2.6 -1 z" />
                  </g>
                  <circle cx="6" cy="4.5" r="1" fill="currentColor" />
                  <circle cx="20.5" cy="13.5" r="1" fill="currentColor" />
                </svg>
              </button>
              <button
                type="button"
                className={styles.tool}
                aria-label="Visibility"
                title="Visibility"
                aria-pressed={!constraintHighlightsVisible}
                disabled={!hasViolation}
                onClick={() => onToggleConstraintHighlights?.()}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                  <g
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M4 12 C7 5.5 17 5.5 20 12 C17 18.5 7 18.5 4 12 Z" />
                    <circle cx="12" cy="12" r="3.2" />
                    {/* Slash overlay when the constraint highlights are hidden (eye off). */}
                    {!constraintHighlightsVisible && <line x1="4" y1="20" x2="20" y2="4" />}
                  </g>
                </svg>
              </button>
            </div>
          )}

          <div className={styles.popup} role="dialog" aria-label="Constraints">
          <div className={styles.popupHeader}>
            <span className={styles.popupTitle}>Constraints</span>
            <button
              type="button"
              className={styles.popupClose}
              aria-label="Close"
              disabled={panelBusy}
              onClick={() => {
                if (!panelBusy) setPanel(null);
              }}
            >
              ×
            </button>
          </div>
          {/* Highlight backdrop (greys out #-comment lines) sits behind a
              transparent-text textarea that owns editing and the caret. Their text
              metrics match exactly so the rendered text lines up with what's typed. */}
          <div className={styles.popupField}>
            <div ref={highlightRef} className={styles.popupHighlight} aria-hidden="true">
              {highlightedDraft}
            </div>
            <textarea
              ref={constraintsTextareaRef}
              className={styles.popupInput}
              placeholder="Enter constraints…  (use # for comments)"
              value={constraintsDraft}
              spellCheck={false}
              onChange={(e) => setConstraintsDraft(e.target.value)}
              onScroll={(e) => {
                if (highlightRef.current) highlightRef.current.scrollTop = e.currentTarget.scrollTop;
              }}
              onKeyDown={(e) => {
                // Cmd/Ctrl+Enter saves. (The popup closes only via the × button.)
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && constraintsDirty) {
                  e.preventDefault();
                  saveConstraints();
                }
              }}
            />
          </div>
          <div className={styles.popupActions}>
            <span className={styles.popupHint}>
              {constraintsBusy ? 'Applying…' : constraintsDirty ? 'Unsaved changes' : 'Saved'}
            </span>
            <div className={styles.popupButtons}>
              <button
                type="button"
                className={styles.resetButton}
                onClick={resetConstraints}
                disabled={constraintsBusy || constraintsDraft === defaultConstraintsText}
              >
                Reset defaults
              </button>
              <button
                type="button"
                className={styles.saveButton}
                onClick={saveConstraints}
                disabled={!constraintsDirty || constraintsBusy}
              >
                {constraintsBusy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
          </div>
        </>
      )}

      {/* Smart-find result pill — same floating pill as the Generate tool menu, shown
          above the Generate button while a search is active. Hidden when the Generate
          panel is open so it never overlaps that button's Rectangle/Polyline menu. */}
      {findMatchCount != null && panel !== 'prompt' && generateRect && (
        <div
          className={styles.toolMenu}
          style={{
            left: generateRect.left + generateRect.width / 2,
            top: generateRect.top - 18,
            pointerEvents: 'none',
          }}
        >
          <span className={styles.matchCount}>
            {findMatchCount === 0
              ? 'No matches'
              : `${findMatchCount} match${findMatchCount === 1 ? '' : 'es'}`}
          </span>
        </div>
      )}

      {panel === 'prompt' && (
        <>
          {/* Sub-rounded tool menu floating centred just above the Generate button
              (anchored to the nav pill, not the centred prompt box). */}
          {generateRect && (
            <div
              className={styles.toolMenu}
              style={{
                left: generateRect.left + generateRect.width / 2,
                // Clear the nav pill (its top sits ~5px above the button) with a gap.
                top: generateRect.top - 18,
              }}
            >
              <button
                type="button"
                className={styles.tool}
                aria-label="Rectangle tool"
                title="Rectangle"
                onClick={() => {
                  // Arm the footprint tool and close the panel so the canvas is
                  // free for the click-drag that draws the building outline.
                  canvasRef.current?.armFootprintDraw();
                  setPanel(null);
                }}
              >
                <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
                  <rect
                    x="5"
                    y="5"
                    width="12"
                    height="12"
                    rx="1.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                  />
                </svg>
              </button>
              <button type="button" className={styles.tool} aria-label="Polyline tool" title="Polyline">
                <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                  <polyline
                    points="3,21 6,14 13,14 10,5 18,8 21,3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <circle cx="3" cy="21" r="1.7" fill="currentColor" />
                  <circle cx="6" cy="14" r="1.7" fill="currentColor" />
                  <circle cx="13" cy="14" r="1.7" fill="currentColor" />
                  <circle cx="10" cy="5" r="1.7" fill="currentColor" />
                  <circle cx="18" cy="8" r="1.7" fill="currentColor" />
                  <circle cx="21" cy="3" r="1.7" fill="currentColor" />
                </svg>
              </button>
            </div>
          )}

          <div className={styles.search} role="dialog" aria-label="Generate">
            {/* Custom fading placeholder (a native one can't animate); shown only
                while the box is empty. pointer-events:none keeps the input clickable. */}
            {prompt === '' && !promptBusy && (
              <span
                className={styles.searchPlaceholder}
                style={{ opacity: exampleOpacity }}
                aria-hidden="true"
              >
                {examples[exampleIndex]}
              </span>
            )}
            <input
              className={styles.searchInput}
              type="text"
              value={prompt}
              autoFocus
              disabled={promptBusy}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                // Escape closes the box — but not while a request is generating.
                if (e.key === 'Escape' && !promptBusy) setPanel(null);
                // Enter submits the prompt to the LLM (no modifier needed).
                if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault();
                  submitPrompt();
                }
              }}
            />
            {promptBusy && <span className={styles.searchHint}>Generating…</span>}
          </div>
        </>
      )}

      {panel === 'library' && (
        <div ref={libraryPopupRef} className={styles.popup} role="dialog" aria-label="Library">
          <div className={styles.popupHeader}>
            <span className={styles.popupTitle}>Library</span>
            <button
              type="button"
              className={styles.popupClose}
              aria-label="Close"
              onClick={() => setPanel(null)}
            >
              ×
            </button>
          </div>
          {/* Same card + width as the Constraints popup, but a taller body. */}
          <div className={`${styles.popupField} ${styles.libraryField}`}>
            <LibraryPanel
              clusters={library}
              canvasRef={canvasRef}
              onClose={() => setPanel(null)}
              onDelete={onDeleteCluster}
              onRename={onRenameCluster}
              onReorder={onReorderClusters}
            />
          </div>
        </div>
      )}

      {/* Facade-mode Analyze popup — standardization view. Lists each unique panel "type" (identical
          geometry = one type, shared colour) with its dimensions and count; clicking a type selects
          all of its panels on the canvas. Closes only via its × (auto-closes on mode/panel switch). */}
      {panel === 'analyze' && (
        <div className={styles.popup} role="dialog" aria-label="Analyze">
          <div className={styles.popupHeader}>
            <span className={styles.popupTitle}>Analyze</span>
            <button
              type="button"
              className={styles.popupClose}
              aria-label="Close"
              onClick={() => setPanel(null)}
            >
              ×
            </button>
          </div>
          <AnalyzePanel types={panelTypes ?? []} onSelectType={onSelectPanelType} />
        </div>
      )}
    </>
  );
}

/**
 * Body of the Facade Analyze popup: the standardized panel-type breakdown. One row per unique panel
 * type (colour swatch + dimensions + frame thickness + count); clicking a row selects every panel of
 * that type on the canvas. Helps designers count and categorise panel types automatically as they work.
 */
function AnalyzePanel({
  types,
  onSelectType,
}: {
  types: PanelType[];
  onSelectType?: (shapeIds: string[]) => void;
}) {
  const totalPanels = types.reduce((n, t) => n + t.count, 0);
  return (
    <div className={styles.analyzeBody}>
      {types.length === 0 ? (
        <p className={styles.analyzeEmpty}>
          No panels yet. Drop panels in Facade mode — identical panels are grouped into one colour-coded
          type so you can count and categorise them automatically.
        </p>
      ) : (
        <>
          <div className={styles.analyzeSummary}>
            <span>
              <strong>{totalPanels}</strong> panel{totalPanels === 1 ? '' : 's'}
            </span>
            <span>
              <strong>{types.length}</strong> standardized type{types.length === 1 ? '' : 's'}
            </span>
          </div>
          <ul className={styles.panelTypeList}>
            {types.map((t) => (
              <li key={t.signature}>
                <button
                  type="button"
                  className={styles.panelTypeRow}
                  title={`Select all ${t.count} panel${t.count === 1 ? '' : 's'} of Type ${t.index}`}
                  onClick={() => onSelectType?.(t.shapeIds)}
                >
                  <span className={styles.panelTypeSwatch} style={{ background: t.color }} />
                  <span className={styles.panelTypeInfo}>
                    <span className={styles.panelTypeName}>Type {t.index}</span>
                    <span className={styles.panelTypeDims}>
                      {t.widthFt}′ × {t.heightFt}′
                      {' · '}
                      {t.uniformWalls ? `${t.wallInches}″ frame` : 'mixed frame'}
                    </span>
                  </span>
                  <span className={styles.panelTypeCount}>×{t.count}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
