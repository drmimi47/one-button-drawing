import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { DrawLayer, Marquee, PendingPlacement, Square } from '../../types';
import {
  GRID_THEME,
  SHAPE_THEME,
  DEFAULT_SQUARE_SCREEN_SIZE,
  MAX_DEVICE_PIXEL_RATIO,
  MARQUEE_FILL,
  MARQUEE_STROKE,
  WORLD_UNITS_PER_FOOT,
  computeGridExtentCells,
} from '../../constants';
import { drawGrid } from '../../canvas/grid';
import {
  drawShapes,
  drawPlacementPreview,
  drawMarquee,
  defaultWalls,
  setEdgeLength,
  type HandleId,
  type EdgeFace,
  type HoverRegion,
  type DimensionLabelHit,
} from '../../canvas/shapes';
import { screenToWorld } from '../../canvas/coords';
import { useCamera } from '../../hooks/useCamera';
import { useCanvasInteractions } from '../../hooks/useCanvasInteractions';
import { useWindowSize } from '../../hooks/useWindowSize';
import { perfMonitor } from '../../perf/perfMonitor';
import styles from './InfiniteCanvas.module.css';

/** Imperative placement API the action button drives. */
export interface CanvasHandle {
  /**
   * Arm placement: a preview square appears centred on the given client point
   * and follows the cursor until the user clicks the canvas to commit it.
   */
  startPlacement(clientX: number, clientY: number): void;
  /** Reposition the armed preview (used while dragging from the button). */
  updatePlacement(clientX: number, clientY: number): void;
  /** Commit the armed preview at a client point (used on drag release). */
  commitPlacementAtClient(clientX: number, clientY: number): void;
  /** Cancel an armed placement without committing. */
  cancelPlacement(): void;
}

interface InfiniteCanvasProps {
  gridSize: number;
}

/** State for the floating dimension-editing input. */
interface DimEditorState {
  shapeId: string;
  which: 'width' | 'height' | 'edge';
  /** For `which === 'edge'`: which side of a free-form quad is being edited. */
  edge?: HandleId;
  /** Canvas-local screen position of the label centre. */
  x: number;
  y: number;
  /** Rotation (deg) so the input sits over the angled label. */
  angle: number;
  value: string;
}

function createId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `sq_${Math.random().toString(36).slice(2)}`;
}

/** Deep-enough clone of the shapes for an immutable history snapshot. */
function cloneShapes(shapes: Square[]): Square[] {
  return shapes.map((s) => ({ ...s, walls: { ...s.walls }, corners: s.corners?.map((p) => ({ ...p })) }));
}

/** Cap on undo depth, to bound memory. */
const MAX_HISTORY = 200;

const LOW_LATENCY: CanvasRenderingContext2DSettings = { desynchronized: true };

/**
 * Full-viewport canvas that renders the CPlane grid and placed squares.
 *
 * Performance design:
 *  - Two stacked canvases: an opaque grid layer (static during shape edits) and
 *    a transparent scene layer for squares + handles. Per-layer dirty flags mean
 *    dragging/placing a square redraws ONLY the scene — the grid is untouched.
 *  - Low-latency, alpha-tuned contexts ({ desynchronized: true }; grid is also
 *    alpha:false) to cut input-to-photon latency and compositing cost.
 *  - All interaction mutates refs and coalesces to one draw per animation frame;
 *    React only re-renders on viewport resize — the one time backing stores are
 *    re-sized. Device pixel ratio is capped to bound fill cost on HiDPI screens.
 */
export const InfiniteCanvas = forwardRef<CanvasHandle, InfiniteCanvasProps>(
  function InfiniteCanvas({ gridSize }, ref) {
    const gridCanvasRef = useRef<HTMLCanvasElement>(null);
    const sceneCanvasRef = useRef<HTMLCanvasElement>(null);
    const gridCtxRef = useRef<CanvasRenderingContext2D | null>(null);
    const sceneCtxRef = useRef<CanvasRenderingContext2D | null>(null);
    // Cached scene-canvas rect; refreshed on resize so placement does no layout
    // reads on the hot path.
    const rectRef = useRef<DOMRect | null>(null);

    const { width, height } = useWindowSize();

    // Fix the CPlane's size once, from the viewport at mount, so the square
    // covers the screen on load yet stays a stable finite plane afterwards.
    const extentCells = useMemo(
      () => computeGridExtentCells(window.innerWidth, window.innerHeight, gridSize),
      [gridSize],
    );

    // Scene state — kept in refs so interaction never re-renders React.
    const shapesRef = useRef<Square[]>([]);
    const selectionRef = useRef<Set<string>>(new Set());
    // Active region of the selection: a handle id highlights just that wall
    // edge; null (with a selection) highlights the white infill instead.
    const activeEdgeRef = useRef<HandleId | null>(null);
    // Which face of the active edge the pointer is nearer (glows magenta), or
    // null when not hovering it.
    const edgeHoverRef = useRef<EdgeFace | null>(null);
    // Shape + region the pointer is over, for the hover-preview darkening.
    const hoverRef = useRef<{ id: string; region: HoverRegion } | null>(null);
    // True while an edge stretch is dragging, so dimensions stay live.
    const resizingRef = useRef(false);
    const marqueeRef = useRef<Marquee | null>(null);
    const placementRef = useRef<PendingPlacement | null>(null);

    // Undo/redo as snapshots of the shapes array. `baseline` mirrors the current
    // committed state; `commitHistory` (called after every mutation) pushes the
    // prior baseline onto `undo`. Adding a new undoable action is just a matter
    // of calling commitHistory() once the change is applied.
    const historyRef = useRef<{ undo: Square[][]; redo: Square[][]; baseline: Square[] }>({
      undo: [],
      redo: [],
      baseline: [],
    });

    // In-app clipboard for copy/cut/paste. `pasteSeq` cascades repeated pastes
    // so they don't stack exactly on top of each other.
    const clipboardRef = useRef<Square[]>([]);
    const pasteSeqRef = useRef(0);

    // ---- Frame scheduler (per-layer dirty flags, one rAF) ------------------
    const frameRef = useRef(0);
    const dirtyGridRef = useRef(false);
    const dirtySceneRef = useRef(false);
    const drawGridRef = useRef<() => void>(() => {});
    const drawSceneRef = useRef<() => void>(() => {});

    const requestDraw = useCallback((layer: DrawLayer = 'all') => {
      if (layer !== 'scene') dirtyGridRef.current = true;
      if (layer !== 'grid') dirtySceneRef.current = true;
      if (frameRef.current) return; // a frame is already queued
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = 0;
        const drawGridNow = dirtyGridRef.current;
        const drawSceneNow = dirtySceneRef.current;
        dirtyGridRef.current = false;
        dirtySceneRef.current = false;
        const start = import.meta.env.DEV ? performance.now() : 0;
        if (drawGridNow) drawGridRef.current();
        if (drawSceneNow) drawSceneRef.current();
        if (import.meta.env.DEV) perfMonitor.recordDraw(performance.now() - start);
      });
    }, []);

    const requestAll = useCallback(() => requestDraw('all'), [requestDraw]);

    const { cameraRef } = useCamera(sceneCanvasRef, requestAll);

    // Snapshot the current shapes as one undo step (call after a mutation).
    const commitHistory = useCallback(() => {
      const h = historyRef.current;
      h.undo.push(h.baseline);
      if (h.undo.length > MAX_HISTORY) h.undo.shift();
      h.baseline = cloneShapes(shapesRef.current);
      h.redo.length = 0;
    }, []);

    // Commit a square centred on a world point, select it, and redraw the scene.
    const createSquareAtWorld = useCallback(
      (worldX: number, worldY: number) => {
        const size = DEFAULT_SQUARE_SCREEN_SIZE / cameraRef.current.scale;
        const square: Square = {
          id: createId(),
          x: worldX - size / 2,
          y: worldY - size / 2,
          width: size,
          height: size,
          rotation: 0,
          walls: defaultWalls(),
          dots: false,
        };
        shapesRef.current.push(square);
        selectionRef.current = new Set([square.id]);
        activeEdgeRef.current = null;
        commitHistory();
        requestDraw('scene');
      },
      [cameraRef, commitHistory, requestDraw],
    );

    // Place the armed preview at a canvas-local screen point.
    const commitPlacement = useCallback(
      (sx: number, sy: number) => {
        const world = screenToWorld(sx, sy, cameraRef.current);
        placementRef.current = null;
        createSquareAtWorld(world.x, world.y);
      },
      [cameraRef, createSquareAtWorld],
    );

    // ---- Inline dimension editor -------------------------------------------
    // An <input> floats over a clicked dimension label; typing a value resizes
    // the shape's interior. `editorRef` mirrors the state so commit reads the
    // latest value without putting side effects in a state updater.
    const [editor, setEditor] = useState<DimEditorState | null>(null);
    const editorRef = useRef<DimEditorState | null>(null);
    const dimInputRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
      editorRef.current = editor;
    }, [editor]);
    // Focus + select when a NEW editor opens (keyed on shape/which so typing,
    // which only changes the value, doesn't re-select on every keystroke).
    useEffect(() => {
      if (editor && dimInputRef.current) {
        dimInputRef.current.focus();
        dimInputRef.current.select();
      }
    }, [editor?.shapeId, editor?.which, editor?.edge]);

    const beginDimensionEdit = useCallback((shapeId: string, hit: DimensionLabelHit) => {
      setEditor({
        shapeId,
        which: hit.which,
        edge: hit.edge,
        x: hit.sx,
        y: hit.sy,
        angle: hit.angleDeg,
        value: hit.text.replace(/[′']$/, ''), // edit the bare number
      });
    }, []);

    const commitDimension = useCallback(() => {
      const ed = editorRef.current;
      setEditor(null);
      if (!ed) return;
      const feet = parseFloat(ed.value);
      if (!Number.isFinite(feet) || feet <= 0) return;
      const shape = shapesRef.current.find((s) => s.id === ed.shapeId);
      if (!shape) return;
      const world = Math.max(1, feet * WORLD_UNITS_PER_FOOT);

      if (ed.which === 'edge' && ed.edge) {
        // Free-form quad: set that one edge to the typed length.
        const next = setEdgeLength(shape, ed.edge, world);
        if (next === shape) return; // degenerate edge → unchanged, no history step
        shape.x = next.x;
        shape.y = next.y;
        shape.width = next.width;
        shape.height = next.height;
        shape.corners = next.corners;
      } else {
        // Rectangle: resize the interior about the centre (keeps rotation natural).
        const before = ed.which === 'width' ? shape.width : shape.height;
        if (world === before) return; // no change → no history step
        if (ed.which === 'width') {
          const cx = shape.x + shape.width / 2;
          shape.width = world;
          shape.x = cx - world / 2;
        } else {
          const cy = shape.y + shape.height / 2;
          shape.height = world;
          shape.y = cy - world / 2;
        }
      }
      commitHistory();
      requestDraw('scene');
    }, [commitHistory, requestDraw]);

    // ---- Undo / redo --------------------------------------------------------
    const applySnapshot = useCallback(
      (snapshot: Square[]) => {
        shapesRef.current = cloneShapes(snapshot);
        // Drop selection/transient highlights that may reference removed shapes.
        const ids = new Set(shapesRef.current.map((s) => s.id));
        selectionRef.current = new Set([...selectionRef.current].filter((id) => ids.has(id)));
        activeEdgeRef.current = null;
        edgeHoverRef.current = null;
        hoverRef.current = null;
        resizingRef.current = false;
        setEditor(null);
        requestDraw('scene');
      },
      [requestDraw],
    );

    const undo = useCallback(() => {
      const h = historyRef.current;
      if (h.undo.length === 0) return;
      h.redo.push(h.baseline);
      h.baseline = h.undo.pop() as Square[];
      applySnapshot(h.baseline);
    }, [applySnapshot]);

    const redo = useCallback(() => {
      const h = historyRef.current;
      if (h.redo.length === 0) return;
      h.undo.push(h.baseline);
      h.baseline = h.redo.pop() as Square[];
      applySnapshot(h.baseline);
    }, [applySnapshot]);

    // ---- Copy / cut / paste -------------------------------------------------
    const copySelection = useCallback(() => {
      const sel = selectionRef.current;
      if (sel.size === 0) return;
      clipboardRef.current = cloneShapes(shapesRef.current.filter((s) => sel.has(s.id)));
      pasteSeqRef.current = 0;
    }, []);

    const cutSelection = useCallback(() => {
      const sel = selectionRef.current;
      if (sel.size === 0) return;
      clipboardRef.current = cloneShapes(shapesRef.current.filter((s) => sel.has(s.id)));
      pasteSeqRef.current = 0;
      shapesRef.current = shapesRef.current.filter((s) => !sel.has(s.id));
      selectionRef.current = new Set();
      activeEdgeRef.current = null;
      commitHistory();
      requestDraw('scene');
    }, [commitHistory, requestDraw]);

    const pasteClipboard = useCallback(() => {
      const clip = clipboardRef.current;
      if (clip.length === 0) return;
      // Cascade each successive paste by a constant on-screen offset.
      const seq = (pasteSeqRef.current += 1);
      const offset = (16 / cameraRef.current.scale) * seq;
      const copies = clip.map((s) => ({
        ...s,
        walls: { ...s.walls },
        corners: s.corners?.map((p) => ({ ...p })),
        id: createId(),
        x: s.x + offset,
        y: s.y + offset,
      }));
      for (const c of copies) shapesRef.current.push(c);
      selectionRef.current = new Set(copies.map((c) => c.id));
      activeEdgeRef.current = null;
      commitHistory();
      requestDraw('scene');
    }, [cameraRef, commitHistory, requestDraw]);

    // Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y redo. Ignored while typing
    // in the dimension editor so its own text undo keeps working.
    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
          return;
        }
        const key = e.key.toLowerCase();
        if (key === 'z' && !e.shiftKey) {
          e.preventDefault();
          undo();
        } else if ((key === 'z' && e.shiftKey) || key === 'y') {
          e.preventDefault();
          redo();
        } else if (key === 'c') {
          e.preventDefault();
          copySelection();
        } else if (key === 'x') {
          e.preventDefault();
          cutSelection();
        } else if (key === 'v') {
          e.preventDefault();
          pasteClipboard();
        }
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [undo, redo, copySelection, cutSelection, pasteClipboard]);

    useCanvasInteractions({
      canvasRef: sceneCanvasRef,
      cameraRef,
      shapesRef,
      selectionRef,
      activeEdgeRef,
      edgeHoverRef,
      hoverRef,
      resizingRef,
      marqueeRef,
      placementRef,
      commitPlacement,
      beginDimensionEdit,
      commitHistory,
      requestDraw,
    });

    // ---- Render layers -----------------------------------------------------
    const drawGridLayer = useCallback(() => {
      const ctx = gridCtxRef.current;
      if (!ctx) return;
      drawGrid({
        ctx,
        width,
        height,
        camera: cameraRef.current,
        gridSize,
        extentCells,
        theme: GRID_THEME,
      });
    }, [width, height, gridSize, extentCells, cameraRef]);

    const drawSceneLayer = useCallback(() => {
      const ctx = sceneCtxRef.current;
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);
      drawShapes({
        ctx,
        shapes: shapesRef.current,
        camera: cameraRef.current,
        selectedIds: selectionRef.current,
        activeHandle: activeEdgeRef.current,
        activeEdgeFace: edgeHoverRef.current,
        hoverId: hoverRef.current?.id ?? null,
        hoverRegion: hoverRef.current?.region ?? null,
        resizing: resizingRef.current,
        width,
        height,
        theme: SHAPE_THEME,
      });
      const pending = placementRef.current;
      if (pending) {
        drawPlacementPreview(
          ctx,
          pending.sx,
          pending.sy,
          DEFAULT_SQUARE_SCREEN_SIZE,
          SHAPE_THEME,
          cameraRef.current.scale,
        );
      }
      const marquee = marqueeRef.current;
      if (marquee) {
        drawMarquee(ctx, marquee, MARQUEE_FILL, MARQUEE_STROKE);
      }
    }, [width, height, cameraRef]);

    useEffect(() => {
      drawGridRef.current = drawGridLayer;
    }, [drawGridLayer]);
    useEffect(() => {
      drawSceneRef.current = drawSceneLayer;
    }, [drawSceneLayer]);

    // ---- Backing-store sizing (the ONLY place canvases are resized) --------
    useEffect(() => {
      const gridCanvas = gridCanvasRef.current;
      const sceneCanvas = sceneCanvasRef.current;
      if (!gridCanvas || !sceneCanvas) return;

      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
      const pxWidth = Math.floor(width * dpr);
      const pxHeight = Math.floor(height * dpr);

      gridCanvas.width = pxWidth;
      gridCanvas.height = pxHeight;
      sceneCanvas.width = pxWidth;
      sceneCanvas.height = pxHeight;

      const gridCtx = gridCanvas.getContext('2d', { ...LOW_LATENCY, alpha: false });
      const sceneCtx = sceneCanvas.getContext('2d', LOW_LATENCY);
      if (!gridCtx || !sceneCtx) return;
      gridCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sceneCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      gridCtxRef.current = gridCtx;
      sceneCtxRef.current = sceneCtx;
      rectRef.current = sceneCanvas.getBoundingClientRect();

      drawGridLayer();
      drawSceneLayer();
    }, [width, height, drawGridLayer, drawSceneLayer]);

    useEffect(() => {
      return () => {
        if (frameRef.current) cancelAnimationFrame(frameRef.current);
      };
    }, []);

    // ---- Placement API (driven by the Space button) ------------------------
    useImperativeHandle(
      ref,
      (): CanvasHandle => ({
        startPlacement(clientX, clientY) {
          const rect = rectRef.current;
          if (!rect) return;
          placementRef.current = { sx: clientX - rect.left, sy: clientY - rect.top };
          requestDraw('scene');
        },
        updatePlacement(clientX, clientY) {
          const rect = rectRef.current;
          const pending = placementRef.current;
          if (!rect || !pending) return;
          pending.sx = clientX - rect.left;
          pending.sy = clientY - rect.top;
          requestDraw('scene');
        },
        commitPlacementAtClient(clientX, clientY) {
          const rect = rectRef.current;
          if (!rect || !placementRef.current) return;
          commitPlacement(clientX - rect.left, clientY - rect.top);
        },
        cancelPlacement() {
          if (placementRef.current) {
            placementRef.current = null;
            requestDraw('scene');
          }
        },
      }),
      [requestDraw, commitPlacement],
    );

    return (
      <>
        <canvas
          ref={gridCanvasRef}
          className={`${styles.canvas} ${styles.grid}`}
          style={{ width, height }}
          aria-hidden="true"
        />
        <canvas
          ref={sceneCanvasRef}
          className={`${styles.canvas} ${styles.scene}`}
          style={{ width, height }}
          aria-label="Infinite drawing canvas"
          role="img"
        />
        {editor && (
          <input
            ref={dimInputRef}
            key={`${editor.shapeId}:${editor.which}`}
            className={styles.dimInput}
            style={{
              left: editor.x,
              top: editor.y,
              transform: `translate(-50%, -50%) rotate(${editor.angle}deg)`,
            }}
            value={editor.value}
            inputMode="decimal"
            aria-label={`${editor.which} in feet`}
            onChange={(e) =>
              setEditor((ed) => (ed ? { ...ed, value: e.target.value } : ed))
            }
            onKeyDown={(e) => {
              // Space commits too (a number never needs a space), like Enter.
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                commitDimension();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setEditor(null);
              }
            }}
            onBlur={commitDimension}
          />
        )}
      </>
    );
  },
);
