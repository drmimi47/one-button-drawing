import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
} from 'react';
import type {
  CanvasStats,
  DrawLayer,
  Footprint,
  LengthUnit,
  Marquee,
  PendingPlacement,
  Square,
} from '../../types';
import {
  GRID_THEME,
  SHAPE_THEME,
  MAX_SCALE,
  DEFAULT_SQUARE_SCREEN_SIZE,
  DEFAULT_WALL_WORLD,
  WORLD_UNITS_PER_FOOT,
  MIN_WALL_WORLD,
  MAX_DEVICE_PIXEL_RATIO,
  MARQUEE_FILL,
  MARQUEE_STROKE,
  worldUnitsPerUnit,
  computeGridExtentCells,
} from '../../constants';
import { drawGrid } from '../../canvas/grid';
import {
  drawShapes,
  drawMarquee,
  defaultWalls,
  boundingBoxLocal,
  adjacentCopyOffset,
  shapeAreaInUnit,
  shapeGrossAreaInUnit,
  withEdgeThickness,
  recenterCorners,
  type HandleId,
  type EdgeFace,
  type HoverRegion,
  type DimensionLabelHit,
  type CenterLabelHit,
  type WallDimensionLabelHit,
} from '../../canvas/shapes';
import { drawClusterPreview } from '../../canvas/thumbnail';
import { DEFAULT_FACADE_ASSEMBLY } from '../../facade/assemblies';
import {
  facadeType,
  inchesToWorld,
  worldToInches,
  feetToWorld,
  bandInchesFor,
} from '../../facade/catalog';
import { computePanelTypes, type PanelType } from '../../facade/standardize';
import { drawPartition } from '../../canvas/partitionDraw';
import {
  newDoc,
  cloneDoc as clonePartitionDoc,
  activeLayer as partitionActiveLayer,
  hasBoundary as partitionHasBoundary,
  addLayer as addPartitionLayer,
  selectLayer as selectPartitionLayer,
  splitCell as splitPartitionCell,
  placeBorder as placePartitionBorder,
  resizeBorderExtent,
  summarizeDoc,
  panelStats as partitionPanelStatsOf,
  optimizeEdgeNormalize,
  optimizeEdgeProfile,
  optimizeModularCluster,
  optimizeSteppedEdge,
  borderBooleanHoverAt,
  representativeCell,
  cellGroupAt,
  seedGroupFrames,
  groupFrame,
  setGroupPanelKind,
  type CellRef,
  type PanelKind,
  type FacadeDoc,
  type FacadeSummary,
  type OptimizeStrategy,
  type Rect,
  type SegmentRef,
} from '../../facade/partition';
import { drawFootprints } from '../../canvas/footprint';
import { findMatches } from '../../search/findQuery';
import {
  drawAlignmentGuides,
  resolveWallSnap,
  emptySnapState,
  type AlignGuide,
} from '../../canvas/snapping';
import { isUsableFloorArea } from '../../rooms/roomCatalog';
import {
  enumerateViolations,
  proposeFix,
  globalNotes,
  violationKey,
  type Violation,
  type Proposal,
  type FixResult,
} from '../../constraints/autofix';
import type { PredictionOption } from '../../rooms/roomAdjacency';
import { screenToWorld } from '../../canvas/coords';
import type { Constraints } from '../../../backend/types';
import { hasAnyConstraint } from '../../../backend/types';
import { findViolations, type ShapeViolations } from '../../../backend/violations';
import { worsensConstraints } from '../../../backend/clamp';
import { useCamera } from '../../hooks/useCamera';
import { useCanvasInteractions } from '../../hooks/useCanvasInteractions';
import { useWindowSize } from '../../hooks/useWindowSize';
import { perfMonitor } from '../../perf/perfMonitor';
import styles from './InfiniteCanvas.module.css';

/** Imperative placement API the action button drives. */
/** Live read-out of the single selected facade panel, reported to App for the assembly inspector. */
export interface SelectedPanelInfo {
  /** The selected shape's id. */
  id: string;
  /** Its assembly type key (e.g. "UCWP"). */
  assembly: string;
  /** Interior width / height in feet. */
  widthFt: number;
  heightFt: number;
  /** The visible mullion/joint band width in inches (its uniform wall thickness). */
  bandIn: number;
}

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
  /**
   * Create the given rooms (each its own interior size in feet + display name),
   * laid out left→right in a flush horizontal line (outer walls touching, no
   * overlap) centred in the current view. One undo step; the new rooms become the
   * selection. Drives the Prompt — sizes/names come from the room catalog resolver.
   */
  createRoomsFromList(rooms: { name: string; widthFt: number; heightFt: number }[]): void;
  /**
   * Arm placement of a saved Library cluster: a ghost of the whole arrangement
   * follows the cursor from the given client point and commits where released (drag)
   * or on the next canvas click. `shapes` must be origin-centred (as stored).
   */
  startClusterPlacement(shapes: Square[], clientX: number, clientY: number): void;
  /**
   * Arm the building-footprint tool: the next click-drag on the canvas draws a
   * white-slab, black-outlined footprint behind every room. Single-shot — it
   * disarms once one footprint is drawn (or the drag is cancelled).
   */
  armFootprintDraw(): void;
  /**
   * Run a smart-find search over the current shapes and highlight the matches in
   * accent blue (rooms washed, matched wall bands filled). Returns the match count.
   */
  runFind(query: string): number;
  /** Clear any active smart-find highlight. */
  clearFind(): void;
  /**
   * Facade mode: capture the current selection for an AI render — the selected shapes (clones) and the
   * count. The multi-pass renderer builds its own per-material reference images from these. Returns null
   * when nothing is selected.
   */
  captureSelectionShapes(): { shapes: Square[]; count: number } | null;
  /**
   * Replace the current selection with the given shape ids (Facade standardization: select every
   * panel of a type from the Analyze popup). Unknown ids are ignored; an empty list clears selection.
   */
  selectShapeIds(ids: string[]): void;
  /**
   * Facade mode: set the selected panel's assembly type — updates its `name` and its band (wall)
   * thickness from the type's default band, keeping its size. One undo step.
   */
  setSelectionAssembly(key: string): void;
  /** Facade mode: resize one panel's interior to the given feet, about its centre. One undo step. */
  setShapeSize(id: string, widthFt: number, heightFt: number): void;
  /**
   * Facade mode: set the uniform band (wall) thickness, in inches, on every panel of the given
   * assembly type — propagates a type-level mullion/joint change to all its panels. One undo step.
   */
  applyAssemblyBand(key: string, inches: number): void;
  /** Layers tool: add a fresh blank layer on top and make it active (the user draws its boundary). */
  addLayer(): void;
  /** Layers tool: select a layer by index. */
  selectLayer(index: number): void;
  /** Layers tool: split the referenced cell (in the active layer) into `cols × rows`. */
  splitCell(ref: CellRef, cols: number, rows: number): void;
  /** Layers tool: total visible panels + how many are UNIQUE shapes in the active layer (the Optimize metric). */
  partitionPanelStats(): { total: number; unique: number };
  /** Layers tool: rationalize the active layer with the chosen strategy to reduce unique panels (one undo step). */
  optimizePartition(strategy: OptimizeStrategy): void;
  /**
   * Layers tool: begin an Edit-a-panel session on the currently selected panel group(s) — zoom to a
   * representative panel and auto-seed a uniform frame on the group. Returns the edited group keys, or null
   * when nothing is selected. The user then drags panel edges to set per-edge frame widths (mirrored to the
   * group); `endPanelFrameEdit` eases the camera back.
   */
  startPanelFrameEdit(clickRect?: Rect | null): { keys: string[] } | null;
  /** Layers tool: end the Edit-a-panel session and restore the prior camera. */
  endPanelFrameEdit(): void;
  /** Layers tool: assign a panel MATERIAL kind to the selected panel group(s) (null clears it). One undo step. */
  assignPanelKind(kind: PanelKind | null): void;
  /**
   * Begin a guided constraint-fix session: enumerate every violation, zoom to the
   * first offending room, and preview its proposed fix. Returns the first step (or a
   * done-summary if nothing is violated). Subsequent steps come from fixApprove/fixSkip.
   */
  fixStart(): FixResult;
  /** Apply the current step's proposed fix (one undo step), then advance. */
  fixApprove(): FixResult;
  /** Leave the current violation as-is and advance to the next. */
  fixSkip(): FixResult;
  /** End the session: clear the preview and ease the camera back to where it started. */
  fixCancel(): void;
}

/** Default mullion width (inches) auto-seeded onto a group's frame when an Edit-a-panel session starts. */
const DEFAULT_PANEL_FRAME_IN = 2;

interface InfiniteCanvasProps {
  gridSize: number;
  /** Active global constraints; rooms breaking a rule are flagged bright green. */
  constraints: Constraints;
  /** When on, draws dev overlays (green centre numbers, cyan overlap region). */
  debug?: boolean;
  /** When on (the Analyze view), every shape is ghosted — the dev overlays stay off. */
  analyze?: boolean;
  /**
   * When false, the yellow constraint-violation highlights are hidden on the canvas
   * (per-room flags + the global budget wash). Violations are still computed, so the
   * Constraints button's superscript count is unaffected. Defaults to true.
   */
  showConstraintHighlights?: boolean;
  /** Reports live canvas stats (count + areas) whenever they change. */
  onStatsChange?: (stats: CanvasStats) => void;
  /** Reports the selected-shape count whenever it changes (drives the Render button gate). */
  onSelectionChange?: (count: number) => void;
  /**
   * Facade mode: reports the single selected panel's live geometry + assembly (or null when zero /
   * several panels are selected, or in Plan mode) — drives the left assembly inspector and the
   * bidirectional size/band sync. Deduped on change, so it updates live during canvas drags.
   */
  onSelectedPanelChange?: (panel: SelectedPanelInfo | null) => void;
  /**
   * Client rect of the Library nav button (or null). While the selection is being
   * dragged over it, the drop is treated as "save to Library" rather than a move.
   */
  libraryDropRef?: MutableRefObject<DOMRect | null>;
  /** Client rect of the open Library popup (or null) — also a save drop-target. */
  libraryPopupDropRef?: MutableRefObject<DOMRect | null>;
  /** Fires true/false as a selection drag enters/leaves the Library button. */
  onLibraryHover?: (over: boolean) => void;
  /** Fires with the dragged shapes when they're dropped onto the Library button. */
  onLibraryDrop?: (shapes: Square[]) => void;
  /**
   * Fires when the smart-find highlight changes: a match count after a search, or
   * `null` when a canvas edit clears the highlight (so the App can drop its chip).
   */
  onFindChange?: (count: number | null) => void;
  /** Fires with the hovered room's catalog key (or null) — drives the dev matrix highlight. */
  onHoverRoomKey?: (key: string | null) => void;
  /**
   * Facade mode: a separate workspace. Switching it on/off swaps the canvas to that mode's own
   * shapes (so Facade starts empty / "cleared"), and a dropped default shape is named the default
   * facade assembly instead of "Room".
   */
  facade?: boolean;
  /**
   * Facade standardization view (the Analyze popup is open): panels are coloured by type, clicking a
   * panel selects every panel of that type, and {@link onPanelTypesChange} reports the live type list.
   */
  standardize?: boolean;
  /** Reports the standardized panel types whenever they change (drives the Analyze popup list). */
  onPanelTypesChange?: (types: PanelType[]) => void;
  /**
   * Facade Layers tool (uniform sticky-cell partition). When active, the canvas edits the layer stack and
   * HIDES the rooms. `onPartitionChange` reports the live layer/cell summary for the top-center navigator;
   * `onCellContextMenu` fires on a right-click over a cell to open the split menu.
   */
  layersActive?: boolean;
  /**
   * Layers tool sub-mode. `true` (Border) = the trim boundary is editable (draw / move corners / stretch
   * edges). `false` (Panels) = the border is locked and only the inner grid (lines, splits, panel groups)
   * is editable. Defaults to Border.
   */
  borderMode?: boolean;
  /** Material-ID (segmentation) view: paint each cell a flat contrasting colour. */
  idView?: boolean;
  /** Purely-visual drop shadow under the per-group frame bands (depth only). */
  frameShadow?: boolean;
  /** Optimize overlay: paint each panel its shape-group number, centred (identical panels share a number). */
  panelNumbers?: boolean;
  /** Live split-menu preview: the cell `ref` being split into `cols × rows`, or null. The preview is computed
   *  from the actual resulting partition (lattice tiled + clipped to the boundary). */
  splitPreview?: { ref: CellRef; cols: number; rows: number } | null;
  onPartitionChange?: (summary: FacadeSummary) => void;
  onCellContextMenu?: (info: { screenX: number; screenY: number; ref: CellRef; rect: Rect | null }) => void;
  /** End the active Edit-a-panel session (a clean click outside the border / on another group acts as Done). */
  onExitFrameEdit?: () => void;
}

/** State for the floating dimension-editing input. */
interface DimEditorState {
  shapeId: string;
  which: 'width' | 'height' | 'name' | 'area' | 'wallLength' | 'wallThickness';
  /** For wall edits, which interior edge the value applies to. */
  edge?: number;
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

/** Deep-enough clone of one shape (geometry + walls + corners + per-edge walls). */
function cloneShape(s: Square): Square {
  return {
    ...s,
    walls: { ...s.walls },
    corners: s.corners?.map((p) => ({ ...p })),
    wallEdges: s.wallEdges?.slice(),
  };
}

/** Deep-enough clone of the shapes for an immutable history snapshot. */
function cloneShapes(shapes: Square[]): Square[] {
  return shapes.map(cloneShape);
}

/** Snapshot clone of the footprints (flat rects, so a shallow copy each). */
function cloneFootprints(footprints: Footprint[]): Footprint[] {
  return footprints.map((f) => ({ ...f }));
}

/**
 * Render-only clone of `s` scaled by `f` (0..1) toward `pivot` (world centre of the
 * dragged group) — drives the shrink-into-Library animation. Geometry and walls all
 * scale together so the room collapses proportionally toward the button; never
 * committed (the real shape keeps its size).
 */
function shrinkShapeToward(s: Square, pivot: { x: number; y: number }, f: number): Square {
  const cx = s.x + s.width / 2;
  const cy = s.y + s.height / 2;
  const ncx = pivot.x + (cx - pivot.x) * f;
  const ncy = pivot.y + (cy - pivot.y) * f;
  const w = s.width * f;
  const h = s.height * f;
  return {
    ...s,
    x: ncx - w / 2,
    y: ncy - h / 2,
    width: w,
    height: h,
    walls: { n: s.walls.n * f, e: s.walls.e * f, s: s.walls.s * f, w: s.walls.w * f },
    corners: s.corners?.map((p) => ({ x: p.x * f, y: p.y * f })),
    wallEdges: s.wallEdges?.map((t) => t * f),
  };
}

/** Copy a clone's geometry back onto a live shape — reverts a rejected edit. */
function restoreShape(target: Square, src: Square): void {
  target.x = src.x;
  target.y = src.y;
  target.width = src.width;
  target.height = src.height;
  target.walls = src.walls;
  target.corners = src.corners;
  target.wallEdges = src.wallEdges;
}

/** Cap on undo depth, to bound memory. */
const MAX_HISTORY = 200;

/** One undo/redo step: the shapes, building footprints, the active unit, and the facade partition doc. */
interface Snapshot {
  shapes: Square[];
  footprints: Footprint[];
  unit: LengthUnit;
  partition: FacadeDoc;
}

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
  function InfiniteCanvas(
    {
      gridSize,
      constraints,
      debug,
      analyze,
      facade,
      showConstraintHighlights = true,
      onStatsChange,
      onSelectionChange,
      onSelectedPanelChange,
      libraryDropRef,
      libraryPopupDropRef,
      onLibraryHover,
      onLibraryDrop,
      onFindChange,
      onHoverRoomKey,
      standardize,
      onPanelTypesChange,
      layersActive,
      borderMode,
      idView,
      frameShadow,
      panelNumbers,
      splitPreview,
      onPartitionChange,
      onCellContextMenu,
      onExitFrameEdit,
    },
    ref,
  ) {
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
    // Building footprints (white slab + black outline) drawn BEHIND every room.
    // Drawn by the Generate tool menu's square tool; resizable via their own
    // Length/Width dimension labels.
    const footprintsRef = useRef<Footprint[]>([]);
    // True once the square footprint tool is armed (the next canvas drag draws one).
    const footprintArmRef = useRef(false);
    // The footprint currently being drag-drawn (live preview), or null.
    const footprintDraftRef = useRef<Footprint | null>(null);
    // Shrink-into-Library animation: while a selection drag hovers the Library
    // button the selected shapes ease from scale 1 down to `target` (and back to 1
    // on leave), signalling they're being stored. Render-only — never committed.
    const libraryShrinkRef = useRef({ scale: 1, target: 1, pivot: { x: 0, y: 0 } });
    // Smart-find highlight: rooms matched by a search (washed blue) and the matched
    // wall sides per shape (filled blue). Empty when no find is active. Render-only.
    const highlightRef = useRef<{ roomIds: Set<string>; wallMap: Map<string, HandleId[]> }>({
      roomIds: new Set(),
      wallMap: new Map(),
    });
    // Guided constraint-fix session state. `current` holds the violation under review
    // and its proposal; `skipped` excludes left-alone violations from re-enumeration.
    const fixSessionRef = useRef<{
      skipped: Set<string>;
      priorCamera: { x: number; y: number; scale: number };
      fixedCount: number;
      skippedCount: number;
      current: { violation: Violation; proposal: Proposal } | null;
    } | null>(null);
    // Translucent ghost of the proposed fix for the room under review (render-only).
    const fixPreviewRef = useRef<{ shapeId: string; ghost: Square } | null>(null);
    // Edit-a-panel session: the selected group keys being framed, the representative cell rect (camera focus +
    // edge hit-testing), the camera to restore on exit, and the live hovered/dragged frame side.
    const frameEditRef = useRef<{
      keys: string[];
      rect: Rect;
      priorCamera: { x: number; y: number; scale: number };
      hoverSide: 'n' | 'e' | 's' | 'w' | 'b' | null;
      allSides: boolean;
    } | null>(null);
    // In-flight camera-ease rAF id (focus / restore), so a new focus cancels the old.
    const cameraTweenRef = useRef(0);
    // Active wall-alignment guide lines during a move drag (green); null when none.
    const alignGuidesRef = useRef<AlignGuide[] | null>(null);
    // Per-axis wall-snap lock for the in-progress single-room placement preview.
    const placeSnapStateRef = useRef(emptySnapState());
    // Last stats key reported to React, so the StatsBar signal fires only when a
    // displayed value actually changes (not every frame).
    const lastStatsKeyRef = useRef('');
    // Last reported selection count, so onSelectionChange only fires on an actual change.
    const lastSelCountRef = useRef(-1);
    // Last reported single-selected facade panel key, so onSelectedPanelChange only fires on a change.
    // Sentinel '\0' means "never reported"; '' means "null reported".
    const lastSelPanelKeyRef = useRef<string>('\0');
    const selectionRef = useRef<Set<string>>(new Set());
    // Order shapes were selected in (oldest first), kept in sync with the
    // selection each frame. Groundwork for boolean ops (e.g. difference = first
    // selected minus the rest); cleared automatically when selection empties.
    const selectionOrderRef = useRef<string[]>([]);
    // Active region of the selection: a handle id highlights just that wall
    // edge; null (with a selection) highlights the white infill instead.
    const activeEdgeRef = useRef<HandleId | null>(null);
    // Which face of the active edge the pointer is nearer (glows magenta), or
    // null when not hovering it.
    const edgeHoverRef = useRef<EdgeFace | null>(null);
    // Shift held over that face → light ALL inner/outer faces (stretch the whole
    // boundary at once).
    const edgeFaceAllRef = useRef(false);
    // True once an edge has been ARMED by a clean click (press + release, no drag),
    // gating the per-edge wall length/thickness dimensions. A fresh stretch that
    // begins on an un-armed edge never summons them; a clean click does, and they
    // persist (incl. through a subsequent stretch of that armed edge).
    const wallDimsArmedRef = useRef(false);
    // Shape + region the pointer is over, for the hover-preview darkening.
    const hoverRef = useRef<{ id: string; region: HoverRegion } | null>(null);
    // Cursor in canvas-local screen px (null off-canvas / mid-drag), so a shared
    // overlap edge can highlight yellow on hover when both rooms are selected.
    const hoverPointRef = useRef<{ x: number; y: number } | null>(null);
    // Shape whose centre name/area readout is being hovered (single selection),
    // so the editable box can be drawn around it.
    const centerHoverRef = useRef<string | null>(null);
    // Edge-plus button hovered/dragged ({shape id, direction 0=n/1=e/2=s/3=w, copy
    // count}), so the scene can ghost the translucent duplicate(s) it would drop.
    const edgePlusHoverRef = useRef<{ id: string; dir: number; count: number } | null>(null);
    // Active next-room prediction fan: which opened shape + edge arrow is being
    // dragged, the hovered option (0..2), and whether the drag has begun (the fan
    // only appears once dragging, not on a bare press).
    const predictionDragRef = useRef<{
      shapeId: string;
      dir: number;
      hovered: number | null;
      dragging: boolean;
      options: (PredictionOption | null)[];
    } | null>(null);
    // True while an edge stretch is dragging, so dimensions stay live.
    const resizingRef = useRef(false);
    // While rotating: shape id + grabbed corner, for the live angle readout.
    const rotatingRef = useRef<{ id: string; corner: HandleId } | null>(null);
    // Website-wide measurement unit (default feet); switched by typing a unit
    // keyword into any dimension editor.
    const unitRef = useRef<LengthUnit>('feet');
    const marqueeRef = useRef<Marquee | null>(null);
    const placementRef = useRef<PendingPlacement | null>(null);

    // Undo/redo as snapshots of the shapes array AND the active unit. `baseline`
    // mirrors the current committed state; `commitHistory` (called after every
    // mutation) pushes the prior baseline onto `undo`. Adding a new undoable
    // action is just a matter of calling commitHistory() once the change applies.
    const historyRef = useRef<{ undo: Snapshot[]; redo: Snapshot[]; baseline: Snapshot }>({
      undo: [],
      redo: [],
      baseline: { shapes: [], footprints: [], unit: 'feet', partition: newDoc() },
    });

    // In-app clipboard for copy/cut/paste. `pasteSeq` cascades repeated pastes
    // so they don't stack exactly on top of each other.
    const clipboardRef = useRef<Square[]>([]);
    const pasteSeqRef = useRef(0);

    // ---- Frame scheduler (per-layer dirty flags, one rAF) ------------------
    // Latest constraints, read by the scene draw (a ref so the imperative render
    // loop sees updates without this component re-rendering on every frame).
    const constraintsRef = useRef<Constraints>(constraints);
    // Debug-overlay flag (green centre numbers + cyan overlap), read by the draw.
    const debugRef = useRef(debug);
    // Analyze view: ghost every shape (no dev overlays), read by the scene draw.
    const analyzeRef = useRef(analyze);
    // Facade mode flag, read by createSquareAtWorld + the right-click handler.
    const facadeRef = useRef(facade);
    // Facade Layers tool (uniform sticky-cell partition): active flag, the layer-stack document, the live
    // boundary-draw preview rect, and a key to dedupe summary reports.
    const layersActiveRef = useRef(layersActive);
    // Border (true) vs Panels (false) sub-mode of the Layers tool. Defaults to Border.
    const borderModeRef = useRef(borderMode ?? true);
    const partitionDocRef = useRef<FacadeDoc>(newDoc());
    const partitionSelSegRef = useRef<SegmentRef | null>(null);
    const partitionGroupSelRef = useRef<Set<string>>(new Set());
    // Borders picked (shift-click, Border mode) for a boolean unite/difference op, in selection order.
    const partitionBorderSelRef = useRef<Set<number>>(new Set());
    const idViewRef = useRef(idView);
    const frameShadowRef = useRef(frameShadow);
    const panelNumbersRef = useRef(panelNumbers);
    const splitPreviewRef = useRef(splitPreview);
    const lastPartitionKeyRef = useRef('');
    // Standardization view (Analyze popup open): colour panels by type + type-group click-select.
    const standardizeRef = useRef(standardize);
    // Live shape-id → type colour map for the standardization view (rebuilt each frame when active).
    const panelColorsRef = useRef<Map<string, string> | null>(null);
    // Change key for the reported panel-type list, so onPanelTypesChange only fires on a real change.
    const lastPanelTypesKeyRef = useRef('');
    // Plan and Facade are separate workspaces: each keeps its own shapes + footprints, stashed here
    // while the other mode is active (null = never visited → starts empty / "cleared"). prevFacadeRef
    // tracks the last mode so the swap effect knows which slot to stash into.
    const workspaceStashRef = useRef<{
      plan: { shapes: Square[]; footprints: Footprint[] } | null;
      facade: { shapes: Square[]; footprints: Footprint[] } | null;
    }>({ plan: null, facade: null });
    const prevFacadeRef = useRef(!!facade);
    // When false, the canvas skips drawing the yellow constraint-violation highlights
    // (the Constraints "Visibility" eye toggles this). Violations are still computed.
    const showViolationsRef = useRef(showConstraintHighlights);

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

    // A new/changed constraint set re-flags every shape on the next frame.
    useEffect(() => {
      constraintsRef.current = constraints;
      requestDraw('scene');
    }, [constraints, requestDraw]);

    // Toggling Debug shows/hides the dev overlays on the next frame.
    useEffect(() => {
      debugRef.current = debug;
      requestDraw('scene');
    }, [debug, requestDraw]);

    // Toggling Analyze ghosts/un-ghosts the shapes on the next frame.
    useEffect(() => {
      analyzeRef.current = analyze;
      requestDraw('scene');
    }, [analyze, requestDraw]);

    // Entering/leaving the standardization view recolours the panels on the next frame. Reset the
    // report key so the type list is (re)emitted on entry even if the grouping is unchanged.
    useEffect(() => {
      standardizeRef.current = standardize;
      lastPanelTypesKeyRef.current = '';
      if (!standardize) {
        panelColorsRef.current = null;
        onPanelTypesChange?.([]);
      }
      requestDraw('scene');
    }, [standardize, onPanelTypesChange, requestDraw]);

    // Switching Plan ⇄ Facade swaps to that mode's own workspace: stash the outgoing shapes,
    // restore the incoming ones (empty the first time, so Facade starts cleared). Undo history is
    // reset to the restored workspace (no cross-mode undo). The redraw re-emits stats.
    useEffect(() => {
      facadeRef.current = facade;
      const isFacade = !!facade;
      if (prevFacadeRef.current === isFacade) return; // not a mode change
      const stash = workspaceStashRef.current;
      const outgoing = {
        shapes: cloneShapes(shapesRef.current),
        footprints: cloneFootprints(footprintsRef.current),
      };
      if (prevFacadeRef.current) stash.facade = outgoing;
      else stash.plan = outgoing;
      const incoming = isFacade ? stash.facade : stash.plan;
      shapesRef.current = incoming ? cloneShapes(incoming.shapes) : [];
      footprintsRef.current = incoming ? cloneFootprints(incoming.footprints) : [];
      selectionRef.current = new Set();
      activeEdgeRef.current = null;
      placementRef.current = null;
      historyRef.current = {
        undo: [],
        redo: [],
        baseline: {
          shapes: cloneShapes(shapesRef.current),
          footprints: cloneFootprints(footprintsRef.current),
          unit: unitRef.current,
          partition: clonePartitionDoc(partitionDocRef.current),
        },
      };
      prevFacadeRef.current = isFacade;
      requestDraw('all');
    }, [facade, requestDraw]);

    // Toggling the Constraints "Visibility" eye shows/hides the yellow violation
    // highlights on the next frame (the count/superscript is unaffected).
    useEffect(() => {
      showViolationsRef.current = showConstraintHighlights;
      requestDraw('scene');
    }, [showConstraintHighlights, requestDraw]);

    const { cameraRef } = useCamera(sceneCanvasRef, requestAll);

    // Entering/leaving the Layers tool just toggles the flag and redraws — the user draws the boundary
    // (no auto-seed). 'all' so the grid layer redraws too: it hides while the tool is on, restores when off.
    useEffect(() => {
      layersActiveRef.current = layersActive;
      requestDraw('all');
    }, [layersActive, requestDraw]);

    // Switching between Border and Panels sub-modes repaints the partition (hides/shows the corner handles).
    useEffect(() => {
      borderModeRef.current = borderMode ?? true;
      requestDraw('scene');
    }, [borderMode, requestDraw]);

    // Toggling the Material-ID view just repaints the partition scene.
    useEffect(() => {
      idViewRef.current = idView;
      requestDraw('scene');
    }, [idView, requestDraw]);

    // Toggling the frame drop shadow just repaints the partition scene.
    useEffect(() => {
      frameShadowRef.current = frameShadow;
      requestDraw('scene');
    }, [frameShadow, requestDraw]);

    // Showing/hiding the Optimize paint-by-number overlay just repaints the partition scene.
    useEffect(() => {
      panelNumbersRef.current = panelNumbers;
      requestDraw('scene');
    }, [panelNumbers, requestDraw]);

    // Live split-menu preview: repaint whenever the previewed cell / counts change.
    useEffect(() => {
      splitPreviewRef.current = splitPreview;
      requestDraw('scene');
    }, [splitPreview, requestDraw]);

    // Snapshot the current shapes as one undo step (call after a mutation).
    const commitHistory = useCallback(() => {
      const h = historyRef.current;
      h.undo.push(h.baseline);
      if (h.undo.length > MAX_HISTORY) h.undo.shift();
      h.baseline = {
        shapes: cloneShapes(shapesRef.current),
        footprints: cloneFootprints(footprintsRef.current),
        unit: unitRef.current,
        partition: clonePartitionDoc(partitionDocRef.current),
      };
      h.redo.length = 0;
    }, []);

    // Commit a square centred on a world point, select it, and redraw the scene.
    const createSquareAtWorld = useCallback(
      (worldX: number, worldY: number, worldSize?: number, name?: string) => {
        const size = worldSize ?? DEFAULT_SQUARE_SCREEN_SIZE / cameraRef.current.scale;
        const finalName = name ?? (facadeRef.current ? DEFAULT_FACADE_ASSEMBLY : 'Room');
        // In Facade mode a dropped panel takes its assembly type's default proportions + band (mullion
        // / joint) thickness, so the default shape reflects the chosen facade classification.
        let width = size;
        let height = size;
        let walls = defaultWalls();
        if (facadeRef.current) {
          const def = facadeType(finalName);
          width = feetToWorld(def.defaultWidthFt);
          height = feetToWorld(def.defaultHeightFt);
          const bandWorld = inchesToWorld(bandInchesFor(def.defaultMeta, finalName));
          walls = { n: bandWorld, e: bandWorld, s: bandWorld, w: bandWorld };
        }
        const square: Square = {
          id: createId(),
          x: worldX - width / 2,
          y: worldY - height / 2,
          width,
          height,
          rotation: 0,
          walls,
          dots: false,
          name: finalName,
        };
        shapesRef.current.push(square);
        selectionRef.current = new Set([square.id]);
        activeEdgeRef.current = null;
        commitHistory();
        requestDraw('scene');
      },
      [cameraRef, commitHistory, requestDraw],
    );

    // Drop fresh, re-id'd copies of a (origin-centred) cluster's shapes with their
    // centre on a world point; select them as one undo step. Retains every shape's
    // orientation, size, walls and other properties.
    const createClusterAtWorld = useCallback(
      (shapes: Square[], worldX: number, worldY: number) => {
        const ids: string[] = [];
        for (const s of shapes) {
          const copy = cloneShape(s);
          copy.id = createId();
          copy.x += worldX;
          copy.y += worldY;
          shapesRef.current.push(copy);
          ids.push(copy.id);
        }
        if (ids.length === 0) return;
        selectionRef.current = new Set(ids);
        activeEdgeRef.current = null;
        commitHistory();
        requestDraw('scene');
      },
      [commitHistory, requestDraw],
    );

    // Place the armed preview at a canvas-local screen point: a saved cluster drops
    // its whole arrangement; otherwise a single default/room square.
    const commitPlacement = useCallback(
      (sx: number, sy: number) => {
        const pending = placementRef.current;
        placementRef.current = null;
        // Drop the placement's snap guides + lock state once it's committed.
        alignGuidesRef.current = null;
        placeSnapStateRef.current = emptySnapState();
        if (pending?.clusterShapes) {
          const world = screenToWorld(sx, sy, cameraRef.current);
          createClusterAtWorld(pending.clusterShapes, world.x, world.y);
          return;
        }
        // Facade Layers tool active → the cube places a TRIM BORDER (not a room): a default 12'×12' quad
        // centred on the cursor that the shared lattice clips against. The first border seeds the lattice;
        // later ones are appended.
        if (layersActiveRef.current) {
          const world = screenToWorld(sx, sy, cameraRef.current);
          const size = pending?.worldSize ?? DEFAULT_SQUARE_SCREEN_SIZE / cameraRef.current.scale;
          const rect: Rect = { x: world.x - size / 2, y: world.y - size / 2, w: size, h: size };
          placePartitionBorder(partitionActiveLayer(partitionDocRef.current), rect);
          commitHistory();
          requestDraw('scene');
          return;
        }
        // Single rooms land on their wall-snapped centre (set by the draw layer) when
        // snapping was engaged; otherwise on the plain cursor world point.
        const world = pending?.snapCenter ?? screenToWorld(sx, sy, cameraRef.current);
        createSquareAtWorld(world.x, world.y, pending?.worldSize, pending?.name);
      },
      [cameraRef, createSquareAtWorld, createClusterAtWorld, commitHistory, requestDraw],
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
    }, [editor?.shapeId, editor?.which]);

    const beginDimensionEdit = useCallback((shapeId: string, hit: DimensionLabelHit) => {
      setEditor({
        shapeId,
        which: hit.which,
        x: hit.sx,
        y: hit.sy,
        angle: hit.angleDeg,
        value: hit.text.match(/-?\d*\.?\d+/)?.[0] ?? hit.text, // the bare number
      });
    }, []);

    // Click a centre readout to edit it: the room title (free text) or the square
    // footage (a number that auto-resizes the shape). Always upright (angle 0).
    const beginCenterEdit = useCallback((shapeId: string, hit: CenterLabelHit) => {
      // Facade panels are typed from the inspector dropdown, not by free-typing the on-canvas title.
      if (facadeRef.current && hit.which === 'name') return;
      setEditor({
        shapeId,
        which: hit.which,
        x: hit.sx,
        y: hit.sy,
        angle: 0,
        value: hit.which === 'name' ? hit.text : hit.text.match(/-?\d*\.?\d+/)?.[0] ?? hit.text,
      });
    }, []);

    // Click a wall (edge) dimension label to edit it: the edge's length or its wall
    // thickness. Carries the edge index so commit knows which wall to change.
    const beginWallDimensionEdit = useCallback((shapeId: string, hit: WallDimensionLabelHit) => {
      setEditor({
        shapeId,
        which: hit.which,
        edge: hit.edge,
        x: hit.sx,
        y: hit.sy,
        angle: hit.angleDeg,
        value: hit.text.match(/-?\d*\.?\d+/)?.[0] ?? hit.text, // the bare number
      });
    }, []);

    const commitDimension = useCallback(() => {
      const ed = editorRef.current;
      setEditor(null);
      if (!ed) return;

      // Facade trim border width/height: scale the border about its centre to the typed value (in the active
      // unit). The shared lattice stays anchored, so resizing just reveals more/fewer cells — like an edge drag.
      if (ed.shapeId.startsWith('__border__')) {
        const idx = parseInt(ed.shapeId.slice('__border__'.length), 10);
        const layer = partitionActiveLayer(partitionDocRef.current);
        const poly = layer.borders[idx];
        if (poly && (ed.which === 'width' || ed.which === 'height')) {
          const want = parseFloat(ed.value);
          if (Number.isFinite(want) && want > 0) {
            const world = Math.max(1, want * worldUnitsPerUnit(unitRef.current));
            resizeBorderExtent(poly, ed.which === 'width' ? 'x' : 'y', world);
            commitHistory();
            requestDraw('scene');
          }
        }
        return;
      }

      // Building footprint width/height: resize about the centre to the typed value
      // (read in the active unit). No walls or constraints — it's just the slab.
      const fp = footprintsRef.current.find((f) => f.id === ed.shapeId);
      if (fp) {
        if (ed.which === 'width' || ed.which === 'height') {
          const want = parseFloat(ed.value);
          if (Number.isFinite(want) && want > 0) {
            const world = Math.max(1, want * worldUnitsPerUnit(unitRef.current));
            if (ed.which === 'width') {
              const cx = fp.x + fp.width / 2;
              fp.width = world;
              fp.x = cx - world / 2;
            } else {
              const cy = fp.y + fp.height / 2;
              fp.height = world;
              fp.y = cy - world / 2;
            }
            commitHistory();
            requestDraw('scene');
          }
        }
        return;
      }

      const target = shapesRef.current.find((s) => s.id === ed.shapeId);

      // Wall thickness: set just this edge's wall to the typed value (inches in feet
      // mode, mirroring the label), floored at the hard minimum. A value that would
      // create/worsen a constraint violation is rejected (geometry reverts).
      if (ed.which === 'wallThickness') {
        const want = parseFloat(ed.value);
        if (target && ed.edge != null && Number.isFinite(want) && want > 0) {
          const world =
            unitRef.current === 'feet'
              ? (want / 12) * WORLD_UNITS_PER_FOOT // typed inches → world
              : want * worldUnitsPerUnit(unitRef.current);
          const orig = cloneShape(target);
          const next = withEdgeThickness(target, ed.edge, Math.max(MIN_WALL_WORLD, world));
          target.walls = next.walls;
          target.wallEdges = next.wallEdges;
          if (worsensConstraints(target, orig, constraintsRef.current)) {
            restoreShape(target, orig);
          } else {
            commitHistory();
            requestDraw('scene');
          }
        }
        return;
      }

      // Wall length: set this edge's interior length to the typed value. For a
      // rectangle this maps to width (n/s edges) or height (e/w edges) about the
      // centre; for a reshaped quad/N-gon, the edge is scaled about its midpoint
      // (both endpoints move) and the shape re-centres. Violations revert.
      if (ed.which === 'wallLength') {
        const want = parseFloat(ed.value);
        if (target && ed.edge != null && Number.isFinite(want) && want > 0) {
          const world = Math.max(1, want * worldUnitsPerUnit(unitRef.current));
          const orig = cloneShape(target);
          let changed = false;
          if (!target.corners) {
            const horizontal = ed.edge % 2 === 0; // edges 0 (n) / 2 (s) run horizontally
            if (horizontal && world !== target.width) {
              const cx = target.x + target.width / 2;
              target.width = world;
              target.x = cx - world / 2;
              changed = true;
            } else if (!horizontal && world !== target.height) {
              const cy = target.y + target.height / 2;
              target.height = world;
              target.y = cy - world / 2;
              changed = true;
            }
          } else {
            const pts = target.corners;
            const nC = pts.length;
            const a = pts[ed.edge];
            const b = pts[(ed.edge + 1) % nC];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const cur = Math.hypot(dx, dy);
            if (cur > 1e-6 && Math.abs(world - cur) > 1e-6) {
              const ux = dx / cur;
              const uy = dy / cur;
              const mx = (a.x + b.x) / 2;
              const my = (a.y + b.y) / 2;
              pts[ed.edge] = { x: mx - ux * (world / 2), y: my - uy * (world / 2) };
              pts[(ed.edge + 1) % nC] = { x: mx + ux * (world / 2), y: my + uy * (world / 2) };
              const r = recenterCorners(target);
              target.corners = r.corners;
              target.width = r.width;
              target.height = r.height;
              target.x = r.x;
              target.y = r.y;
              changed = true;
            }
          }
          if (changed && worsensConstraints(target, orig, constraintsRef.current)) {
            restoreShape(target, orig);
            changed = false;
          }
          if (changed) {
            commitHistory();
            requestDraw('scene');
          }
        }
        return;
      }

      // Room title: free text (empty falls back to "Room").
      if (ed.which === 'name') {
        if (target) {
          const name = ed.value.trim() || 'Room';
          if (name !== (target.name ?? 'Room')) {
            target.name = name;
            commitHistory();
            requestDraw('scene');
          }
        }
        return;
      }

      // Square footage: scale the whole shape about its centre so its area hits
      // the typed value (linear factor = √(target / current area)).
      if (ed.which === 'area') {
        const want = parseFloat(ed.value);
        if (target && Number.isFinite(want) && want > 0) {
          const current = shapeAreaInUnit(target, unitRef.current);
          if (current > 0 && Math.abs(want - current) > 1e-6) {
            const orig = cloneShape(target);
            const f = Math.sqrt(want / current);
            const wcx = target.x + target.width / 2;
            const wcy = target.y + target.height / 2;
            if (target.corners) {
              target.corners = target.corners.map((p) => ({ x: p.x * f, y: p.y * f }));
            }
            target.width *= f;
            target.height *= f;
            target.x = wcx - target.width / 2;
            target.y = wcy - target.height / 2;
            // Hard lock: a typed value that would create/worsen a violation is
            // rejected (geometry reverts); compliant values apply normally.
            if (worsensConstraints(target, orig, constraintsRef.current)) {
              restoreShape(target, orig);
            } else {
              commitHistory();
              requestDraw('scene');
            }
          }
        }
        return;
      }

      // A typed unit keyword switches the whole site's units. Letters only (digits
      // and punctuation stripped); a prime/apostrophe also means feet.
      const raw = ed.value.trim().toLowerCase();
      const word = raw.replace(/[\d.,\s'′"-]/g, '');
      const cmWords = ['cm', 'cms', 'centimeter', 'centimeters', 'centimetre', 'centimetres'];
      const meterWords = ['m', 'meter', 'meters', 'metre', 'metres', 'mtr', 'mtrs'];
      const feetWords = ['ft', 'feet', 'foot', 'f'];
      let unitChanged = false;
      let nextUnit: LengthUnit | null = null;
      if (raw.includes("'") || raw.includes('′') || feetWords.includes(word)) nextUnit = 'feet';
      else if (cmWords.includes(word)) nextUnit = 'centimeters';
      else if (meterWords.includes(word)) nextUnit = 'meters';
      if (nextUnit && nextUnit !== unitRef.current) {
        unitRef.current = nextUnit;
        unitChanged = true;
      }

      // Resize only when a positive number was typed; a bare keyword (e.g. "m")
      // just switches units. The number is read in the now-active unit.
      const value = parseFloat(raw);
      const shape = shapesRef.current.find((s) => s.id === ed.shapeId);
      let resized = false;
      if (shape && Number.isFinite(value) && value > 0) {
        const orig = cloneShape(shape);
        const world = Math.max(1, value * worldUnitsPerUnit(unitRef.current));
        if (shape.corners) {
          // Reshaped quad: edit its tight bounding-box dimension. Scale the
          // corners along that axis so the box hits the typed size, then rebuild
          // the symmetric extents (width/height) keeping the world centre fixed.
          const bb = boundingBoxLocal(shape);
          const before = ed.which === 'width' ? bb.maxX - bb.minX : bb.maxY - bb.minY;
          if (world !== before && before > 0) {
            const s = world / before;
            shape.corners = shape.corners.map((p) => ({
              x: ed.which === 'width' ? p.x * s : p.x,
              y: ed.which === 'height' ? p.y * s : p.y,
            }));
            let mx = 0;
            let my = 0;
            for (const p of shape.corners) {
              mx = Math.max(mx, Math.abs(p.x));
              my = Math.max(my, Math.abs(p.y));
            }
            const wcx = shape.x + shape.width / 2;
            const wcy = shape.y + shape.height / 2;
            shape.width = mx * 2;
            shape.height = my * 2;
            shape.x = wcx - shape.width / 2;
            shape.y = wcy - shape.height / 2;
            resized = true;
          }
        } else {
          // Rectangle: resize the interior about the centre (keeps rotation natural).
          const before = ed.which === 'width' ? shape.width : shape.height;
          if (world !== before) {
            if (ed.which === 'width') {
              const cx = shape.x + shape.width / 2;
              shape.width = world;
              shape.x = cx - world / 2;
            } else {
              const cy = shape.y + shape.height / 2;
              shape.height = world;
              shape.y = cy - world / 2;
            }
            resized = true;
          }
        }
        // Hard lock: revert a typed dimension that would create/worsen a violation.
        if (resized && worsensConstraints(shape, orig, constraintsRef.current)) {
          restoreShape(shape, orig);
          resized = false;
        }
      }

      // A unit switch is itself undoable, so commit when either the geometry or
      // the unit changed (a single step captures both at once).
      if (resized || unitChanged) {
        commitHistory();
        requestDraw('scene');
      }
    }, [commitHistory, requestDraw]);

    // ---- Undo / redo --------------------------------------------------------
    const applySnapshot = useCallback(
      (snapshot: Snapshot) => {
        shapesRef.current = cloneShapes(snapshot.shapes);
        footprintsRef.current = cloneFootprints(snapshot.footprints);
        footprintDraftRef.current = null;
        unitRef.current = snapshot.unit;
        // Restore the facade partition (deep clone so the stored snapshot stays immutable) and clear its
        // transient drag/selection state; reset the dedupe key so the layer navigator re-syncs.
        partitionDocRef.current = clonePartitionDoc(snapshot.partition);
        partitionSelSegRef.current = null;
        partitionGroupSelRef.current = new Set();
        lastPartitionKeyRef.current = '';
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
      h.baseline = h.undo.pop() as Snapshot;
      applySnapshot(h.baseline);
    }, [applySnapshot]);

    const redo = useCallback(() => {
      const h = historyRef.current;
      if (h.redo.length === 0) return;
      h.undo.push(h.baseline);
      h.baseline = h.redo.pop() as Snapshot;
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

    // Remove the selected shapes outright (no clipboard write), e.g. via Delete /
    // Backspace. A no-op when nothing is selected.
    const deleteSelection = useCallback(() => {
      const sel = selectionRef.current;
      if (sel.size === 0) return;
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
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
          return;
        }
        // Delete / Backspace removes the current selection (no modifier needed).
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          deleteSelection();
          return;
        }
        if (!(e.ctrlKey || e.metaKey)) return;
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
    }, [undo, redo, copySelection, cutSelection, pasteClipboard, deleteSelection]);

    // Clear any active smart-find highlight — like pressing Esc. The interaction hook
    // calls this only when a room is actually EDITED (stretch, vertex move, wall
    // stretch, rotate); navigation (click, pan, zoom) and plain moves keep it.
    // Render-only + idempotent, so calling it per drag-frame is cheap.
    const clearFindHighlight = useCallback(() => {
      const h = highlightRef.current;
      if (h.roomIds.size === 0 && h.wallMap.size === 0) return;
      highlightRef.current = { roomIds: new Set(), wallMap: new Map() };
      requestDraw('scene');
      onFindChange?.(null);
    }, [requestDraw, onFindChange]);

    useCanvasInteractions({
      canvasRef: sceneCanvasRef,
      cameraRef,
      shapesRef,
      selectionRef,
      activeEdgeRef,
      edgeHoverRef,
      edgeFaceAllRef,
      wallDimsArmedRef,
      hoverRef,
      hoverPointRef,
      centerHoverRef,
      edgePlusHoverRef,
      resizingRef,
      rotatingRef,
      unitRef,
      marqueeRef,
      placementRef,
      predictionDragRef,
      footprintsRef,
      footprintArmRef,
      footprintDraftRef,
      libraryShrinkRef,
      commitPlacement,
      beginDimensionEdit,
      beginCenterEdit,
      beginWallDimensionEdit,
      commitHistory,
      requestDraw,
      constraintsRef,
      libraryDropRef,
      libraryPopupDropRef,
      onLibraryHover,
      onLibraryDrop,
      onHoverRoomKey,
      clearFindHighlight,
      alignGuidesRef,
      facadeRef,
      layersActiveRef,
      borderModeRef,
      frameEditRef,
      partitionDocRef,
      partitionSelSegRef,
      partitionGroupSelRef,
      partitionBorderSelRef,
      onCellContextMenu,
      onExitFrameEdit,
    });

    // ---- Render layers -----------------------------------------------------
    const drawGridLayer = useCallback(() => {
      const ctx = gridCtxRef.current;
      if (!ctx) return;
      // Facade mode (incl. the Layers tool): hide the CPlane grid — give the facade a clean blank surface to
      // compose on. Switching into Facade mode therefore toggles the CPlane off.
      if (facadeRef.current || layersActiveRef.current) {
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        return;
      }
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
      const shapes = shapesRef.current;

      // Flag rooms that break a global constraint (yellow). Only computed when at
      // least one rule is set; otherwise skipped. The map has one entry per flagged
      // room, so its size is the StatsBar's "Constraint Flags" count.
      let violations: Map<string, ShapeViolations> | undefined;
      const activeConstraints = constraintsRef.current;
      // Union the per-room rules broken anywhere on the canvas (e.g. one room too
      // small, another with too-thin a wall) so the Constraints box can highlight
      // each offending line. Global budgets are added below from their breach flags.
      const violatedKeySet = new Set<string>();
      if (hasAnyConstraint(activeConstraints)) {
        violations = new Map<string, ShapeViolations>();
        for (const s of shapes) {
          const v = findViolations(s, activeConstraints);
          if (v.any) {
            violations.set(s.id, v);
            for (const k of v.flaggedKeys) violatedKeySet.add(k);
          }
        }
      }

      // Surface live stats to React (deduped on the displayed integers) — placement,
      // delete, paste, edits, and undo/redo all flow through a scene redraw, so this
      // catches them all. Areas are always in ft² regardless of the display unit.
      let total = 0; // GIA — Σ interior
      let gross = 0; // GFA — Σ interior + walls
      let usable = 0; // UFA — Σ interior of usable rooms only
      for (const s of shapes) {
        const interior = shapeAreaInUnit(s, 'feet');
        total += interior;
        gross += shapeGrossAreaInUnit(s, 'feet');
        if (isUsableFloorArea(s.name)) usable += interior;
      }
      const roomCount = shapes.length;
      const constraintFlags = violations?.size ?? 0;
      const totalAreaSqft = Math.round(total);
      const grossAreaSqft = Math.round(gross);
      const usableAreaSqft = Math.round(usable);
      // Global Max Total / Max Total Gross Area: compare the live sums (not the
      // rounded readouts) to each budget. Flag-only — never clamps a drag; deleting
      // rooms clears them.
      const maxTotal = activeConstraints.maxTotalAreaSqft;
      const maxGross = activeConstraints.maxTotalGrossAreaSqft;
      const maxRooms = activeConstraints.maxRoomCount;
      const totalAreaExceeded = maxTotal != null && total > maxTotal + 1e-6;
      const grossAreaExceeded = maxGross != null && gross > maxGross + 1e-6;
      const roomCountExceeded = maxRooms != null && roomCount > maxRooms;
      // Fold the breached global budgets into the violated-key set, then emit a
      // stable, sorted list so the Constraints box highlights every broken rule.
      if (totalAreaExceeded) violatedKeySet.add('maxTotalAreaSqft');
      if (grossAreaExceeded) violatedKeySet.add('maxTotalGrossAreaSqft');
      if (roomCountExceeded) violatedKeySet.add('maxRoomCount');
      const violatedKeys = [...violatedKeySet].sort();
      const key = `${roomCount}|${constraintFlags}|${totalAreaSqft}|${grossAreaSqft}|${usableAreaSqft}|${totalAreaExceeded}|${grossAreaExceeded}|${roomCountExceeded}|${violatedKeys.join(',')}`;
      if (key !== lastStatsKeyRef.current) {
        lastStatsKeyRef.current = key;
        onStatsChange?.({
          roomCount,
          constraintFlags,
          totalAreaSqft,
          grossAreaSqft,
          usableAreaSqft,
          totalAreaExceeded,
          grossAreaExceeded,
          roomCountExceeded,
          violatedKeys,
        });
      }

      // Report selection-count changes (drives the Render button's enabled state).
      const selCount = selectionRef.current.size;
      if (selCount !== lastSelCountRef.current) {
        lastSelCountRef.current = selCount;
        onSelectionChange?.(selCount);
      }

      // Report the single-selected facade panel's live geometry + assembly (drives the left inspector
      // and the bidirectional size/band sync). Null unless Facade mode with exactly one panel selected.
      // Deduped on a serialized key, so it fires live during drags but not every idle frame.
      const selPanelShape =
        facadeRef.current && selCount === 1
          ? shapes.find((s) => selectionRef.current.has(s.id))
          : undefined;
      let selPanel: SelectedPanelInfo | null = null;
      if (selPanelShape) {
        selPanel = {
          id: selPanelShape.id,
          assembly: selPanelShape.name ?? DEFAULT_FACADE_ASSEMBLY,
          widthFt: selPanelShape.width / WORLD_UNITS_PER_FOOT,
          heightFt: selPanelShape.height / WORLD_UNITS_PER_FOOT,
          bandIn: worldToInches(selPanelShape.walls.n),
        };
      }
      const selPanelKey = selPanel
        ? `${selPanel.id}|${selPanel.assembly}|${selPanel.widthFt.toFixed(3)}|${selPanel.heightFt.toFixed(3)}|${selPanel.bandIn.toFixed(3)}`
        : '';
      if (selPanelKey !== lastSelPanelKeyRef.current) {
        lastSelPanelKeyRef.current = selPanelKey;
        onSelectedPanelChange?.(selPanel);
      }

      // Standardization view (Analyze popup): bucket the panels into types, keep a colour map for
      // the draw below, and report the type summary to React (deduped on signatures + counts).
      if (standardizeRef.current) {
        const { types, colorByShapeId } = computePanelTypes(shapes);
        panelColorsRef.current = colorByShapeId;
        const typesKey = types.map((t) => `${t.signature}:${t.count}`).join('|');
        if (typesKey !== lastPanelTypesKeyRef.current) {
          lastPanelTypesKeyRef.current = typesKey;
          onPanelTypesChange?.(types);
        }
      }

      const ctx = sceneCtxRef.current;
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);

      // Layers tool: draw the sticky-cell layer stack and HIDE the rooms entirely. Report the summary
      // (deduped) so the top-center layer navigator shows live layer/cell counts.
      if (layersActiveRef.current) {
        // Edit-a-panel highlight: the representative cell outline + the hovered side's frame strip.
        const fe = frameEditRef.current;
        const feFrame = fe ? groupFrame(partitionActiveLayer(partitionDocRef.current), fe.keys[0]) : null;
        // Live boolean preview: classify the cursor over two picked, overlapping borders so the union "+" grid
        // / subtract hatch follows it (only meaningful in Border mode with exactly two borders picked).
        let boolHover = null as ReturnType<typeof borderBooleanHoverAt> | null;
        if (
          borderModeRef.current &&
          partitionBorderSelRef.current.size === 2 &&
          hoverPointRef.current
        ) {
          const cam = cameraRef.current;
          const w = screenToWorld(hoverPointRef.current.x, hoverPointRef.current.y, cam);
          boolHover = borderBooleanHoverAt(
            partitionActiveLayer(partitionDocRef.current),
            partitionBorderSelRef.current,
            w,
            8 / cam.scale,
          );
        }
        drawPartition(ctx, partitionDocRef.current, cameraRef.current, {
          selectedSegment: partitionSelSegRef.current,
          selectedGroups: partitionGroupSelRef.current,
          idView: idViewRef.current,
          frameShadow: frameShadowRef.current,
          borderMode: borderModeRef.current,
          selectedBorders: partitionBorderSelRef.current,
          boolHover,
          unit: unitRef.current,
          showPanelNumbers: panelNumbersRef.current,
          frameEdit:
            fe && feFrame
              ? { rect: fe.rect, frame: feFrame, hoverSide: fe.hoverSide, all: fe.allSides }
              : null,
          splitPreview: splitPreviewRef.current,
        });
        // Line-snap alignment guides (green), reusing the wall-snap guide renderer.
        if (alignGuidesRef.current) {
          drawAlignmentGuides(ctx, alignGuidesRef.current, cameraRef.current, width, height);
        }
        // Shift-drag multi-select rectangle — shows the area whose panel groups the selection will hit.
        // (The Layers branch returns below, so this must be drawn here, not in the shared overlay pass.)
        const partitionMarquee = marqueeRef.current;
        if (partitionMarquee) {
          drawMarquee(ctx, partitionMarquee, MARQUEE_FILL, MARQUEE_STROKE);
        }
        // Border placement preview: a cursor-following ghost of the to-be-dropped trim quad, styled like the
        // committed border (blue edge + 4 white corner dots, no wall thickness).
        const borderPlace = placementRef.current;
        if (borderPlace && !borderPlace.clusterShapes) {
          const cam = cameraRef.current;
          const px = (borderPlace.worldSize ? borderPlace.worldSize * cam.scale : DEFAULT_SQUARE_SCREEN_SIZE);
          const cx = borderPlace.sx;
          const cy = borderPlace.sy;
          const left = cx - px / 2;
          const top = cy - px / 2;
          ctx.save();
          ctx.strokeStyle = '#2563eb';
          ctx.lineWidth = 2;
          ctx.strokeRect(left, top, px, px);
          for (const [dx, dy] of [
            [left, top],
            [left + px, top],
            [left + px, top + px],
            [left, top + px],
          ]) {
            ctx.beginPath();
            ctx.arc(dx, dy, 5, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = '#2563eb';
            ctx.stroke();
          }
          ctx.restore();
        }
        const summary = summarizeDoc(partitionDocRef.current, partitionBorderSelRef.current);
        const key = `${summary.layerCount}|${summary.activeIndex}|${summary.drawing}|${summary.cellCount}|${summary.borderSelCount}|${summary.borderSelCanBoolean}`;
        if (key !== lastPartitionKeyRef.current) {
          lastPartitionKeyRef.current = key;
          onPartitionChange?.(summary);
        }
        return;
      }

      // Building footprints first, so rooms and their dimensions render on top. The
      // live drag-draft (if any) is drawn alongside the committed ones.
      if (footprintsRef.current.length > 0) {
        drawFootprints(ctx, footprintsRef.current, cameraRef.current, unitRef.current);
      }
      if (footprintDraftRef.current) {
        drawFootprints(ctx, [footprintDraftRef.current], cameraRef.current, unitRef.current);
      }

      // Keep the selection-order list in sync with the live selection: drop
      // deselected ids, append newly selected ones (Set preserves pick order),
      // and clear entirely once nothing is selected (no lingering memory).
      const sel = selectionRef.current;
      const order = selectionOrderRef.current;
      for (let i = order.length - 1; i >= 0; i--) {
        if (!sel.has(order[i])) order.splice(i, 1);
      }
      for (const id of sel) if (!order.includes(id)) order.push(id);

      // Translucent ghost(s) of the to-be-dropped duplicate(s) while an edge-plus is
      // hovered (one ghost) or dragged (one per copy, sequential in that direction).
      let duplicatePreviews: Square[] | undefined;
      const ph = edgePlusHoverRef.current;
      if (ph) {
        const src = shapesRef.current.find((s) => s.id === ph.id);
        if (src) {
          const { dx, dy } = adjacentCopyOffset(src, ph.dir);
          duplicatePreviews = [];
          for (let i = 1; i <= ph.count; i++) {
            duplicatePreviews.push({ ...cloneShape(src), x: src.x + dx * i, y: src.y + dy * i });
          }
        }
      }

      // Placement preview: the default/room square being dragged onto the canvas is
      // shown with the SAME translucent ghost styling as the edge-plus duplicate
      // previews (walls + white infill + outline), so the two read identically.
      const pendingPlace = placementRef.current;
      if (pendingPlace && !pendingPlace.clusterShapes) {
        const cam = cameraRef.current;
        const cursor = screenToWorld(pendingPlace.sx, pendingPlace.sy, cam);
        const size = pendingPlace.worldSize ?? DEFAULT_SQUARE_SCREEN_SIZE / cam.scale;
        // An origin-centred ghost gives the snap helper the room's wall lines; the
        // cursor world is the "free" centre. resolveWallSnap returns the (possibly
        // snapped) centre, with green guides + breakout, against all existing rooms.
        const ghostBase: Square = {
          id: '__placement__',
          x: -size / 2,
          y: -size / 2,
          width: size,
          height: size,
          rotation: 0,
          walls: defaultWalls(),
          dots: false,
          name: pendingPlace.name ?? (facadeRef.current ? DEFAULT_FACADE_ASSEMBLY : 'Room'),
        };
        const snapped = resolveWallSnap(
          [ghostBase],
          shapesRef.current,
          cursor.x,
          cursor.y,
          cam.scale,
          placeSnapStateRef.current,
        );
        alignGuidesRef.current = snapped.guides.length > 0 ? snapped.guides : null;
        pendingPlace.snapCenter = { x: snapped.dx, y: snapped.dy };
        const ghost: Square = {
          ...ghostBase,
          x: snapped.dx - size / 2,
          y: snapped.dy - size / 2,
        };
        duplicatePreviews = duplicatePreviews ? [...duplicatePreviews, ghost] : [ghost];
      }

      // Constraint-fix preview: the proposed corrected room, drawn as the same
      // translucent ghost over the (still yellow-flagged) original for a before/after read.
      const fixGhost = fixPreviewRef.current?.ghost;
      if (fixGhost) {
        duplicatePreviews = duplicatePreviews ? [...duplicatePreviews, fixGhost] : [fixGhost];
      }

      // Ease the Library shrink animation; while shrinking, render a copy where the
      // selected shapes collapse toward their group centre (real shapes untouched).
      const ls = libraryShrinkRef.current;
      if (Math.abs(ls.scale - ls.target) > 0.001) {
        ls.scale += (ls.target - ls.scale) * 0.25;
        if (Math.abs(ls.scale - ls.target) <= 0.001) ls.scale = ls.target;
        requestDraw('scene'); // keep the animation going until it settles
      }
      let renderShapes = shapesRef.current;
      if (ls.scale < 0.999 && selectionRef.current.size > 0) {
        // Collapse toward the mouse pointer (tracked during the drag), so the shapes
        // appear to be pulled into the cursor as it hovers the Library button.
        const pivot = ls.pivot;
        renderShapes = shapesRef.current.map((s) =>
          selectionRef.current.has(s.id) ? shrinkShapeToward(s, pivot, ls.scale) : s,
        );
      }

      drawShapes({
        ctx,
        shapes: renderShapes,
        camera: cameraRef.current,
        selectedIds: selectionRef.current,
        selectionOrder: selectionOrderRef.current,
        hoverPoint: hoverPointRef.current,
        centerHoverId: centerHoverRef.current,
        activeHandle: activeEdgeRef.current,
        activeEdgeFace: edgeHoverRef.current,
        activeEdgeFaceAll: edgeFaceAllRef.current,
        wallDimsArmed: wallDimsArmedRef.current,
        hoverId: hoverRef.current?.id ?? null,
        hoverRegion: hoverRef.current?.region ?? null,
        resizing: resizingRef.current,
        rotating: rotatingRef.current,
        unit: unitRef.current,
        width,
        height,
        theme: SHAPE_THEME,
        // Hidden when the Constraints "Visibility" eye is off — the violations are still
        // computed above (for the count/superscript), just not drawn yellow on the canvas.
        violations: showViolationsRef.current ? violations : undefined,
        debug: debugRef.current,
        ghosted: debugRef.current || analyzeRef.current,
        facade: facadeRef.current,
        duplicatePreviews,
        predictionDrag: predictionDragRef.current?.dragging ? predictionDragRef.current : undefined,
        highlightIds: highlightRef.current.roomIds,
        highlightWalls: highlightRef.current.wallMap,
        panelColors: standardizeRef.current ? panelColorsRef.current ?? undefined : undefined,
      });
      // A saved Library cluster still uses its own multi-shape preview; the single
      // square's ghost is drawn above via `duplicatePreviews`.
      const pending = placementRef.current;
      if (pending?.clusterShapes) {
        drawClusterPreview(
          ctx,
          pending.clusterShapes,
          pending.sx,
          pending.sy,
          cameraRef.current,
          SHAPE_THEME,
        );
      }
      const marquee = marqueeRef.current;
      if (marquee) {
        drawMarquee(ctx, marquee, MARQUEE_FILL, MARQUEE_STROKE);
      }

      // Wall-alignment guides (green) — shown while a move drag is snapped to an axis.
      if (alignGuidesRef.current) {
        drawAlignmentGuides(ctx, alignGuidesRef.current, cameraRef.current, width, height);
      }
    }, [
      width,
      height,
      cameraRef,
      onStatsChange,
      onSelectionChange,
      onSelectedPanelChange,
      onPanelTypesChange,
      onPartitionChange,
      requestDraw,
    ]);

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
        if (frameRef.current) {
          cancelAnimationFrame(frameRef.current);
          // Reset the guard too: otherwise a cancelled frame leaves frameRef set,
          // and every later requestDraw bails at `if (frameRef.current) return`,
          // freezing the scene. (Surfaces under StrictMode's mount→cleanup→remount.)
          frameRef.current = 0;
        }
      };
    }, []);

    // ---- Constraint-fix helpers (camera focus + session stepping) ----------

    // Ease the camera {x, y, scale} to a target over ~250ms (easeInOutQuad),
    // cancelling any in-flight tween. Both focusing a room and restoring the view use it.
    const tweenCameraTo = useCallback(
      (target: { x: number; y: number; scale: number }) => {
        if (cameraTweenRef.current) cancelAnimationFrame(cameraTweenRef.current);
        const cam = cameraRef.current;
        const from = { x: cam.x, y: cam.y, scale: cam.scale };
        const t0 = performance.now();
        const DUR = 250;
        const tick = () => {
          const raw = Math.min(1, (performance.now() - t0) / DUR);
          const e = raw < 0.5 ? 2 * raw * raw : 1 - (-2 * raw + 2) ** 2 / 2;
          cam.x = from.x + (target.x - from.x) * e;
          cam.y = from.y + (target.y - from.y) * e;
          cam.scale = from.scale + (target.scale - from.scale) * e;
          requestDraw('all');
          cameraTweenRef.current = raw < 1 ? requestAnimationFrame(tick) : 0;
        };
        cameraTweenRef.current = requestAnimationFrame(tick);
      },
      [cameraRef, requestDraw],
    );

    // Centre + zoom the camera so `shape` (its interior AABB, world space) fits the
    // viewport with `padPx` margin, capped so a tiny room doesn't zoom absurdly.
    const focusShape = useCallback(
      (shape: Square, padPx = 140) => {
        const rect = rectRef.current;
        if (!rect) return;
        const bb = boundingBoxLocal(shape); // centre-origin local frame
        const cx = shape.x + shape.width / 2;
        const cy = shape.y + shape.height / 2;
        const rad = (shape.rotation * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const [lx, ly] of [
          [bb.minX, bb.minY],
          [bb.maxX, bb.minY],
          [bb.maxX, bb.maxY],
          [bb.minX, bb.maxY],
        ]) {
          const wx = cx + lx * cos - ly * sin;
          const wy = cy + lx * sin + ly * cos;
          minX = Math.min(minX, wx);
          minY = Math.min(minY, wy);
          maxX = Math.max(maxX, wx);
          maxY = Math.max(maxY, wy);
        }
        const aabbW = Math.max(maxX - minX, 1);
        const aabbH = Math.max(maxY - minY, 1);
        const scale = Math.min(
          (rect.width - 2 * padPx) / aabbW,
          (rect.height - 2 * padPx) / aabbH,
          4, // never zoom past 4 CSS px / world unit
        );
        const ccx = (minX + maxX) / 2;
        const ccy = (minY + maxY) / 2;
        tweenCameraTo({ x: rect.width / 2 - ccx * scale, y: rect.height / 2 - ccy * scale, scale });
      },
      [tweenCameraTo],
    );

    // Centre + zoom the camera so an axis-aligned WORLD rect fits the viewport with `padPx` margin, reusing the
    // same easing. Used to fly to a facade panel for the Edit-a-panel session. Facade panels are small (a few
    // feet), so the fit zooms all the way to MAX_SCALE — a 4px-per-unit cap (as used for rooms) would leave a
    // panel tiny and read as "barely zoomed". Clamped to MAX_SCALE so a later wheel-zoom doesn't snap.
    const focusRect = useCallback(
      (r: Rect, padPx = 100) => {
        const rect = rectRef.current;
        if (!rect) return;
        const aabbW = Math.max(r.w, 1);
        const aabbH = Math.max(r.h, 1);
        const scale = Math.min(
          (rect.width - 2 * padPx) / aabbW,
          (rect.height - 2 * padPx) / aabbH,
          MAX_SCALE,
        );
        const ccx = r.x + r.w / 2;
        const ccy = r.y + r.h / 2;
        tweenCameraTo({ x: rect.width / 2 - ccx * scale, y: rect.height / 2 - ccy * scale, scale });
      },
      [tweenCameraTo],
    );

    // Pick the next non-skipped violation, focus its room, preview its proposed fix,
    // and return the step descriptor (or a done-summary when none remain).
    const advanceFix = useCallback((): FixResult => {
      const session = fixSessionRef.current;
      if (!session) return { done: true, fixedCount: 0, unresolved: 0, globalNotes: [] };
      const c = constraintsRef.current;
      const next = enumerateViolations(shapesRef.current, c).find(
        (v) => !session.skipped.has(violationKey(v)),
      );
      if (!next) {
        // Nothing left to review — clear the ghost and report the summary. "unresolved"
        // is the genuine remaining violation count (skipped fixable + any still-broken).
        session.current = null;
        fixPreviewRef.current = null;
        requestDraw('scene');
        return {
          done: true,
          fixedCount: session.fixedCount,
          unresolved: enumerateViolations(shapesRef.current, c).length,
          globalNotes: globalNotes(shapesRef.current, c),
        };
      }
      const shape = shapesRef.current.find((s) => s.id === next.shapeId)!;
      const proposal = proposeFix(shape, next, c);
      session.current = { violation: next, proposal };
      fixPreviewRef.current = proposal.fixed
        ? { shapeId: next.shapeId, ghost: proposal.fixed }
        : null;
      // Select the room under review (infill, no active edge) so its L/W dimensions
      // appear — as if the user had clicked it — alongside the ghosted proposal.
      selectionRef.current = new Set([next.shapeId]);
      selectionOrderRef.current = [next.shapeId];
      activeEdgeRef.current = null;
      focusShape(shape);
      requestDraw('scene');
      const remaining = enumerateViolations(shapesRef.current, c).filter(
        (v) => !session.skipped.has(violationKey(v)),
      ).length;
      return {
        done: false,
        shapeId: next.shapeId,
        title: next.title,
        detail: next.detail,
        canAutoFix: proposal.fixed != null && proposal.resolves,
        worsensOthers: proposal.worsensOthers,
        fixedCount: session.fixedCount,
        remaining,
      };
    }, [constraintsRef, focusShape, requestDraw]);

    // Replace a shape in place with its corrected geometry (same id).
    const applyFixedShape = useCallback((fixed: Square) => {
      const arr = shapesRef.current;
      const idx = arr.findIndex((s) => s.id === fixed.id);
      if (idx >= 0) arr[idx] = fixed;
    }, []);

    // ---- Placement API (driven by the Space button) ------------------------
    useImperativeHandle(
      ref,
      (): CanvasHandle => ({
        startPlacement(clientX, clientY) {
          const rect = rectRef.current;
          if (!rect) return;
          placementRef.current = { sx: clientX - rect.left, sy: clientY - rect.top };
          placeSnapStateRef.current = emptySnapState(); // fresh snap session
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
            alignGuidesRef.current = null;
            placeSnapStateRef.current = emptySnapState();
            requestDraw('scene');
          }
        },
        createRoomsFromList(rooms) {
          const valid = rooms.filter((r) => r.widthFt > 0 && r.heightFt > 0).slice(0, 50);
          if (valid.length === 0) return;
          const wall = DEFAULT_WALL_WORLD;
          // Each room's outer extent (interior + both side walls) along the row, so
          // adjacent rooms' outer walls touch with no overlap.
          const outerW = valid.map((r) => r.widthFt * WORLD_UNITS_PER_FOOT + 2 * wall);
          const totalW = outerW.reduce((a, b) => a + b, 0);

          // Centre the whole row on the current view's centre in world space.
          const rect = rectRef.current;
          const cam = cameraRef.current;
          const centre = rect
            ? screenToWorld(rect.width / 2, rect.height / 2, cam)
            : screenToWorld(width / 2, height / 2, cam);

          let cursor = centre.x - totalW / 2; // left edge of the current room's outer box
          const ids: string[] = [];
          for (let i = 0; i < valid.length; i++) {
            const r = valid[i];
            const wWorld = r.widthFt * WORLD_UNITS_PER_FOOT;
            const hWorld = r.heightFt * WORLD_UNITS_PER_FOOT;
            const square: Square = {
              id: createId(),
              x: cursor + wall, // interior sits inside its wall band
              y: centre.y - hWorld / 2, // vertically centred on the row
              width: wWorld,
              height: hWorld,
              rotation: 0,
              walls: defaultWalls(),
              dots: false,
              name: r.name,
            };
            shapesRef.current.push(square);
            ids.push(square.id);
            cursor += outerW[i];
          }
          selectionRef.current = new Set(ids);
          activeEdgeRef.current = null;
          commitHistory();
          requestDraw('scene');
        },
        startClusterPlacement(shapes, clientX, clientY) {
          const rect = rectRef.current;
          if (!rect || shapes.length === 0) return;
          placementRef.current = {
            sx: clientX - rect.left,
            sy: clientY - rect.top,
            clusterShapes: shapes,
          };
          requestDraw('scene');
        },
        armFootprintDraw() {
          // Cancel any armed room placement so the two tools never fight.
          placementRef.current = null;
          footprintArmRef.current = true;
          requestDraw('scene');
        },
        runFind(query) {
          const r = findMatches(query, shapesRef.current);
          highlightRef.current = { roomIds: r.roomIds, wallMap: r.wallMap };
          requestDraw('scene');
          return r.count;
        },
        clearFind() {
          if (highlightRef.current.roomIds.size === 0 && highlightRef.current.wallMap.size === 0) {
            return;
          }
          highlightRef.current = { roomIds: new Set(), wallMap: new Map() };
          requestDraw('scene');
        },
        captureSelectionShapes() {
          const selected = shapesRef.current.filter((s) => selectionRef.current.has(s.id));
          if (selected.length === 0) return null;
          // Hand the shapes back; the multi-pass renderer builds the per-material references + prompts.
          return { shapes: selected.map(cloneShape), count: selected.length };
        },
        selectShapeIds(ids) {
          const present = new Set(shapesRef.current.map((s) => s.id));
          selectionRef.current = new Set(ids.filter((id) => present.has(id)));
          activeEdgeRef.current = null;
          requestDraw('scene');
        },
        setSelectionAssembly(key) {
          const id = [...selectionRef.current][0];
          const shape = shapesRef.current.find((s) => s.id === id);
          if (!shape) return;
          const def = facadeType(key);
          shape.name = key;
          // Switching type changes only the band (mullion/joint) thickness; size is kept.
          const bandWorld = inchesToWorld(bandInchesFor(def.defaultMeta, key));
          shape.walls = { n: bandWorld, e: bandWorld, s: bandWorld, w: bandWorld };
          commitHistory();
          requestDraw('scene');
        },
        setShapeSize(id, widthFt, heightFt) {
          const shape = shapesRef.current.find((s) => s.id === id);
          if (!shape) return;
          const w = Math.max(feetToWorld(0.5), feetToWorld(widthFt));
          const h = Math.max(feetToWorld(0.5), feetToWorld(heightFt));
          const cx = shape.x + shape.width / 2;
          const cy = shape.y + shape.height / 2;
          shape.width = w;
          shape.height = h;
          shape.x = cx - w / 2;
          shape.y = cy - h / 2;
          commitHistory();
          requestDraw('scene');
        },
        applyAssemblyBand(key, inches) {
          // No commitHistory: this is the continuous type-level band sync (fires per-frame during a
          // wall drag). The originating gesture commits its own undo step on release.
          const bandWorld = Math.max(inchesToWorld(0.25), inchesToWorld(inches));
          let changed = false;
          for (const s of shapesRef.current) {
            if ((s.name ?? '') === key && s.walls.n !== bandWorld) {
              s.walls = { n: bandWorld, e: bandWorld, s: bandWorld, w: bandWorld };
              changed = true;
            }
          }
          if (changed) requestDraw('scene');
        },
        addLayer() {
          addPartitionLayer(partitionDocRef.current);
          partitionBorderSelRef.current = new Set(); // border indices are per-layer — drop any pick
          commitHistory(); // creating a layer is one undo step
          requestDraw('scene');
        },
        selectLayer(index) {
          selectPartitionLayer(partitionDocRef.current, index);
          partitionBorderSelRef.current = new Set(); // border indices are per-layer — drop any pick
          requestDraw('scene'); // navigation only — not an undo step
        },
        splitCell(ref, cols, rows) {
          splitPartitionCell(partitionActiveLayer(partitionDocRef.current), ref, cols, rows);
          partitionGroupSelRef.current = new Set(); // start the new grid with no panel selected
          commitHistory(); // splitting a cell is one undo step
          requestDraw('scene');
        },
        partitionPanelStats() {
          return partitionPanelStatsOf(partitionActiveLayer(partitionDocRef.current));
        },
        optimizePartition(strategy) {
          const layer = partitionActiveLayer(partitionDocRef.current);
          if (!partitionHasBoundary(layer)) return;
          // Each strategy rationalizes the active layer in place; the remaining algorithms are implemented
          // one at a time (see OptimizeStrategy). A strategy reports whether it actually changed anything.
          let changed = false;
          switch (strategy) {
            case 'edge-normalize':
              changed = optimizeEdgeNormalize(layer);
              break;
            case 'edge-profile':
              changed = optimizeEdgeProfile(layer);
              break;
            case 'modular-cluster':
              changed = optimizeModularCluster(layer);
              break;
            case 'stepped-edge':
              changed = optimizeSteppedEdge(layer);
              break;
          }
          if (!changed) return; // nothing moved → no undo step, no repaint
          partitionGroupSelRef.current = new Set(); // selection keys may be stale after reshaping the border
          commitHistory(); // a rationalization pass is one undo step
          requestDraw('scene');
        },
        startPanelFrameEdit(clickRect?: Rect | null) {
          const layer = partitionActiveLayer(partitionDocRef.current);
          const keys = [...partitionGroupSelRef.current];
          if (!partitionHasBoundary(layer) || keys.length === 0) return null;
          // Zoom to the panel the user actually right-clicked (when it belongs to the edited group); the frame
          // still mirrors to the whole group. Fall back to the group's first cell if there's no clicked rect.
          let rect: Rect | null = null;
          if (clickRect) {
            const k = cellGroupAt(layer, {
              x: clickRect.x + clickRect.w / 2,
              y: clickRect.y + clickRect.h / 2,
            });
            if (k && keys.includes(k)) rect = clickRect;
          }
          if (!rect) rect = representativeCell(layer, keys[0]);
          if (!rect) return null;
          const cam = cameraRef.current;
          frameEditRef.current = {
            keys,
            rect,
            priorCamera: { x: cam.x, y: cam.y, scale: cam.scale },
            hoverSide: null,
            allSides: false,
          };
          // Auto-generate a uniform frame on the group (default 2″ mullion width).
          const seeded = seedGroupFrames(layer, keys, inchesToWorld(DEFAULT_PANEL_FRAME_IN));
          focusRect(rect);
          if (seeded) commitHistory(); // seeding the frame is one undo step
          requestDraw('scene');
          return { keys };
        },
        endPanelFrameEdit() {
          const session = frameEditRef.current;
          if (session) tweenCameraTo(session.priorCamera);
          frameEditRef.current = null;
          requestDraw('scene');
        },
        assignPanelKind(kind: PanelKind | null) {
          const layer = partitionActiveLayer(partitionDocRef.current);
          const keys = [...partitionGroupSelRef.current];
          if (!partitionHasBoundary(layer) || keys.length === 0) return;
          setGroupPanelKind(layer, keys, kind);
          commitHistory();
          requestDraw('scene');
        },
        fixStart() {
          const cam = cameraRef.current;
          fixSessionRef.current = {
            skipped: new Set(),
            priorCamera: { x: cam.x, y: cam.y, scale: cam.scale },
            fixedCount: 0,
            skippedCount: 0,
            current: null,
          };
          return advanceFix();
        },
        fixApprove() {
          const session = fixSessionRef.current;
          const cur = session?.current;
          if (!session || !cur) return advanceFix();
          if (cur.proposal.fixed && cur.proposal.resolves) {
            applyFixedShape(cur.proposal.fixed);
            session.fixedCount += 1;
            commitHistory();
            requestDraw('scene');
          } else {
            // Not auto-fixable — treat Approve as leaving it (shouldn't happen; UI gates it).
            session.skipped.add(violationKey(cur.violation));
            session.skippedCount += 1;
          }
          return advanceFix();
        },
        fixSkip() {
          const session = fixSessionRef.current;
          const cur = session?.current;
          if (!session || !cur) return advanceFix();
          session.skipped.add(violationKey(cur.violation));
          session.skippedCount += 1;
          return advanceFix();
        },
        fixCancel() {
          const session = fixSessionRef.current;
          fixPreviewRef.current = null;
          if (session) tweenCameraTo(session.priorCamera);
          fixSessionRef.current = null;
          requestDraw('scene');
        },
      }),
      [
        requestDraw,
        commitPlacement,
        commitHistory,
        cameraRef,
        width,
        height,
        advanceFix,
        applyFixedShape,
        tweenCameraTo,
        constraintsRef,
      ],
    );

    // Suppress the browser's right-click menu (the "Save image as…/Copy image"
    // menu, since the scene canvas is an image role) so right-click is ours.
    const suppressContextMenu = (e: ReactMouseEvent) => e.preventDefault();

    return (
      <>
        <canvas
          ref={gridCanvasRef}
          className={`${styles.canvas} ${styles.grid}`}
          style={{ width, height }}
          aria-hidden="true"
          onContextMenu={suppressContextMenu}
        />
        <canvas
          ref={sceneCanvasRef}
          className={`${styles.canvas} ${styles.scene}`}
          style={{ width, height }}
          aria-label="Infinite drawing canvas"
          role="img"
          onContextMenu={suppressContextMenu}
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
              width: editor.which === 'name' ? 130 : undefined,
            }}
            value={editor.value}
            inputMode={editor.which === 'name' ? 'text' : 'decimal'}
            aria-label={
              editor.which === 'name'
                ? 'Room name'
                : editor.which === 'area'
                  ? 'Square footage'
                  : editor.which === 'wallThickness'
                    ? 'Wall thickness'
                    : editor.which === 'wallLength'
                      ? 'Wall length'
                      : `${editor.which} in feet`
            }
            onChange={(e) =>
              setEditor((ed) => (ed ? { ...ed, value: e.target.value } : ed))
            }
            onKeyDown={(e) => {
              // Enter always commits; Space commits a number (never needed in
              // one) but is a literal character in a room name.
              if (e.key === 'Enter' || (e.key === ' ' && editor.which !== 'name')) {
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
