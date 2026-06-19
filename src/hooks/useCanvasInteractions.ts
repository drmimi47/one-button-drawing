import { useEffect, type MutableRefObject, type RefObject } from 'react';
import type {
  Camera,
  DrawLayer,
  Footprint,
  LengthUnit,
  Marquee,
  PendingPlacement,
  Square,
} from '../types';
import { footprintAsShape } from '../canvas/footprint';
import {
  resolveWallSnap,
  emptySnapState,
  SNAP_ENGAGE_WIDE_PX,
  type SnapState,
  type AlignGuide,
} from '../canvas/snapping';
import type { Constraints } from '../../backend/types';
import { clampDragToConstraints } from '../../backend/clamp';
import { screenToWorld } from '../canvas/coords';
import {
  resizeShape,
  resizeWall,
  resizeAllWalls,
  differenceWallEdges,
  moveVertex,
  stretchEdge,
  recenterCorners,
  cornerIndexForHandle,
  cursorForHandle,
  edgeFace,
  hitCorner,
  hitCornerHandle,
  hitCornerDot,
  hitDimensionLabel,
  hitWallDimensionLabel,
  hitCenterLabel,
  hitCenterLock,
  hitEdgePlus,
  hitPredictionOption,
  adjacentCopyOffset,
  adjacentRoomPlacement,
  defaultWalls,
  scaledToArea,
  areaLockAnchorWorld,
  hitShapeEdge,
  hitTopShape,
  pointInSelectedOverlapBand,
  overlapBandAt,
  overlapInteriorAt,
  differenceCorners,
  unionCorners,
  unionWallEdges,
  type DimensionLabelHit,
  type WallDimensionLabelHit,
  type CenterLabelHit,
  type EdgeFace,
  type HandleId,
  type HoverRegion,
} from '../canvas/shapes';
import {
  MIN_SHAPE_SCREEN_SIZE,
  MIN_WALL_WORLD,
  ROTATE_CURSOR,
  ROTATION_SNAP_DEG,
  WORLD_UNITS_PER_FOOT,
  DEFAULT_WALL_WORLD,
  BORDER_DIM_GAP,
} from '../constants';
import { findRoomDef } from '../rooms/roomCatalog';
import { predictRoomOptions, type PredictionOption } from '../rooms/roomAdjacency';
import {
  activeLayer as partitionActiveLayer,
  hasBoundary as partitionHasBoundary,
  hitCell as hitPartitionCell,
  polyBBox as partitionPolyBBox,
  cellRefRect as partitionCellRefRect,
  hitBoundaryEdge as hitPartitionBoundaryEdge,
  hitBorderCorner as hitPartitionCorner,
  moveBorderCorner as movePartitionCorner,
  borderIndexAt as partitionBorderIndexAt,
  borderBooleanHoverAt,
  uniteBorders as unitePartitionBorders,
  differenceBorders as differencePartitionBorders,
  moveBorder as movePartitionBorder,
  hitAnyLine as hitPartitionLine,
  moveLine as movePartitionLine,
  duplicateLine as duplicatePartitionLine,
  lineCandidates as partitionLineCandidates,
  hitGridSegment as hitPartitionGridSegment,
  isSplitSegment as partitionIsSplitSegment,
  panelBorderEdges as partitionPanelBorderEdges,
  moveGridSegment as movePartitionGridSegment,
  duplicateSegment as duplicatePartitionSegment,
  moveSegmentExtra as movePartitionSegmentExtra,
  moveLatticePreservingFrames as partitionPreserveFrames,
  cellGroupAt as partitionCellGroupAt,
  pointInBorder as partitionPointInBorder,
  groupKeysInRect as partitionGroupKeysInRect,
  groupFrame as partitionGroupFrame,
  frameInnerRect as partitionFrameInnerRect,
  setGroupFrame as partitionSetGroupFrame,
  type BorderBooleanHover,
  type BoundaryEdge,
  type CellRef,
  type ExtraSegHandle,
  type FacadeDoc,
  type LineHandle,
  type Rect,
  type SegmentRef,
} from '../facade/partition';

/** Screen cursor for a boundary edge (n/s = vertical resize, e/w = horizontal). */
function cursorForBoundaryEdge(edge: BoundaryEdge): string {
  return edge === 'n' || edge === 's' ? 'ns-resize' : 'ew-resize';
}

/**
 * Resize cursor for the diagonal border-cut frame edge, where the drag axis is the edge's perpendicular
 * (its inward normal). To look identical to the vertical/horizontal frame-line cursors we reuse the SAME
 * native glyphs: a more-horizontal drag (normal closer to horizontal) is `col-resize`, like sliding a
 * vertical line; a more-vertical drag is `row-resize`, like sliding a horizontal one.
 */
function cursorForNormal(nx: number, ny: number): string {
  return Math.abs(nx) >= Math.abs(ny) ? 'col-resize' : 'row-resize';
}

/**
 * Wrap a facade border quad's corners as a zero-wall `Square` so it can feed the room snapper / edge-stretch
 * (which both operate on `Square`). With zero walls inner == outer == centre, so the snapper's equal-thickness
 * centreline match fires — i.e. border edge snaps to border edge.
 */
function borderToSquare(corners: { x: number; y: number }[]): Square {
  return {
    id: 'facade-border',
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    rotation: 0,
    walls: { n: 0, e: 0, s: 0, w: 0 },
    dots: false,
    corners: corners.map((p) => ({ x: p.x, y: p.y })),
  };
}

/**
 * Snap a dragged line coordinate to the nearest parallel grid line within the (screen-px) engage zone —
 * reusing the same alignment threshold as the wall snapper, so lines align with each other when close.
 * Returns the snapped world coordinate and the guide position (or null when free).
 */
function snapLineCoord(
  target: number,
  candidates: number[],
  scale: number,
): { value: number; guide: number | null } {
  let best: number | null = null;
  let bestDist = SNAP_ENGAGE_WIDE_PX;
  for (const c of candidates) {
    const d = Math.abs(target - c) * scale;
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best != null ? { value: best, guide: best } : { value: target, guide: null };
}

interface InteractionParams {
  canvasRef: RefObject<HTMLCanvasElement>;
  cameraRef: MutableRefObject<Camera>;
  shapesRef: MutableRefObject<Square[]>;
  selectionRef: MutableRefObject<Set<string>>;
  /**
   * Active region of the selection: a handle id when a single wall edge is the
   * stretch target, or null when the white infill is selected (move target).
   */
  activeEdgeRef: MutableRefObject<HandleId | null>;
  /** Nearer face of the active edge under the pointer (glows magenta), or null. */
  edgeHoverRef: MutableRefObject<EdgeFace | null>;
  /** Shift held over the active edge face: light ALL inner/outer faces so a drag
   * stretches the whole boundary at once. */
  edgeFaceAllRef: MutableRefObject<boolean>;
  /** True once the active edge was armed by a clean click (no drag) — gates the
   * per-edge wall length/thickness dimensions. */
  wallDimsArmedRef: MutableRefObject<boolean>;
  /** Shape + region under the pointer, for the hover-preview darkening. */
  hoverRef: MutableRefObject<{ id: string; region: HoverRegion } | null>;
  /** Cursor in canvas-local screen px (null off-canvas / mid-drag), for the
   * shared-overlap-edge yellow hover when both rooms are selected. */
  hoverPointRef: MutableRefObject<{ x: number; y: number } | null>;
  /** Shape id whose centre name/area readout is hovered (draws the edit box). */
  centerHoverRef: MutableRefObject<string | null>;
  /** Edge-plus button under the pointer / being dragged ({shape id, dir 0=n/1=e/
   * 2=s/3=w, copy count}), or null — drives the translucent duplicate preview(s). */
  edgePlusHoverRef: MutableRefObject<{ id: string; dir: number; count: number } | null>;
  /** True while an edge stretch is dragging (keeps dimensions live). */
  resizingRef: MutableRefObject<boolean>;
  /** While rotating: the shape + grabbed corner, driving the live angle readout. */
  rotatingRef: MutableRefObject<{ id: string; corner: HandleId } | null>;
  /** Active measurement unit; dimension labels are read/edited in this unit. */
  unitRef: MutableRefObject<LengthUnit>;
  /** Active rubber-band rectangle, or null. */
  marqueeRef: MutableRefObject<Marquee | null>;
  /** Armed placement preview, or null. When set, pointer input places a square. */
  placementRef: MutableRefObject<PendingPlacement | null>;
  /** All committed building footprints (white slab behind every room). */
  footprintsRef: MutableRefObject<Footprint[]>;
  /** True while the footprint tool is armed (next canvas drag draws one). */
  footprintArmRef: MutableRefObject<boolean>;
  /** The footprint being drag-drawn (live preview), or null. */
  footprintDraftRef: MutableRefObject<Footprint | null>;
  /**
   * Shrink-into-Library animation state (render-only): `target` is set by this hook
   * as a selection drag enters/leaves the Library button; InfiniteCanvas eases
   * `scale` toward it and renders the selected shapes collapsing into the button.
   */
  libraryShrinkRef: MutableRefObject<{
    scale: number;
    target: number;
    /** World point the shapes collapse toward (the live mouse pointer). */
    pivot: { x: number; y: number };
  }>;
  /** Active next-room prediction fan (opened shape + dragged edge arrow), or null. */
  predictionDragRef: MutableRefObject<{
    shapeId: string;
    dir: number;
    hovered: number | null;
    dragging: boolean;
    /** Length-3, POSITION order (index 1 = middle = most confident). */
    options: (PredictionOption | null)[];
  } | null>;
  /** Commit the armed placement at a canvas-local screen point. */
  commitPlacement: (sx: number, sy: number) => void;
  /** Open the inline editor for a clicked dimension label. */
  beginDimensionEdit: (shapeId: string, hit: DimensionLabelHit) => void;
  /** Open the inline editor for a clicked centre readout (room name or area). */
  beginCenterEdit: (shapeId: string, hit: CenterLabelHit) => void;
  /** Open the inline editor for a clicked wall (edge) length/thickness label. */
  beginWallDimensionEdit: (shapeId: string, hit: WallDimensionLabelHit) => void;
  /** Snapshot the shapes into undo history after a completed mutation. */
  commitHistory: () => void;
  requestDraw: (layer?: DrawLayer) => void;
  /** Active constraints: a hard lock that clamps edits so they never violate. */
  constraintsRef: MutableRefObject<Constraints>;
  /** Client rect of the Library button (or null) — a move-drop here saves instead. */
  libraryDropRef?: MutableRefObject<DOMRect | null>;
  /** Client rect of the open Library popup (or null) — also a save drop-target. */
  libraryPopupDropRef?: MutableRefObject<DOMRect | null>;
  /** Fires true/false as a move drag enters/leaves the Library button. */
  onLibraryHover?: (over: boolean) => void;
  /** Fires with the dragged shapes when dropped onto the Library button. */
  onLibraryDrop?: (shapes: Square[]) => void;
  /**
   * Fires with the hovered room's catalog key (or `null` off any room) as the pointer
   * moves between rooms — drives the dev Adjacency Matrix's row/column highlight.
   */
  onHoverRoomKey?: (key: string | null) => void;
  /**
   * Dismisses any active smart-find highlight. Called when a room is actually edited
   * (stretch, vertex move, wall stretch, rotate) — navigation and moves don't call it.
   */
  clearFindHighlight?: () => void;
  /** Holds the active wall-alignment guide lines during a move drag (drawn green). */
  alignGuidesRef: MutableRefObject<AlignGuide[] | null>;
  /**
   * Facade mode flag. When set, a wall-thickness drag moves ALL four faces together (the mullion/joint
   * band is uniform per panel), so the inspector's single band value always stays in sync.
   */
  facadeRef?: MutableRefObject<boolean | undefined>;
  /**
   * Facade Layers tool (uniform sticky-cell partition). When `layersActiveRef` is true the pointer edits
   * the partition document instead of rooms: drag a rectangle to draw the active layer's boundary, stretch
   * boundary edges / cell cuts, right-click a cell to split it; empty space pans. Rooms are bypassed.
   */
  layersActiveRef?: MutableRefObject<boolean | undefined>;
  /**
   * Border vs Panels sub-mode of the Layers tool. In BORDER mode the trim boundary is editable — drag to
   * draw it, move corners, stretch edges. In PANELS mode the border is LOCKED (no draw/corner/edge) and the
   * pointer edits the inner grid (lines, segments, cell splits, panel-group select). Defaults to Border.
   */
  borderModeRef?: MutableRefObject<boolean | undefined>;
  /**
   * Frame sub-mode of the Layers tool. When true the offset mullion frame is shown and editing is LOCKED —
   * border, panel grid, and cell-split are all disabled, the pointer only pans. Mutually exclusive with the
   * Border/Panels sub-modes.
   */
  /**
   * Edit-a-panel session. When set, the pointer edits the per-edge frame of the selected group(s): hovering a
   * representative-panel edge highlights it, dragging it sets that side's frame width (mirrored to every key),
   * and `hoverSide` is written back for the renderer. Null when no session is active.
   */
  frameEditRef?: MutableRefObject<{
    keys: string[];
    rect: Rect;
    priorCamera: { x: number; y: number; scale: number };
    hoverSide: 'n' | 'e' | 's' | 'w' | 'b' | null;
    allSides: boolean;
  } | null>;
  partitionDocRef?: MutableRefObject<FacadeDoc>;
  /** The shift-selected inner line segment (highlighted, jog-draggable), or null. */
  partitionSelSegRef?: MutableRefObject<SegmentRef | null>;
  /** Selected panel GROUP keys (clicking a panel selects its whole material group). */
  partitionGroupSelRef?: MutableRefObject<Set<string>>;
  /** Border indices picked (shift-click, Border mode) for a boolean unite/difference op, in selection order. */
  partitionBorderSelRef?: MutableRefObject<Set<number>>;
  /** Right-click a cell → open the split + Edit/Assign menu at that screen point for that cell. */
  onCellContextMenu?: (info: { screenX: number; screenY: number; ref: CellRef; rect: Rect | null }) => void;
  /** Exit the active Edit-a-panel session (a clean click outside the border / on another group acts as Done). */
  onExitFrameEdit?: () => void;
}

type Mode =
  | 'none'
  | 'pan'
  | 'move'
  | 'resize'
  | 'thickness'
  | 'rotate'
  | 'marquee'
  | 'vertex'
  | 'plusdrag'
  | 'predictdrag'
  | 'footdraw'
  | 'boundaryEdge'
  | 'cornerDrag'
  | 'borderMove'
  | 'lineDrag'
  | 'segmentDrag'
  | 'segExtraDrag'
  | 'partitionFrame'
  | 'partitionMarquee';

/** Most copies a single edge-plus drag can spawn (matches the prompt cap). */
const MAX_PLUS_COPIES = 50;

/** A footprint drag shorter than this (world units, ~1 ft) is treated as a cancel. */
const MIN_FOOTPRINT_WORLD = WORLD_UNITS_PER_FOOT;

/** Target scale the dragged selection shrinks to while it hovers the Library button. */
const LIBRARY_SHRINK_MIN = 0.14;

/** Fresh shape id, mirroring InfiniteCanvas's generator. */
function createId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `sq_${Math.random().toString(36).slice(2)}`;
}

/** Snapshot of a shape's geometry at gesture start, for delta-based edits. */
interface DragItem {
  shape: Square;
  orig: Square;
}

/**
 * Single pointer controller for the canvas. On pointer-down it arbitrates, in
 * priority order: (0) commit an armed placement, (1) shift → rubber-band
 * marquee, (2) the rotation knob of a single selection → rotate, (3) an
 * edge/corner of the selection → stretch the whole selection, (4) a square body
 * → select + move the whole selection, (5) empty space → deselect + pan. All
 * state lives in closure variables and refs — no React state — so dragging
 * never triggers a re-render.
 */
export function useCanvasInteractions({
  canvasRef,
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
}: InteractionParams): void {
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    let mode: Mode = 'none';
    let lastClientX = 0;
    let lastClientY = 0;
    let dragStartX = 0; // world-space anchor for move/resize
    let dragStartY = 0;
    // Cursor position at the LAST move frame. Constrained drags (resize/vertex/
    // thickness) work off the per-frame increment from here (re-baselining item.orig
    // to each clamped result), so the no-worsening clamp ratchets continuously: once a
    // metric passes its bound mid-drag it can't be dragged back across it.
    let dragLastX = 0;
    let dragLastY = 0;
    let dragItems: DragItem[] = [];
    // Per-axis wall-snap lock for the current move drag (hysteresis across frames).
    let snapState: SnapState = emptySnapState();
    let handle: HandleId | null = null;
    let thicknessFace: EdgeFace | null = null; // which wall face a thickness drag moves
    let thicknessAll = false; // Shift held → drag stretches all walls' faces at once
    let rotateTarget: Square | null = null;
    let rotateStartAngle = 0; // pointer angle at grab (deg)
    let rotateStartRotation = 0; // shape rotation at grab (deg)
    // World-space anchor corner of an in-progress footprint draw (the press point).
    let footStart = { x: 0, y: 0 };
    // Active Layers-tool drag target: a trim corner being deformed, a border edge being slid (reveal), an
    // inner grid line / segment being moved, or the world-space anchor of an in-progress boundary draw.
    let partitionCorner: number | null = null;
    let partitionCornerBorder = 0; // which border (index) the grabbed corner belongs to
    let partitionMoveBorder: number | null = null; // which border (index) is being dragged by its interior
    // Snapshot of the dragged border quad + the cursor at grab, so the move can snap (via resolveWallSnap)
    // against the FREE delta from grab — matching how room moves snap — then apply incrementally.
    let partitionMoveOrig: { x: number; y: number }[] | null = null;
    let partitionMoveStart = { x: 0, y: 0 };
    let partitionEdge: BoundaryEdge | null = null;
    let partitionEdgeBorder = 0; // which border (index) the grabbed edge belongs to
    // Snapshot of the border quad + cursor at the start of a boundary-edge stretch (reuses the room's
    // delta-based `stretchEdge`, so an angled edge stretches exactly like a default shape's edge).
    let partitionEdgeOrig: { x: number; y: number }[] | null = null;
    let partitionEdgeStart = { x: 0, y: 0 };
    let partitionLine: LineHandle | null = null;
    let partitionSeg: SegmentRef | null = null;
    let partitionSegExtra: ExtraSegHandle | null = null;
    // A clean click on a cell (no line/edge/corner hit) selects it on release; captured here.
    let partitionCellCandidate: { x: number; y: number; shift: boolean } | null = null;
    // Edit-a-panel frame drag: the grabbed side, the snapshot transient Square at grab, the world press
    // point, and whether Shift (all sides at once) was held.
    let frameEditSide: 'n' | 'e' | 's' | 'w' | 'b' | null = null;
    let frameEditOrig: Square | null = null;
    let frameEditStart = { x: 0, y: 0 };
    let frameEditAll = false;
    // For a border-edge ('b') frame drag: the cut-edge anchor + inward unit normal, plus `grab` (= current
    // band width − the cursor's perpendicular distance at grab) so the band tracks RELATIVE to where it was
    // grabbed instead of snapping to the cursor's absolute distance from the border on the first move.
    let frameEditBorder: { ax: number; ay: number; nx: number; ny: number; grab: number } | null = null;
    // True once the current Layers gesture has changed the partition (drives one undo step on release).
    let partitionMutated = false;
    // True while a 'move' drag is hovering the Library button (drop there = save).
    let overLibrary = false;

    // Is a client point within a given rect (null ⇒ never)?
    const inRect = (r: DOMRect | null | undefined, clientX: number, clientY: number): boolean =>
      !!r && clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;

    // The transient Square for the Edit-a-panel session: interior = the inset glass rect, walls = the group's
    // per-edge frame widths, so its outer footprint is exactly the representative cell rect. This lets the
    // standard-shape edge code (hitShapeEdge / resizeWall) drive per-edge frame editing. Null when no session.
    const frameEditSquare = (): Square | null => {
      const fe = frameEditRef?.current;
      const doc = partitionDocRef?.current;
      if (!fe || !doc) return null;
      const f = partitionGroupFrame(partitionActiveLayer(doc), fe.keys[0]);
      if (!f) return null;
      const inner = partitionFrameInnerRect(fe.rect, f);
      return {
        id: 'frame-edit',
        x: inner.x,
        y: inner.y,
        width: inner.w,
        height: inner.h,
        rotation: 0,
        walls: { n: f.n, e: f.e, s: f.s, w: f.w },
        dots: false,
      };
    };

    // Distance from a world point to a world segment (for grabbing the diagonal border-cut frame edge).
    const distPointSeg = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    };

    // The representative panel's diagonal border-cut edge NEAREST a world point, with its INWARD unit normal
    // and the cursor's distance to it — or null. A corner panel can have two such edges; we grab the closest.
    // The border-frame width is the cursor's perpendicular distance inside the border edge.
    const frameBorderEdgeInfoAt = (
      px: number,
      py: number,
    ): { a: { x: number; y: number }; b: { x: number; y: number }; nx: number; ny: number; dist: number } | null => {
      const fe = frameEditRef?.current;
      const doc = partitionDocRef?.current;
      if (!fe || !doc) return null;
      const edges = partitionPanelBorderEdges(partitionActiveLayer(doc), fe.rect);
      let best: { a: { x: number; y: number }; b: { x: number; y: number }; nx: number; ny: number; dist: number } | null =
        null;
      const cx = fe.rect.x + fe.rect.w / 2;
      const cy = fe.rect.y + fe.rect.h / 2;
      for (const [a, b] of edges) {
        const dist = distPointSeg(px, py, a.x, a.y, b.x, b.y);
        if (best && dist >= best.dist) continue;
        let nx = b.y - a.y;
        let ny = -(b.x - a.x);
        const len = Math.hypot(nx, ny) || 1;
        nx /= len;
        ny /= len;
        if ((cx - (a.x + b.x) / 2) * nx + (cy - (a.y + b.y) / 2) * ny < 0) {
          nx = -nx;
          ny = -ny;
        }
        best = { a, b, nx, ny, dist };
      }
      return best;
    };

    // The current border-frame ('b') width of the edited group (falls back to the side average).
    const currentBorderBand = (): number => {
      const doc = partitionDocRef?.current;
      const fe = frameEditRef?.current;
      if (!doc || !fe) return 0;
      const f = partitionGroupFrame(partitionActiveLayer(doc), fe.keys[0]);
      return f ? f.b ?? (f.n + f.e + f.s + f.w) / 4 : 0;
    };

    // Over a save drop-target: the Library button OR the open Library popup. Dropping on
    // either saves the dragged arrangement to the Library.
    const overLibraryButton = (clientX: number, clientY: number): boolean =>
      inRect(libraryDropRef?.current, clientX, clientY) ||
      inRect(libraryPopupDropRef?.current, clientX, clientY);

    // Click-vs-drag tracking. The magenta edge faces are armed only by a clean
    // click on an edge (press + release with no drag) — never by the release
    // that ends a stretch — so finishing a drag never makes them flash.
    let pressClientX = 0;
    let pressClientY = 0;
    let draggedSinceDown = false;
    let edgeClickArmed = false;
    let gestureDuplicated = false; // an Alt-drag copy was made this gesture
    // Shared-overlap band pressed this gesture: a clean click runs the boolean
    // trim on pointer-up; a drag instead moves the shape (pull-apart).
    let pendingBoolean: { target: Square; other: Square } | null = null;
    // Two selected rooms whose interiors overlap under the press: a clean click in
    // that region merges them (boolean union); a drag instead moves the shape.
    let pendingUnion: { a: Square; b: Square } | null = null;
    // Facade Border mode: two picked, overlapping borders with the press over their shared interior (unite)
    // or a bounding edge (subtract). A clean release runs the boolean; a drag moves the border (pull-apart).
    let pendingBorderBool: BorderBooleanHover | null = null;
    // An edge-plus drag in progress: the source shape, the outward direction, the
    // per-copy world offset, where the press began, and the live copy count (driven
    // by how far the cursor has dragged outward).
    let plusDrag: {
      shape: Square;
      dir: number;
      stepX: number;
      stepY: number;
      startX: number;
      startY: number;
      count: number;
    } | null = null;
    const CLICK_SLOP = 3; // px of travel before a press counts as a drag

    // Only write cursor on change to avoid redundant style work per move.
    let currentCursor = '';
    const setCursor = (c: string) => {
      if (c !== currentCursor) {
        currentCursor = c;
        el.style.cursor = c;
      }
    };

    // Cache the canvas rect and refresh only on resize/scroll, so pointer moves
    // never trigger a synchronous layout read.
    let rect = el.getBoundingClientRect();
    const refreshRect = () => {
      rect = el.getBoundingClientRect();
    };

    const localPoint = (e: PointerEvent) => ({
      sx: e.clientX - rect.left,
      sy: e.clientY - rect.top,
    });

    const selectedShapes = (): Square[] =>
      shapesRef.current.filter((s) => selectionRef.current.has(s.id));

    const singleSelected = (): Square | null => {
      if (selectionRef.current.size !== 1) return null;
      return selectedShapes()[0] ?? null;
    };

    // Create a predicted room from the chosen fan option: placed flush against the
    // source's edge `dir` (corner-aligned), selected, and opened for further chaining.
    // Shared by the drag-release and the click-a-dot paths. One undo step.
    const createPredictedRoom = (sourceId: string, dir: number, option: PredictionOption): void => {
      const source = shapesRef.current.find((s) => s.id === sourceId);
      if (!source) return;
      const wWorld = option.widthFt * WORLD_UNITS_PER_FOOT;
      const hWorld = option.heightFt * WORLD_UNITS_PER_FOOT;
      const place = adjacentRoomPlacement(source, dir, wWorld, hWorld, DEFAULT_WALL_WORLD);
      const room: Square = {
        id: createId(),
        x: place.x,
        y: place.y,
        width: wWorld,
        height: hWorld,
        rotation: place.rotation,
        walls: defaultWalls(),
        dots: true,
        name: option.label,
      };
      shapesRef.current.push(room);
      selectionRef.current = new Set([room.id]);
      activeEdgeRef.current = null;
      commitHistory();
    };

    // Top-most edge of any selected shape under the screen point, with the shape
    // it belongs to (its rotation orients the resize cursor).
    const hitSelectionEdge = (
      sx: number,
      sy: number,
      cam: Camera,
    ): { shape: Square; handle: HandleId } | null => {
      const sel = selectedShapes();
      for (let i = sel.length - 1; i >= 0; i--) {
        const h = hitShapeEdge(sx, sy, sel[i], cam);
        if (h) return { shape: sel[i], handle: h };
      }
      return null;
    };

    // Top-most edge of ANY shape under the point (selected or not). Lets a
    // stretch start on whichever wall edge the cursor is over, with no prior
    // selection required.
    const hitAnyEdge = (
      sx: number,
      sy: number,
      cam: Camera,
    ): { shape: Square; handle: HandleId } | null => {
      const shapes = shapesRef.current;
      for (let i = shapes.length - 1; i >= 0; i--) {
        const h = hitShapeEdge(sx, sy, shapes[i], cam);
        if (h) return { shape: shapes[i], handle: h };
      }
      return null;
    };

    // Top-most shape whose vertex dot (shown after double-click) is under the
    // point, with the corner handle that dot drives. Only dots-enabled shapes
    // qualify, so this is inert until the user double-clicks to show them.
    const hitAnyVertexDot = (
      sx: number,
      sy: number,
      cam: Camera,
    ): { shape: Square; handle: HandleId } | null => {
      const shapes = shapesRef.current;
      for (let i = shapes.length - 1; i >= 0; i--) {
        const h = hitCornerDot(sx, sy, shapes[i], cam);
        if (h) return { shape: shapes[i], handle: h };
      }
      return null;
    };

    // Clone the current selection in place (new ids, on top of the z-order) and
    // make the copies the live selection. Used for Alt-drag duplication.
    const duplicateSelection = () => {
      const copies = selectedShapes().map((s) => ({
        ...s,
        id: createId(),
        walls: { ...s.walls },
        corners: s.corners?.map((p) => ({ ...p })),
        wallEdges: s.wallEdges?.slice(),
      }));
      for (const copy of copies) shapesRef.current.push(copy);
      selectionRef.current = new Set(copies.map((c) => c.id));
    };

    // Deep-enough clone of a shape's geometry, for re-baselining a drag's per-frame
    // origin to the latest clamped result.
    const cloneGeom = (s: Square): Square => ({
      ...s,
      walls: { ...s.walls },
      corners: s.corners?.map((p) => ({ ...p })),
      wallEdges: s.wallEdges?.slice(),
    });

    const snapshotSelection = (world: { x: number; y: number }) => {
      dragStartX = world.x;
      dragStartY = world.y;
      dragLastX = world.x;
      dragLastY = world.y;
      dragItems = selectedShapes().map((s) => ({ shape: s, orig: cloneGeom(s) }));
      snapState = emptySnapState();
    };

    const selectFromMarquee = (m: Marquee, cam: Camera) => {
      const a = screenToWorld(m.x0, m.y0, cam);
      const b = screenToWorld(m.x1, m.y1, cam);
      const minX = Math.min(a.x, b.x);
      const maxX = Math.max(a.x, b.x);
      const minY = Math.min(a.y, b.y);
      const maxY = Math.max(a.y, b.y);

      // Additive: holding shift extends the current selection.
      const next = new Set(selectionRef.current);
      for (const s of shapesRef.current) {
        const intersects =
          s.x <= maxX && s.x + s.width >= minX && s.y <= maxY && s.y + s.height >= minY;
        if (intersects) next.add(s.id);
      }
      selectionRef.current = next;
    };

    const updateHoverCursor = (e: PointerEvent) => {
      // Layers tool: crosshair while drawing the boundary; resize cursors over boundary edges / cell cuts.
      if (layersActiveRef?.current) {
        const { sx: lx, sy: ly } = localPoint(e);
        const cam = cameraRef.current;
        const world = screenToWorld(lx, ly, cam);
        const doc = partitionDocRef?.current;
        const layer = doc ? partitionActiveLayer(doc) : null;
        // Edit-a-panel session: hovering a representative-panel edge highlights it (resize cursor); the rest pans.
        if (frameEditRef?.current) {
          const sq = frameEditSquare();
          const hit = sq ? hitShapeEdge(lx, ly, sq, cam) : null;
          let side: 'n' | 'e' | 's' | 'w' | 'b' | null =
            hit === 'n' || hit === 'e' || hit === 's' || hit === 'w' ? hit : null;
          // Falling on no axis-aligned face, test the diagonal border-cut edge(s) (grab to set the border frame).
          let borderCursor: string | null = null;
          if (!side) {
            const bi = frameBorderEdgeInfoAt(world.x, world.y);
            if (bi) {
              const tolW = 8 / cam.scale;
              if (bi.dist <= Math.max(tolW, currentBorderBand() + tolW * 0.5)) {
                side = 'b';
                borderCursor = cursorForNormal(bi.nx, bi.ny);
              }
            }
          }
          // Shift over any frame edge (a side OR the border) previews scaling every edge uniformly.
          const all = side != null && e.shiftKey;
          if (frameEditRef.current.hoverSide !== side || frameEditRef.current.allSides !== all) {
            frameEditRef.current.hoverSide = side;
            frameEditRef.current.allSides = all;
            requestDraw('scene');
          }
          setCursor(
            side === 'b'
              ? borderCursor ?? 'move'
              : side === 'n' || side === 's'
                ? 'row-resize'
                : side
                  ? 'col-resize'
                  : 'grab',
          );
          return;
        }
        const borderMode = borderModeRef?.current ?? true;
        if (!layer || !partitionHasBoundary(layer)) {
          // No boundary yet → in Border mode drag to draw one; in Panels mode there's nothing to edit.
          setCursor(borderMode ? 'crosshair' : 'grab');
          return;
        }
        const tol = 8 / cam.scale;
        if (borderMode) {
          // Border mode: a dimension label (clickable to type a size) → text cursor; then corners, then edges.
          for (let bi = 0; bi < layer.borders.length; bi++) {
            const bb = partitionPolyBBox(layer.borders[bi]);
            const sq: Square = {
              id: `__border__${bi}`,
              x: bb.x,
              y: bb.y,
              width: bb.w,
              height: bb.h,
              rotation: 0,
              walls: { n: 0, e: 0, s: 0, w: 0 },
              dots: false,
            };
            if (hitDimensionLabel(lx, ly, sq, cam, unitRef.current, BORDER_DIM_GAP)) {
              setCursor('text');
              return;
            }
          }
          // Two borders picked & overlapping: track the cursor (live cyan union grid / subtract hatch preview)
          // and hint that a click acts — taking precedence over the move cursor inside the shared region.
          if (partitionBorderSelRef && partitionBorderSelRef.current.size === 2) {
            hoverPointRef.current = { x: lx, y: ly };
            requestDraw('scene');
            const bh = borderBooleanHoverAt(layer, partitionBorderSelRef.current, world, tol);
            if (bh) {
              setCursor('pointer');
              return;
            }
          }
          // Only the trim border is editable. Corners win (deform into angles), then edges.
          if (hitPartitionCorner(layer, world, tol) != null) {
            setCursor('move');
            return;
          }
          const edge = hitPartitionBoundaryEdge(layer, world, tol);
          if (edge) {
            setCursor(cursorForBoundaryEdge(edge.edge));
            return;
          }
          // Inside a border → it can be dragged to move (like a room); empty space pans.
          setCursor(partitionBorderIndexAt(layer, world) != null ? 'move' : 'grab');
          return;
        }
        // Panels mode: border is locked — only inner-grid editing.
        // Shift hovers a single segment; Alt duplicates the line; otherwise a whole inner line.
        if (e.shiftKey) {
          const seg = hitPartitionGridSegment(layer, world, tol);
          if (seg) {
            setCursor(seg.axis === 'v' ? 'col-resize' : 'row-resize');
            return;
          }
        } else {
          // An already-split segment is grabbable on a plain hover (no Shift), like a first-class line.
          const splitSeg = hitPartitionGridSegment(layer, world, tol);
          if (splitSeg && !e.altKey && partitionIsSplitSegment(layer, splitSeg)) {
            setCursor(splitSeg.axis === 'v' ? 'col-resize' : 'row-resize');
            return;
          }
          const line = hitPartitionLine(layer, world, tol);
          if (line) {
            setCursor(e.altKey ? 'copy' : line.axis === 'v' ? 'col-resize' : 'row-resize');
            return;
          }
        }
        setCursor('grab');
        return;
      }
      // Footprint tool armed → the whole canvas is a draw surface (crosshair).
      if (footprintArmRef.current) {
        setCursor('crosshair');
        return;
      }
      const { sx, sy } = localPoint(e);
      const cam = cameraRef.current;
      const single = singleSelected();
      let redraw = false;

      // A prediction fan left open by a click: track which dot the cursor is over so
      // it grows and its room ghost previews, and show the pointer cursor there.
      const openFan = predictionDragRef.current;
      if (openFan && openFan.dragging) {
        const fanShape = shapesRef.current.find((s) => s.id === openFan.shapeId);
        const hit = fanShape ? hitPredictionOption(sx, sy, fanShape, cam, openFan.dir) : null;
        const hovered = hit != null && openFan.options[hit] ? hit : null;
        if (hovered !== openFan.hovered) {
          openFan.hovered = hovered;
          requestDraw('scene');
        }
        if (hovered != null) return setCursor('pointer');
        // Not over a dot → fall through so arrows/edges still resolve their cursors.
      }

      // Magenta face highlight: only when a single shape has a deliberately
      // selected edge and the pointer is over that same edge's band. Light just
      // the one face (inner or outer) the cursor is nearer.
      const active = activeEdgeRef.current;
      const overActiveEdge =
        edgeClickArmed &&
        !!single &&
        active !== null &&
        hitShapeEdge(sx, sy, single, cam) === active;
      const face: EdgeFace | null =
        overActiveEdge && single && active ? edgeFace(sx, sy, single, cam, active) : null;
      if (face !== edgeHoverRef.current) {
        edgeHoverRef.current = face;
        redraw = true;
      }
      // Shift over that face lights ALL inner/outer faces (stretch the whole boundary).
      const faceAll = face !== null && e.shiftKey;
      if (faceAll !== edgeFaceAllRef.current) {
        edgeFaceAllRef.current = faceAll;
        redraw = true;
      }

      // Hover-preview region: which shape + region the pointer is over, mirroring
      // what a click would act on (selection edges, then any edge, then a body).
      // Edges stay stretchable (hover-darken + resize cursor) even with the
      // vertices showing; the dots only win right at the corners.
      // Inside a shared-overlap yellow band, the wall isn't stretchable, so don't
      // treat it as a grabbable edge (no resize cursor, no edge hover-darken).
      const inOverlapBand = pointInSelectedOverlapBand(
        { x: sx, y: sy },
        shapesRef.current,
        selectionRef.current,
        cam,
      );
      const hitEdge = inOverlapBand
        ? null
        : hitSelectionEdge(sx, sy, cam) ?? hitAnyEdge(sx, sy, cam);
      let hover: { id: string; region: HoverRegion } | null = null;
      if (hitEdge) {
        hover = { id: hitEdge.shape.id, region: hitEdge.handle };
      } else {
        const world = screenToWorld(sx, sy, cam);
        const body = hitTopShape(shapesRef.current, world);
        if (body) hover = { id: body.id, region: 'infill' };
      }
      const prev = hoverRef.current;
      if (hover?.id !== prev?.id || hover?.region !== prev?.region) {
        hoverRef.current = hover;
        redraw = true;
      }
      // Notify the hovered room's catalog key (only when the room changes) so the dev
      // Adjacency Matrix can highlight that program's row + column.
      if (onHoverRoomKey && hover?.id !== prev?.id) {
        const hoveredShape = hover ? shapesRef.current.find((s) => s.id === hover.id) : null;
        onHoverRoomKey(
          hoveredShape ? findRoomDef(hoveredShape.name ?? '')?.key ?? 'default' : null,
        );
      }

      // Track the cursor for the shared-overlap-edge yellow hover. With two or
      // more shapes selected, redraw every move so the highlight follows live.
      hoverPointRef.current = { x: sx, y: sy };
      if (selectionRef.current.size >= 2) redraw = true;

      // Centre readout (name/area) hover → show the editable box around it.
      const overCenter =
        single && active === null ? hitCenterLabel(sx, sy, single, cam, unitRef.current) : null;
      const centerId = overCenter ? single!.id : null;
      if (centerId !== centerHoverRef.current) {
        centerHoverRef.current = centerId;
        redraw = true;
      }

      if (redraw) requestDraw('scene');

      if (e.shiftKey) {
        // Over an armed edge face, Shift drags ALL faces → show the resize double-
        // arrow so it reads as draggable; elsewhere Shift hints the marquee.
        if (face !== null && single && active) {
          return setCursor(cursorForHandle(active, single));
        }
        return setCursor('crosshair');
      }
      // Rotation is only offered while the shape's dimensions are showing (infill-
      // selected, no active edge) — the same state the rotate knob appears in. After an
      // edge stretch the edge stays active, so a corner there stretches, never rotates.
      if (
        single &&
        !single.dots &&
        activeEdgeRef.current === null &&
        hitCorner(sx, sy, single, cam)
      ) {
        return setCursor(ROTATE_CURSOR);
      }
      // A visible vertex dot is draggable to reshape the room. It uses the plain
      // default pointer (not the resize double-arrow) to read as "grab this point".
      const dotHover = hitAnyVertexDot(sx, sy, cam);
      if (dotHover) return setCursor('default');
      // Edge-plus duplicate buttons + the area-lock padlock are clickable while the
      // shape's dimensions are shown. Track which plus is hovered so the scene can
      // ghost the to-be-dropped copy; redraw whenever that changes.
      const dimsShown = single && (single.corners ? true : active === null);
      const plusDir = dimsShown && single ? hitEdgePlus(sx, sy, single, cam) : null;
      // On an OPENED shape (dots) the edge button is a prediction arrow, not a
      // duplicate "+": show a grab cursor and never ghost a copy.
      const arrowHover = plusDir != null && !!single?.dots;
      const plusHover =
        plusDir != null && !arrowHover && single ? { id: single.id, dir: plusDir, count: 1 } : null;
      const prevPlus = edgePlusHoverRef.current;
      if (
        plusHover?.id !== prevPlus?.id ||
        plusHover?.dir !== prevPlus?.dir ||
        plusHover?.count !== prevPlus?.count
      ) {
        edgePlusHoverRef.current = plusHover;
        requestDraw('scene');
      }
      if (arrowHover) return setCursor('pointer');
      if (plusHover) return setCursor('pointer');
      if (dimsShown && single && hitCenterLock(sx, sy, single, cam)) {
        return setCursor('pointer');
      }
      // A dimension label of the infill-selected shape is editable on click.
      if (
        single &&
        active === null &&
        (overCenter || hitDimensionLabel(sx, sy, single, cam, unitRef.current))
      ) {
        return setCursor('text');
      }
      // The active wall edge's length/thickness labels are editable too (once armed).
      if (
        single &&
        active !== null &&
        wallDimsArmedRef.current &&
        hitWallDimensionLabel(sx, sy, single, cam, active, unitRef.current)
      ) {
        return setCursor('text');
      }
      if (hitEdge) return setCursor(cursorForHandle(hitEdge.handle, hitEdge.shape));
      setCursor(hover ? 'move' : 'grab');
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return; // primary button / touch only
      const { sx, sy } = localPoint(e);
      const cam = cameraRef.current;

      // The magenta face under the cursor (non-null only on an armed, hovered
      // edge) — captured before we clear it, since grabbing it drags thickness.
      const grabbedFace = edgeHoverRef.current;

      // Start fresh click-vs-drag tracking, and hide any armed magenta faces for
      // the duration of this gesture (they only re-arm on a clean edge release).
      draggedSinceDown = false;
      gestureDuplicated = false;
      overLibrary = false;
      pressClientX = e.clientX;
      pressClientY = e.clientY;
      edgeClickArmed = false;
      pendingBoolean = null;
      pendingUnion = null;
      pendingBorderBool = null;
      edgeHoverRef.current = null;
      hoverPointRef.current = null; // hide the overlap-edge hover during gestures
      centerHoverRef.current = null; // hide the editable-readout box during gestures
      edgePlusHoverRef.current = null; // clear any duplicate-preview ghost

      // 0a) Layers tool (Facade partition) fully owns the gesture: draw the boundary if there isn't one,
      //     else stretch a boundary edge / cell cut; empty space pans. Room interaction is bypassed.
      if (layersActiveRef?.current) {
        // An armed border placement (from the cube) commits on the next canvas click, even though the
        // Layers tool otherwise owns the gesture — this block returns before the shared placement check below.
        if (placementRef.current) {
          commitPlacement(sx, sy);
          setCursor('crosshair');
          return;
        }
        const doc = partitionDocRef?.current;
        const layer = doc ? partitionActiveLayer(doc) : null;
        partitionCorner = null;
        partitionEdge = null;
        partitionLine = null;
        partitionSeg = null;
        partitionSegExtra = null;
        partitionCellCandidate = null;
        partitionMutated = false;
        frameEditSide = null;
        frameEditOrig = null;
        frameEditBorder = null;
        // Edit-a-panel session owns the gesture: grab a representative-panel edge to set its frame width
        // (mirrored to the group); anywhere else pans.
        if (frameEditRef?.current) {
          const world = screenToWorld(sx, sy, cam);
          const sq = frameEditSquare();
          const hit = sq ? hitShapeEdge(sx, sy, sq, cam) : null;
          const side = hit === 'n' || hit === 'e' || hit === 's' || hit === 'w' ? hit : null;
          if (sq && side) {
            mode = 'partitionFrame';
            frameEditSide = side;
            frameEditOrig = sq;
            frameEditStart = { x: world.x, y: world.y };
            frameEditAll = e.shiftKey;
            frameEditRef.current.hoverSide = side;
            frameEditRef.current.allSides = frameEditAll;
            setCursor(side === 'n' || side === 's' ? 'row-resize' : 'col-resize');
            el.setPointerCapture(e.pointerId);
            return;
          }
          // Grab the nearest diagonal border-cut frame edge → drag to set the border ('b') mullion width.
          const bi = frameBorderEdgeInfoAt(world.x, world.y);
          if (bi) {
            const tolW = 9 / cam.scale;
            if (bi.dist <= Math.max(tolW, currentBorderBand() + tolW * 0.5)) {
              mode = 'partitionFrame';
              frameEditSide = 'b';
              // Invert the inward normal so the band tracks the cursor the same way the n/e/s/w mullions do
              // (with the raw inward normal the drag read reversed — moving the mouse shrank the band).
              const nx = -bi.nx;
              const ny = -bi.ny;
              // Offset so the band picks up from its current width at the grab point (no first-move jump).
              const d0 = (world.x - bi.a.x) * nx + (world.y - bi.a.y) * ny;
              frameEditBorder = { ax: bi.a.x, ay: bi.a.y, nx, ny, grab: currentBorderBand() - d0 };
              frameEditAll = e.shiftKey;
              frameEditRef.current.hoverSide = 'b';
              frameEditRef.current.allSides = frameEditAll;
              setCursor(cursorForNormal(bi.nx, bi.ny));
              el.setPointerCapture(e.pointerId);
              return;
            }
          }
          mode = 'pan';
          lastClientX = e.clientX;
          lastClientY = e.clientY;
          setCursor('grabbing');
          el.setPointerCapture(e.pointerId);
          return;
        }
        // Shift-drag BEGINNING OUTSIDE the trim border → rubber-band multi-select of panel groups (additive).
        // Inside the border, Shift keeps its existing meaning (grab a segment); outside there's nothing to grab.
        if (layer && partitionHasBoundary(layer) && e.shiftKey && partitionGroupSelRef) {
          const world = screenToWorld(sx, sy, cam);
          if (!partitionPointInBorder(layer, world)) {
            mode = 'partitionMarquee';
            marqueeRef.current = { x0: sx, y0: sy, x1: sx, y1: sy };
            setCursor('crosshair');
            el.setPointerCapture(e.pointerId);
            return;
          }
        }
        const borderMode = borderModeRef?.current ?? true;
        // Border mode: the trim border is the only editable thing — draw it / deform corners / slide edges.
        if (layer && borderMode) {
          const world = screenToWorld(sx, sy, cam);
          // Borders are placed via the cube (armed placement); there is no drag-to-draw here. With no border
          // yet, fall through to pan.
          if (partitionHasBoundary(layer)) {
            const tol = 9 / cam.scale;
            // A border's own width/height dimension label (sits outside the trim) → edit it by typing, exactly
            // like a room/footprint dimension. Tested first since labels hang clear of the corners/edges.
            for (let bi = 0; bi < layer.borders.length; bi++) {
              const bb = partitionPolyBBox(layer.borders[bi]);
              const sq: Square = {
                id: `__border__${bi}`,
                x: bb.x,
                y: bb.y,
                width: bb.w,
                height: bb.h,
                rotation: 0,
                walls: { n: 0, e: 0, s: 0, w: 0 },
                dots: false,
              };
              const dimHit = hitDimensionLabel(sx, sy, sq, cam, unitRef.current, BORDER_DIM_GAP);
              if (dimHit) {
                e.preventDefault();
                beginDimensionEdit(sq.id, dimHit);
                return;
              }
            }
            // A trim corner wins (deform into an angle); then a border edge (slide to reveal more cells).
            const corner = hitPartitionCorner(layer, world, tol);
            if (corner != null) {
              mode = 'cornerDrag';
              partitionCorner = corner.corner;
              partitionCornerBorder = corner.border;
              setCursor('move');
              el.setPointerCapture(e.pointerId);
              return;
            }
            const edge = hitPartitionBoundaryEdge(layer, world, tol);
            if (edge) {
              mode = 'boundaryEdge';
              partitionEdge = edge.edge;
              partitionEdgeBorder = edge.border;
              partitionEdgeOrig = layer.borders[edge.border].map((p) => ({ x: p.x, y: p.y }));
              partitionEdgeStart = { x: world.x, y: world.y };
              setCursor(cursorForBoundaryEdge(edge.edge));
              el.setPointerCapture(e.pointerId);
              return;
            }
            // Click-drag from a border's INTERIOR → move that border (like a room). Each border carries its own
            // lattice/panels rigidly, so moving one never disturbs another's pattern. Empty space falls to pan.
            const moveIdx = partitionBorderIndexAt(layer, world);
            // Two borders picked & overlapping: a clean click in their shared interior UNITES them; on a
            // bounding edge it SUBTRACTS that edge's border from the other (Plan-mode booleans). We still arm
            // a border move so a drag past the click slop pulls the border apart instead; the boolean only
            // fires on a clean release (handled on pointer-up).
            if (!e.shiftKey && partitionBorderSelRef && partitionBorderSelRef.current.size === 2) {
              const bh = borderBooleanHoverAt(layer, partitionBorderSelRef.current, world, tol);
              if (bh) {
                pendingBorderBool = bh;
                const mi = moveIdx ?? (bh.kind === 'union' ? bh.a : bh.target);
                mode = 'borderMove';
                partitionMoveBorder = mi;
                partitionMoveStart = { x: world.x, y: world.y };
                partitionMoveOrig = layer.borders[mi].map((p) => ({ x: p.x, y: p.y }));
                snapState = emptySnapState();
                setCursor('move');
                el.setPointerCapture(e.pointerId);
                return;
              }
            }
            if (moveIdx != null) {
              // Shift-click toggles a border in the boolean-op selection (no move). Insertion order is kept, so
              // the first-picked border is the difference target by default.
              if (e.shiftKey && partitionBorderSelRef) {
                const sel = new Set(partitionBorderSelRef.current);
                if (sel.has(moveIdx)) sel.delete(moveIdx);
                else sel.add(moveIdx);
                partitionBorderSelRef.current = sel;
                requestDraw('scene');
                return;
              }
              // A plain click single-selects the border it grabs (clears any multi-pick) and starts the move.
              if (partitionBorderSelRef) partitionBorderSelRef.current = new Set([moveIdx]);
              mode = 'borderMove';
              partitionMoveBorder = moveIdx;
              partitionMoveStart = { x: world.x, y: world.y };
              partitionMoveOrig = layer.borders[moveIdx].map((p) => ({ x: p.x, y: p.y }));
              snapState = emptySnapState();
              setCursor('move');
              el.setPointerCapture(e.pointerId);
              return;
            }
            // Clicked empty space inside the layer (no border/corner/edge) → drop any boolean-op pick.
            if (partitionBorderSelRef?.current.size) {
              partitionBorderSelRef.current = new Set();
              requestDraw('scene');
            }
          }
          // Nothing border-related hit → fall through to pan (no panel editing in Border mode).
        } else if (layer && partitionHasBoundary(layer)) {
          // Panels mode: the border is LOCKED — edit only the inner grid (lines / segments / panel groups).
          const world = screenToWorld(sx, sy, cam);
          const tol = 9 / cam.scale;
          // Alt → DUPLICATE. If a single segment is selected, copy just that segment (a partial divider);
          // otherwise copy the whole line under the cursor. Shift → grab a single SEGMENT (select + jog
          // it). Plain → drag the whole line (Excel-style).
          if (e.altKey && partitionSelSegRef?.current) {
            const dupSeg = duplicatePartitionSegment(layer, partitionSelSegRef.current);
            if (dupSeg) {
              mode = 'segExtraDrag';
              partitionSegExtra = dupSeg;
              partitionMutated = true; // the copied segment exists even without a drag
              setCursor(dupSeg.axis === 'v' ? 'col-resize' : 'row-resize');
              el.setPointerCapture(e.pointerId);
              requestDraw('scene');
              return;
            }
          }
          if (e.altKey) {
            const line = hitPartitionLine(layer, world, tol);
            if (line) {
              const pos = line.axis === 'v' ? world.x : world.y;
              const dup = duplicatePartitionLine(layer, line.border, line.axis, pos);
              if (dup) {
                mode = 'lineDrag';
                partitionLine = dup;
                partitionMutated = true; // the duplicate exists even without a drag
                if (partitionSelSegRef?.current) partitionSelSegRef.current = null;
                setCursor(dup.axis === 'v' ? 'col-resize' : 'row-resize');
                el.setPointerCapture(e.pointerId);
                requestDraw('scene');
                return;
              }
            }
          } else if (e.shiftKey) {
            const seg = hitPartitionGridSegment(layer, world, tol);
            if (seg) {
              mode = 'segmentDrag';
              partitionSeg = seg;
              if (partitionSelSegRef) partitionSelSegRef.current = seg;
              setCursor(seg.axis === 'v' ? 'col-resize' : 'row-resize');
              el.setPointerCapture(e.pointerId);
              requestDraw('scene');
              return;
            }
          } else {
            // An already-split segment moves on a plain drag (no Shift) — it behaves like a normal line now.
            const splitSeg = hitPartitionGridSegment(layer, world, tol);
            if (splitSeg && partitionIsSplitSegment(layer, splitSeg)) {
              mode = 'segmentDrag';
              partitionSeg = splitSeg;
              if (partitionSelSegRef) partitionSelSegRef.current = splitSeg;
              setCursor(splitSeg.axis === 'v' ? 'col-resize' : 'row-resize');
              el.setPointerCapture(e.pointerId);
              requestDraw('scene');
              return;
            }
            // A plain click anywhere in the grid clears the segment selection.
            if (partitionSelSegRef?.current) {
              partitionSelSegRef.current = null;
              requestDraw('scene');
            }
            const line = hitPartitionLine(layer, world, tol);
            if (line) {
              mode = 'lineDrag';
              partitionLine = line;
              setCursor(line.axis === 'v' ? 'col-resize' : 'row-resize');
              el.setPointerCapture(e.pointerId);
              return;
            }
          }
          // No line/edge/corner/segment hit: if the cursor is inside a panel, arm a group-select (applied
          // on a clean release); a drag from here still pans.
          if (partitionGroupSelRef && partitionCellGroupAt(layer, world)) {
            partitionCellCandidate = { x: world.x, y: world.y, shift: e.shiftKey };
          }
        }
        // Empty space → pan.
        mode = 'pan';
        lastClientX = e.clientX;
        lastClientY = e.clientY;
        setCursor('grabbing');
        el.setPointerCapture(e.pointerId);
        return;
      }

      // 0) Armed placement → click commits the preview as a real square.
      if (placementRef.current) {
        commitPlacement(sx, sy);
        setCursor('move');
        return;
      }

      // 0.3) A prediction fan left open by a click: clicking one of its dots places
      //      that room; clicking anywhere else dismisses the fan (then falls through
      //      to normal handling, so a fresh click can re-open / arm another arrow).
      const openPd = predictionDragRef.current;
      if (openPd && openPd.dragging) {
        const fanShape = shapesRef.current.find((s) => s.id === openPd.shapeId);
        const hit = fanShape ? hitPredictionOption(sx, sy, fanShape, cam, openPd.dir) : null;
        if (fanShape && hit != null && openPd.options[hit]) {
          createPredictedRoom(openPd.shapeId, openPd.dir, openPd.options[hit]!);
          predictionDragRef.current = null;
          setCursor('move');
          requestDraw('scene');
          return;
        }
        predictionDragRef.current = null;
        requestDraw('scene');
      }

      // 0.5) Footprint tool armed → click-drag draws a building footprint (a white
      //      slab behind the rooms). The draft tracks the cursor until release.
      if (footprintArmRef.current) {
        const w0 = screenToWorld(sx, sy, cam);
        footStart = { x: w0.x, y: w0.y };
        footprintDraftRef.current = { id: createId(), x: w0.x, y: w0.y, width: 0, height: 0 };
        mode = 'footdraw';
        setCursor('crosshair');
        el.setPointerCapture(e.pointerId);
        return;
      }

      // 1) Shift → rubber-band marquee selection — UNLESS the cursor is on an armed
      //    magenta edge face, where Shift instead drags all walls' faces at once
      //    (handled by the thickness branch below).
      if (e.shiftKey && !grabbedFace) {
        mode = 'marquee';
        marqueeRef.current = { x0: sx, y0: sy, x1: sx, y1: sy };
        setCursor('crosshair');
        el.setPointerCapture(e.pointerId);
        return;
      }

      const world = screenToWorld(sx, sy, cam);

      // 2) Corner of a single selection → rotate about the centre.
      const single = singleSelected();

      // 1.3) Press an edge-plus button (shown while dimensions are) → begin a
      //      duplicate gesture in that direction. A click (no drag) drops one copy;
      //      dragging outward spawns more — one extra copy per room-length travelled
      //      — with a live ghost per copy. The copies are committed on pointer-up.
      const dimsForLock = !!single && (single.corners ? true : activeEdgeRef.current === null);
      if (single && dimsForLock) {
        const dir = hitEdgePlus(sx, sy, single, cam);
        if (dir != null) {
          e.preventDefault();
          if (single.dots) {
            // Opened shape: the edge button is a prediction arrow. Arm the fan; it
            // only renders once the press becomes a drag (set in onPointerMove).
            // Predict the likely neighbours now (confidence-ranked) and slot them by
            // position: middle (index 1) = most confident, then index 0, then 2.
            const sourceKey = findRoomDef(single.name ?? '')?.key ?? 'default';
            const ranked = predictRoomOptions(sourceKey, 3);
            const positionForRank = [1, 0, 2];
            const options: (PredictionOption | null)[] = [null, null, null];
            ranked.forEach((opt) => {
              options[positionForRank[opt.rank]] = opt;
            });
            mode = 'predictdrag';
            predictionDragRef.current = {
              shapeId: single.id,
              dir,
              hovered: null,
              dragging: false,
              options,
            };
            edgePlusHoverRef.current = null; // no duplicate ghost in this mode
            setCursor('pointer');
            el.setPointerCapture(e.pointerId);
            return;
          }
          const { dx, dy } = adjacentCopyOffset(single, dir);
          mode = 'plusdrag';
          plusDrag = {
            shape: single,
            dir,
            stepX: dx,
            stepY: dy,
            startX: world.x,
            startY: world.y,
            count: 1,
          };
          edgePlusHoverRef.current = { id: single.id, dir, count: 1 };
          el.setPointerCapture(e.pointerId);
          requestDraw('scene');
          return;
        }
      }

      // 1.4) Click the area-lock padlock (under the ft² readout, shown while this
      //      room's dimensions are) → toggle preserving its square footage on edits.
      if (single && dimsForLock && hitCenterLock(sx, sy, single, cam)) {
        e.preventDefault();
        single.areaLocked = !single.areaLocked;
        commitHistory();
        requestDraw('scene');
        return;
      }

      // 1.5) Click a dimension label of the infill-selected shape → edit it.
      //      preventDefault keeps the press from moving focus off the editor
      //      input that's about to mount.
      if (single && activeEdgeRef.current === null) {
        const dimHit = hitDimensionLabel(sx, sy, single, cam, unitRef.current);
        if (dimHit) {
          e.preventDefault();
          beginDimensionEdit(single.id, dimHit);
          return;
        }
        // Click the centre readout to rename the room or set its square footage.
        const centerHit = hitCenterLabel(sx, sy, single, cam, unitRef.current);
        if (centerHit) {
          e.preventDefault();
          beginCenterEdit(single.id, centerHit);
          return;
        }
      }

      // 1.6) Click the active wall edge's own length/thickness label → edit it. Shown
      //      whenever a single shape has an active edge; the labels sit off the wall,
      //      so this never collides with the magenta face-grab or the edge stretch.
      if (single && activeEdgeRef.current !== null && wallDimsArmedRef.current) {
        const wallHit = hitWallDimensionLabel(
          sx,
          sy,
          single,
          cam,
          activeEdgeRef.current,
          unitRef.current,
        );
        if (wallHit) {
          e.preventDefault();
          beginWallDimensionEdit(single.id, wallHit);
          return;
        }
      }

      // Corner-grab rotates ONLY while the shape's dimensions are showing (infill-
      // selected, no active edge) — i.e. the rotate knob is actually visible. This
      // prevents an accidental rotate right after an edge stretch (which leaves the
      // edge active, dimensions hidden) and while the editable vertices are showing.
      const rotateCorner =
        single && !single.dots && activeEdgeRef.current === null
          ? hitCornerHandle(sx, sy, single, cam)
          : null;
      if (single && rotateCorner) {
        mode = 'rotate';
        rotateTarget = single;
        rotatingRef.current = { id: single.id, corner: rotateCorner };
        const cx = single.x + single.width / 2;
        const cy = single.y + single.height / 2;
        rotateStartAngle = Math.atan2(world.y - cy, world.x - cx) * (180 / Math.PI);
        rotateStartRotation = single.rotation;
        setCursor(ROTATE_CURSOR);
        el.setPointerCapture(e.pointerId);
        return;
      }

      // 2.5) A magenta face of an armed selected edge → drag to change that wall's
      //      thickness (inner or outer face, whichever was lit). With Shift held the
      //      drag stretches ALL walls' faces of that kind at once (whole boundary).
      const activeEdge = activeEdgeRef.current;
      if (grabbedFace && activeEdge && single) {
        mode = 'thickness';
        handle = activeEdge;
        thicknessFace = grabbedFace;
        // Facade panels keep a uniform band, so a thickness drag always moves all four faces (no Shift
        // needed); the inspector's single mullion/joint value then stays in sync with the canvas.
        thicknessAll = e.shiftKey || !!facadeRef?.current;
        // Re-arm the lit face for the whole drag (pointer-down cleared it above), so
        // the magenta stretch line and the wall's length/thickness dimensions stay
        // visible and auto-update as the wall is stretched.
        edgeHoverRef.current = grabbedFace;
        edgeFaceAllRef.current = thicknessAll;
        snapshotSelection(world);
        setCursor(cursorForHandle(activeEdge, single));
        el.setPointerCapture(e.pointerId);
        return;
      }

      // 2.7) A visible vertex dot → drag that corner to reshape the room. It's a
      //      corner resize: the two adjacent edges follow the cursor while the
      //      opposite corner stays anchored, so width/height/area/dimensions all
      //      update parametrically. Wins over an edge grab (the dot sits at the
      //      interior corner where two edges meet).
      const dot = hitAnyVertexDot(sx, sy, cam);
      if (dot) {
        if (!selectionRef.current.has(dot.shape.id)) {
          selectionRef.current = new Set([dot.shape.id]);
        }
        // Treat as an infill (non-edge) selection so the live dimensions show
        // while reshaping; the corner handle drives the resize.
        activeEdgeRef.current = null;
        resizingRef.current = true;
        mode = 'vertex';
        handle = dot.handle;
        snapshotSelection(world);
        setCursor('default'); // plain pointer while dragging a vertex point
        el.setPointerCapture(e.pointerId);
        requestDraw('scene');
        return;
      }

      // 3) A wall edge → stretch it. Edges of the current selection win (so a
      //    multi-selection resizes together); otherwise grab whichever shape's
      //    edge is under the cursor, selecting just that shape. Either way, the
      //    grabbed edge becomes the active (darkened) region.
      // Edge-stretching stays available even while a shape's editable vertices
      // are showing: a grab right on a dot already became a vertex reshape in 2.7,
      // so anywhere else along the wall stretches the edge. Free-form quads
      // stretch by edge just like rectangles do.
      // Edge-stretch is disabled inside a shared-overlap band (the wall-over-
      // infill strip between two selected, overlapping rooms): a clean click there
      // performs the boolean trim (handled on pointer-up), and a drag falls
      // through to move the shape (pull-apart). Never stretches.
      pendingBoolean = overlapBandAt({ x: sx, y: sy }, shapesRef.current, selectionRef.current, cam);
      // Inside the shared INTERIOR-overlap region (both rooms' infill), a clean click
      // merges the two (boolean union); a drag still moves the shape (pull-apart).
      pendingUnion = overlapInteriorAt({ x: sx, y: sy }, shapesRef.current, selectionRef.current, cam);
      const edge = pendingBoolean ? null : hitSelectionEdge(sx, sy, cam) ?? hitAnyEdge(sx, sy, cam);
      if (edge) {
        // Dimensions persist through a stretch only if they were already showing
        // (this shape infill-selected) before the grab — never summoned by a
        // stretch that began on the edge.
        const dimsWereShowing =
          activeEdgeRef.current === null &&
          selectionRef.current.size === 1 &&
          selectionRef.current.has(edge.shape.id);
        if (!selectionRef.current.has(edge.shape.id)) {
          selectionRef.current = new Set([edge.shape.id]);
        }
        mode = 'resize';
        handle = edge.handle;
        activeEdgeRef.current = edge.handle;
        resizingRef.current = dimsWereShowing;
        // Fresh grab of an (un-armed) edge: hold the wall dimensions off during the
        // drag. A clean release (no drag) re-arms them on pointer-up below.
        wallDimsArmedRef.current = false;
        snapshotSelection(world);
        setCursor(cursorForHandle(edge.handle, edge.shape));
        el.setPointerCapture(e.pointerId);
        requestDraw('scene');
        return;
      }

      // 4) A square body (white infill) → select (if not already) and move the
      //    whole selection; the infill becomes the active (darkened) region.
      //    Holding Alt drags a fresh copy, leaving the originals in place.
      const hit = hitTopShape(shapesRef.current, world);
      if (hit) {
        if (!selectionRef.current.has(hit.id)) {
          selectionRef.current = new Set([hit.id]);
        }
        if (e.altKey) {
          duplicateSelection();
          gestureDuplicated = true;
        }
        activeEdgeRef.current = null;
        mode = 'move';
        snapshotSelection(world);
        setCursor('move');
        el.setPointerCapture(e.pointerId);
        requestDraw('scene');
        return;
      }

      // 4.5) A building footprint's own Length/Width dimension label (these sit in
      //      open space beyond the slab, behind the rooms) → edit it by typing.
      for (const fp of footprintsRef.current) {
        const fpHit = hitDimensionLabel(sx, sy, footprintAsShape(fp), cam, unitRef.current);
        if (fpHit) {
          e.preventDefault();
          beginDimensionEdit(fp.id, fpHit);
          return;
        }
      }

      // 5) Empty space → deselect and pan.
      if (selectionRef.current.size > 0) {
        selectionRef.current = new Set();
        activeEdgeRef.current = null;
        requestDraw('scene');
      }
      mode = 'pan';
      lastClientX = e.clientX;
      lastClientY = e.clientY;
      setCursor('grabbing');
      el.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      // Armed placement → the preview tracks the cursor. Show the four-arrow move
      // cursor (as when dragging a shape's infill), since this drops/moves a shape.
      if (placementRef.current) {
        const { sx, sy } = localPoint(e);
        placementRef.current.sx = sx;
        placementRef.current.sy = sy;
        setCursor('move');
        requestDraw('scene');
        return;
      }

      if (mode === 'none') {
        updateHoverCursor(e);
        return;
      }

      // Once the pointer travels past the slop, this gesture is a drag — which
      // keeps a stretch's closing release from arming the magenta edge faces.
      if (!draggedSinceDown) {
        const moved = Math.hypot(e.clientX - pressClientX, e.clientY - pressClientY);
        if (moved > CLICK_SLOP) draggedSinceDown = true;
      }

      // A real geometry edit (stretch, vertex move, wall-thickness drag, rotate)
      // dismisses any active smart-find highlight, like pressing Esc. Navigation
      // (pan/zoom), selection, and plain moves keep it. Idempotent, so the per-frame
      // call is cheap once cleared.
      if (
        draggedSinceDown &&
        (mode === 'resize' || mode === 'vertex' || mode === 'thickness' || mode === 'rotate')
      ) {
        clearFindHighlight?.();
      }

      const cam = cameraRef.current;

      if (mode === 'pan') {
        cam.x += e.clientX - lastClientX;
        cam.y += e.clientY - lastClientY;
        lastClientX = e.clientX;
        lastClientY = e.clientY;
        requestDraw('all'); // shapes move with the camera, so both layers
        return;
      }

      if (mode === 'marquee' || mode === 'partitionMarquee') {
        const { sx, sy } = localPoint(e);
        const m = marqueeRef.current;
        if (m) {
          m.x1 = sx;
          m.y1 = sy;
          requestDraw('scene');
        }
        return;
      }

      if (mode === 'footdraw') {
        const { sx, sy } = localPoint(e);
        const w = screenToWorld(sx, sy, cam);
        const d = footprintDraftRef.current;
        if (d) {
          d.x = Math.min(footStart.x, w.x);
          d.y = Math.min(footStart.y, w.y);
          d.width = Math.abs(w.x - footStart.x);
          d.height = Math.abs(w.y - footStart.y);
          requestDraw('scene');
        }
        return;
      }

      const { sx, sy } = localPoint(e);
      const world = screenToWorld(sx, sy, cam);

      // Edit-a-panel: drag the diagonal BORDER frame edge — the new border ('b') width is the cursor's
      // perpendicular distance inside the border. Shift scales every edge (n/e/s/w + b) to this one width;
      // otherwise only `b` changes (the n/e/s/w widths are preserved).
      if (mode === 'partitionFrame' && frameEditSide === 'b' && frameEditBorder && frameEditRef?.current) {
        frameEditAll = e.shiftKey;
        frameEditRef.current.allSides = frameEditAll;
        const { ax, ay, nx, ny, grab } = frameEditBorder;
        setCursor(cursorForNormal(nx, ny));
        const maxB = Math.min(frameEditRef.current.rect.w, frameEditRef.current.rect.h) * 0.9;
        const b = Math.max(MIN_WALL_WORLD, Math.min(maxB, (world.x - ax) * nx + (world.y - ay) * ny + grab));
        const doc = partitionDocRef?.current;
        if (doc) {
          const layer = partitionActiveLayer(doc);
          const cur = partitionGroupFrame(layer, frameEditRef.current.keys[0]);
          const next = frameEditAll ? { n: b, e: b, s: b, w: b, b } : cur ? { ...cur, b } : null;
          if (next) partitionSetGroupFrame(layer, frameEditRef.current.keys, next);
          partitionMutated = true;
          requestDraw('scene');
        }
        return;
      }

      // Edit-a-panel: drag the grabbed side's frame width (inner face → outer cell rect stays grid-fixed).
      // Shift resizes all four sides at once. The new widths are written to every selected group key (mirror).
      if (mode === 'partitionFrame' && frameEditSide && frameEditSide !== 'b' && frameEditOrig && frameEditRef?.current) {
        // Toggling Shift mid-drag switches between this side and all four (the highlight follows).
        frameEditAll = e.shiftKey;
        frameEditRef.current.allSides = frameEditAll;
        const dx = world.x - frameEditStart.x;
        const dy = world.y - frameEditStart.y;
        const minInterior = MIN_SHAPE_SCREEN_SIZE / cam.scale;
        const next = frameEditAll
          ? resizeAllWalls(frameEditOrig, frameEditSide, 'inner', dx, dy, MIN_WALL_WORLD, minInterior)
          : resizeWall(frameEditOrig, frameEditSide, 'inner', dx, dy, MIN_WALL_WORLD, minInterior);
        const doc = partitionDocRef?.current;
        if (doc) {
          const cur = partitionGroupFrame(partitionActiveLayer(doc), frameEditRef.current.keys[0]);
          partitionSetGroupFrame(partitionActiveLayer(doc), frameEditRef.current.keys, {
            n: next.walls.n,
            e: next.walls.e,
            s: next.walls.s,
            w: next.walls.w,
            // Shift = uniform: scale the border frame with the sides; otherwise preserve the user-set border.
            b: frameEditAll ? next.walls.n : cur?.b,
          });
          partitionMutated = true;
          requestDraw('scene');
        }
        return;
      }

      // Layers tool: deform a trim corner, stretch a boundary edge, or drag a cell cut
      // (the two adjacent cells reflow; the rest stays put).
      if (mode === 'cornerDrag' && partitionCorner != null && partitionDocRef?.current) {
        const layer = partitionActiveLayer(partitionDocRef.current);
        // Keep per-group frames attached as the border reshapes the panels it slices.
        partitionPreserveFrames(layer, () =>
          movePartitionCorner(layer, partitionCornerBorder, partitionCorner!, world),
        );
        partitionMutated = true;
        requestDraw('scene');
        return;
      }
      if (mode === 'borderMove' && partitionMoveBorder != null && partitionMoveOrig && partitionDocRef?.current) {
        // While a two-border boolean is pending, hold the move until the gesture is clearly a drag, so a clean
        // click commits the boolean (on pointer-up) instead of nudging the border by sub-slop jitter.
        if (pendingBorderBool && !draggedSinceDown) return;
        const layer = partitionActiveLayer(partitionDocRef.current);
        // Snap the FREE delta (from grab) onto a nearby OTHER border's edge/corner, surfacing the green guides,
        // exactly like a room move. Then apply it as an incremental delta against the live quad so
        // movePartitionBorder's per-border lattice carry-along stays intact.
        const dragged = borderToSquare(partitionMoveOrig);
        const statics: Square[] = [];
        layer.borders.forEach((poly, i) => {
          if (i !== partitionMoveBorder) statics.push(borderToSquare(poly));
        });
        const freeDx = world.x - partitionMoveStart.x;
        const freeDy = world.y - partitionMoveStart.y;
        const snapped = resolveWallSnap([dragged], statics, freeDx, freeDy, cam.scale, snapState);
        alignGuidesRef.current = snapped.guides.length > 0 ? snapped.guides : null;
        const live = layer.borders[partitionMoveBorder];
        const targetX = partitionMoveOrig[0].x + snapped.dx;
        const targetY = partitionMoveOrig[0].y + snapped.dy;
        movePartitionBorder(layer, partitionMoveBorder, targetX - live[0].x, targetY - live[0].y);
        partitionMutated = true;
        requestDraw('scene');
        return;
      }
      if (mode === 'boundaryEdge' && partitionEdge && partitionEdgeOrig && partitionDocRef?.current) {
        // Reuse the room/shape edge stretch: offsets the grabbed edge along its outward normal and slides
        // the endpoints along the two adjacent edges — so an angled border edge behaves like a default shape.
        const layer = partitionActiveLayer(partitionDocRef.current);
        const borderSquare = borderToSquare(partitionEdgeOrig);
        // Keep per-group frames attached as the border edge reshapes the panels it slices.
        partitionPreserveFrames(layer, () => {
          const next = stretchEdge(borderSquare, partitionEdge!, world.x - partitionEdgeStart.x, world.y - partitionEdgeStart.y);
          if (next.corners && layer.borders[partitionEdgeBorder])
            layer.borders[partitionEdgeBorder] = next.corners.map((p) => ({ x: p.x, y: p.y }));
        });
        partitionMutated = true;
        requestDraw('scene');
        return;
      }
      if (mode === 'lineDrag' && partitionLine && partitionDocRef?.current) {
        const layer = partitionActiveLayer(partitionDocRef.current);
        const axis = partitionLine.axis;
        const cands = partitionLineCandidates(layer, partitionLine.border, axis, partitionLine);
        const snap = snapLineCoord(axis === 'v' ? world.x : world.y, cands, cam.scale);
        alignGuidesRef.current = snap.guide != null ? [{ axis: axis === 'v' ? 'x' : 'y', world: snap.guide }] : null;
        partitionPreserveFrames(layer, () =>
          movePartitionLine(
            layer,
            partitionLine!,
            axis === 'v' ? { x: snap.value, y: world.y } : { x: world.x, y: snap.value },
          ),
        );
        partitionMutated = true;
        requestDraw('scene');
        return;
      }
      if (mode === 'segmentDrag' && partitionSeg && partitionDocRef?.current) {
        const layer = partitionActiveLayer(partitionDocRef.current);
        const axis = partitionSeg.axis;
        const cands = partitionLineCandidates(layer, partitionSeg.border, axis);
        const snap = snapLineCoord(axis === 'v' ? world.x : world.y, cands, cam.scale);
        alignGuidesRef.current = snap.guide != null ? [{ axis: axis === 'v' ? 'x' : 'y', world: snap.guide }] : null;
        partitionPreserveFrames(layer, () =>
          movePartitionGridSegment(
            layer,
            partitionSeg!,
            axis === 'v' ? { x: snap.value, y: world.y } : { x: world.x, y: snap.value },
          ),
        );
        partitionMutated = true;
        requestDraw('scene');
        return;
      }
      if (mode === 'segExtraDrag' && partitionSegExtra && partitionDocRef?.current) {
        const layer = partitionActiveLayer(partitionDocRef.current);
        const axis = partitionSegExtra.axis;
        const cands = partitionLineCandidates(layer, partitionSegExtra.border, axis);
        const snap = snapLineCoord(axis === 'v' ? world.x : world.y, cands, cam.scale);
        alignGuidesRef.current = snap.guide != null ? [{ axis: axis === 'v' ? 'x' : 'y', world: snap.guide }] : null;
        partitionPreserveFrames(layer, () =>
          movePartitionSegmentExtra(
            layer,
            partitionSegExtra!,
            axis === 'v' ? { x: snap.value, y: world.y } : { x: world.x, y: snap.value },
          ),
        );
        partitionMutated = true;
        requestDraw('scene');
        return;
      }

      if (mode === 'rotate' && rotateTarget) {
        const cx = rotateTarget.x + rotateTarget.width / 2;
        const cy = rotateTarget.y + rotateTarget.height / 2;
        // Rotate relative to the grab so the grabbed corner tracks the cursor.
        const angle = Math.atan2(world.y - cy, world.x - cx) * (180 / Math.PI);
        let deg = rotateStartRotation + (angle - rotateStartAngle);
        deg = Math.round(deg / ROTATION_SNAP_DEG) * ROTATION_SNAP_DEG;
        rotateTarget.rotation = ((deg % 360) + 360) % 360;
        requestDraw('scene');
        return;
      }

      if (mode === 'plusdrag' && plusDrag) {
        // Copy count = how many room-lengths the cursor has dragged outward (along
        // the duplicate direction), at least 1. Each step adds one more ghost.
        const stepLen = Math.hypot(plusDrag.stepX, plusDrag.stepY) || 1;
        const ux = plusDrag.stepX / stepLen;
        const uy = plusDrag.stepY / stepLen;
        const projected = (world.x - plusDrag.startX) * ux + (world.y - plusDrag.startY) * uy;
        const count = Math.max(1, Math.min(MAX_PLUS_COPIES, Math.floor(projected / stepLen) + 1));
        if (count !== plusDrag.count) {
          plusDrag.count = count;
          edgePlusHoverRef.current = { id: plusDrag.shape.id, dir: plusDrag.dir, count };
          requestDraw('scene');
        }
        return;
      }

      if (mode === 'predictdrag') {
        const pd = predictionDragRef.current;
        const shape = pd ? shapesRef.current.find((s) => s.id === pd.shapeId) : undefined;
        if (pd && shape) {
          // The fan appears once the press becomes a drag; then track which option the
          // cursor is over (it grows) as the user sweeps across the arc.
          const wasDragging = pd.dragging;
          if (!pd.dragging && draggedSinceDown) pd.dragging = true;
          if (pd.dragging) {
            const hit = hitPredictionOption(sx, sy, shape, cam, pd.dir);
            // Only a slot with an actual prediction is hoverable.
            const hovered = hit != null && pd.options[hit] ? hit : null;
            if (hovered !== pd.hovered || !wasDragging) {
              pd.hovered = hovered;
              requestDraw('scene');
            }
          }
        }
        return;
      }

      const dx = world.x - dragStartX;
      const dy = world.y - dragStartY;
      // Per-frame increment for the constrained drags: they build off the previous
      // frame's clamped geometry (item.orig, re-baselined below) rather than the
      // drag-start snapshot, so a metric that passes its bound mid-drag stays passed.
      const idx = world.x - dragLastX;
      const idy = world.y - dragLastY;

      if (mode === 'move') {
        // Wall-alignment snapping: pull the free delta onto a nearby wall axis (with a
        // breakout once the cursor strays far enough), and surface the green guide lines.
        const draggedOrig = dragItems.map((it) => it.orig);
        const statics = shapesRef.current.filter((s) => !selectionRef.current.has(s.id));
        const snapped = resolveWallSnap(draggedOrig, statics, dx, dy, cam.scale, snapState);
        alignGuidesRef.current = snapped.guides.length > 0 ? snapped.guides : null;
        for (const item of dragItems) {
          item.shape.x = item.orig.x + snapped.dx;
          item.shape.y = item.orig.y + snapped.dy;
        }
        // Light up the Library button when the dragged cluster is over it (dropping
        // there saves the arrangement instead of relocating it).
        const over = overLibraryButton(e.clientX, e.clientY);
        if (over !== overLibrary) {
          overLibrary = over;
          setCursor(over ? 'copy' : 'move');
          onLibraryHover?.(over);
          // Drive the shrink-into-Library animation: collapse while over, restore on leave.
          libraryShrinkRef.current.target = over ? LIBRARY_SHRINK_MIN : 1;
        }
        // Track the pointer so the shrink collapses toward the cursor, not the group.
        libraryShrinkRef.current.pivot = { x: world.x, y: world.y };
        requestDraw('scene'); // grid is static — only the scene changed
      } else if (mode === 'resize' && handle) {
        const minWorld = MIN_SHAPE_SCREEN_SIZE / cam.scale;
        const k = constraintsRef.current;
        const h = handle;
        for (const item of dragItems) {
          // A free-form quad stretches by translating the whole grabbed edge; a
          // rectangle stretches axis-locked so it stays rectangular. With the area
          // lock on, the candidate is scaled back to the original footage. The clamp
          // then stops the drag at the constraint boundary (hard lock).
          const orig = item.orig;
          // Anchor the edit at the opposite edge so a locked room scales in place.
          const anchor = orig.areaLocked ? areaLockAnchorWorld(orig, h, false) : null;
          const next = clampDragToConstraints(
            (ddx, ddy) => {
              const cand = orig.corners
                ? stretchEdge(orig, h, ddx, ddy)
                : resizeShape(orig, h, ddx, ddy, minWorld);
              return anchor ? scaledToArea(cand, orig, anchor) : cand;
            },
            orig,
            idx,
            idy,
            k,
          );
          item.shape.x = next.x;
          item.shape.y = next.y;
          item.shape.width = next.width;
          item.shape.height = next.height;
          item.shape.corners = next.corners;
          item.orig = cloneGeom(next); // re-baseline for the next frame's increment
        }
        requestDraw('scene');
      } else if (mode === 'vertex' && handle) {
        // Move just the one grabbed interior corner; the room becomes a free
        // quadrilateral and width/height/area/centre renormalise around it.
        const item = dragItems[0];
        if (item) {
          const h = handle;
          const orig = item.orig;
          // Anchor at the opposite corner so a locked room scales in place.
          const anchor = orig.areaLocked ? areaLockAnchorWorld(orig, h, true) : null;
          const next = clampDragToConstraints(
            (ddx, ddy) => {
              const cand = moveVertex(orig, cornerIndexForHandle(h), ddx, ddy);
              return anchor ? scaledToArea(cand, orig, anchor) : cand;
            },
            orig,
            idx,
            idy,
            constraintsRef.current,
          );
          item.shape.x = next.x;
          item.shape.y = next.y;
          item.shape.width = next.width;
          item.shape.height = next.height;
          item.shape.corners = next.corners;
          item.orig = cloneGeom(next);
          requestDraw('scene');
        }
      } else if (mode === 'thickness' && handle && thicknessFace) {
        // Single-shape gesture: drag the lit face to retire/grow that wall. With
        // Shift (thicknessAll) the drag stretches every wall's face of that kind at
        // once, insetting/outsetting the whole interior or outer boundary together.
        const minWorld = MIN_SHAPE_SCREEN_SIZE / cam.scale;
        const item = dragItems[0];
        if (item) {
          const h = handle;
          const face = thicknessFace;
          const all = thicknessAll;
          const orig = item.orig;
          const next = clampDragToConstraints(
            (ddx, ddy) =>
              all
                ? resizeAllWalls(orig, h, face, ddx, ddy, MIN_WALL_WORLD, minWorld)
                : resizeWall(orig, h, face, ddx, ddy, MIN_WALL_WORLD, minWorld),
            orig,
            idx,
            idy,
            constraintsRef.current,
          );
          item.shape.x = next.x;
          item.shape.y = next.y;
          item.shape.width = next.width;
          item.shape.height = next.height;
          item.shape.walls = next.walls;
          item.shape.corners = next.corners;
          item.shape.wallEdges = next.wallEdges;
          item.orig = cloneGeom(next);
          requestDraw('scene');
        }
      }

      // Advance the per-frame cursor anchor so the next move's increment (idx/idy) is
      // measured from here — the basis of the continuous, ratcheting constrained drag.
      dragLastX = world.x;
      dragLastY = world.y;
    };

    const onPointerUp = (e: PointerEvent) => {
      // Layers tool: end any edge/cut/corner drag (or pan) cleanly. (Borders arrive via the cube placement,
      // not a drag-to-draw, so there is no in-progress boundary draw to commit here.)
      if (layersActiveRef?.current) {
        // Shift-marquee that began outside the border → add every panel group it swept to the selection.
        if (mode === 'partitionMarquee') {
          const m = marqueeRef.current;
          marqueeRef.current = null;
          if (m && partitionGroupSelRef && partitionDocRef?.current) {
            const layer = partitionActiveLayer(partitionDocRef.current);
            const a = screenToWorld(m.x0, m.y0, cameraRef.current);
            const b = screenToWorld(m.x1, m.y1, cameraRef.current);
            const rect = {
              x: Math.min(a.x, b.x),
              y: Math.min(a.y, b.y),
              w: Math.abs(a.x - b.x),
              h: Math.abs(a.y - b.y),
            };
            const next = new Set(partitionGroupSelRef.current);
            for (const k of partitionGroupKeysInRect(layer, rect)) next.add(k);
            partitionGroupSelRef.current = next;
          }
          mode = 'none';
          try {
            el.releasePointerCapture(e.pointerId);
          } catch {
            // already released; ignore.
          }
          requestDraw('scene');
          updateHoverCursor(e);
          return;
        }

        // Two-border boolean: a clean release (no drag) over the shared interior UNITES the picked borders;
        // over a bounding edge it SUBTRACTS that edge's border from the other. A drag was a pull-apart move
        // (finalized by the borderMove cleanup below), so only fire on a clean click.
        if (pendingBorderBool && partitionDocRef?.current) {
          const bh = pendingBorderBool;
          pendingBorderBool = null;
          if (!draggedSinceDown && partitionBorderSelRef) {
            const layer = partitionActiveLayer(partitionDocRef.current);
            const ok =
              bh.kind === 'union'
                ? unitePartitionBorders(layer, bh.a, bh.b)
                : differencePartitionBorders(layer, bh.target, bh.other);
            if (ok) {
              partitionBorderSelRef.current = new Set();
              if (partitionGroupSelRef) partitionGroupSelRef.current = new Set(); // group keys shift after reshaping
              commitHistory();
            }
            partitionMoveBorder = null;
            partitionMoveOrig = null;
            mode = 'none';
            try {
              el.releasePointerCapture(e.pointerId);
            } catch {
              // already released; ignore.
            }
            requestDraw('scene');
            updateHoverCursor(e);
            return;
          }
        }

        // Edit-a-panel auto-exit: a clean click (not a drag, not on a frame edge) that lands OUTSIDE the
        // border or on a DIFFERENT panel group acts as "Done" and closes the session. Click-drag never exits.
        const wasEditing = !!frameEditRef?.current;
        if (
          wasEditing &&
          e.button === 0 &&
          !draggedSinceDown &&
          mode !== 'partitionFrame' &&
          partitionDocRef?.current
        ) {
          const layer = partitionActiveLayer(partitionDocRef.current);
          const { sx, sy } = localPoint(e);
          const clicked = partitionCellGroupAt(layer, screenToWorld(sx, sy, cameraRef.current));
          if (clicked == null || !frameEditRef?.current?.keys.includes(clicked)) {
            onExitFrameEdit?.();
          }
        }
        // A clean LEFT-click on a panel (no drag) selects its whole material GROUP: plain replaces, Shift
        // toggles; a clean click on empty space clears. A right-click (button ≠ 0) must NOT touch the
        // selection, so the highlight stays visible while the right-click popup is open. (Render-only.)
        if (
          e.button === 0 &&
          partitionGroupSelRef &&
          !draggedSinceDown &&
          !wasEditing && // during (or ending) an Edit session, the click doesn't change the selection
          partitionDocRef?.current
        ) {
          const layer = partitionActiveLayer(partitionDocRef.current);
          const set = partitionGroupSelRef.current;
          if (partitionCellCandidate) {
            const key = partitionCellGroupAt(layer, {
              x: partitionCellCandidate.x,
              y: partitionCellCandidate.y,
            });
            if (key) {
              if (partitionCellCandidate.shift) {
                if (set.has(key)) set.delete(key);
                else set.add(key);
              } else {
                partitionGroupSelRef.current = new Set([key]);
              }
            }
          } else if (!e.shiftKey && set.size) {
            partitionGroupSelRef.current = new Set();
          }
        }
        partitionCellCandidate = null;
        // One undo step per gesture that actually changed the partition (draw, deform, line/segment move,
        // duplicate). Pans and no-op clicks leave it untouched.
        if (partitionMutated) commitHistory();
        partitionMutated = false;
        partitionCorner = null;
        partitionMoveBorder = null;
        partitionMoveOrig = null;
        partitionEdge = null;
        partitionEdgeOrig = null;
        partitionLine = null;
        partitionSeg = null;
        partitionSegExtra = null;
        frameEditSide = null;
        frameEditOrig = null;
        frameEditBorder = null;
        alignGuidesRef.current = null; // drop any line-snap guide
        mode = 'none';
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          // already released; ignore.
        }
        requestDraw('scene');
        updateHoverCursor(e);
        return;
      }

      // Footprint draw: commit the slab if the drag covered a real area; a tiny
      // drag (or a plain click) cancels. Either way the tool disarms (single-shot).
      if (mode === 'footdraw') {
        const d = footprintDraftRef.current;
        footprintDraftRef.current = null;
        footprintArmRef.current = false;
        mode = 'none';
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          // already released; ignore.
        }
        if (d && d.width >= MIN_FOOTPRINT_WORLD && d.height >= MIN_FOOTPRINT_WORLD) {
          footprintsRef.current.push(d);
          commitHistory();
        }
        requestDraw('scene');
        updateHoverCursor(e);
        return;
      }

      if (mode === 'none' && !pendingBoolean && !pendingUnion) return;

      // Next-room prediction fan. A DRAG that releases on an option creates that
      // predicted room and closes the fan. A plain CLICK on the arrow (no drag)
      // instead leaves the fan OPEN, so the user can then click a dot to pick one.
      if (mode === 'predictdrag') {
        const pd = predictionDragRef.current;
        if (pd) {
          if (draggedSinceDown) {
            const option = pd.hovered != null ? pd.options[pd.hovered] : null;
            if (option) createPredictedRoom(pd.shapeId, pd.dir, option);
            predictionDragRef.current = null;
          } else {
            // Click-to-open: keep the fan visible and waiting for a dot click.
            pd.dragging = true;
            pd.hovered = null;
          }
        }
        mode = 'none';
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          // already released; ignore.
        }
        requestDraw('scene');
        updateHoverCursor(e);
        return;
      }

      // Edge-plus duplicate gesture: commit `count` copies in a row (one per
      // room-length the cursor dragged outward; a clean click → 1), then select
      // them. One undo step for the whole batch.
      if (mode === 'plusdrag' && plusDrag) {
        const { shape, dir, count } = plusDrag;
        const { dx, dy } = adjacentCopyOffset(shape, dir);
        const ids: string[] = [];
        // A click-and-drag keeps the original in the resulting multi-selection
        // alongside its copies; a plain click selects just the new copy.
        if (draggedSinceDown) ids.push(shape.id);
        for (let i = 1; i <= count; i++) {
          const copy: Square = {
            ...shape,
            id: createId(),
            walls: { ...shape.walls },
            corners: shape.corners?.map((p) => ({ ...p })),
            wallEdges: shape.wallEdges?.slice(),
            x: shape.x + dx * i,
            y: shape.y + dy * i,
          };
          shapesRef.current.push(copy);
          ids.push(copy.id);
        }
        selectionRef.current = new Set(ids);
        activeEdgeRef.current = null;
        edgePlusHoverRef.current = null;
        plusDrag = null;
        commitHistory();
        mode = 'none';
        dragItems = [];
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          // already released; ignore.
        }
        requestDraw('scene');
        updateHoverCursor(e);
        return;
      }

      // Shared-overlap band, clean click (no drag): trim `target` by subtracting
      // `other`'s footprint, so `target` becomes an N-gon that inherits the
      // not-clicked wall as its new edge. A drag instead pulled the shape apart.
      if (pendingBoolean && !draggedSinceDown) {
        const { target, other } = pendingBoolean;
        pendingBoolean = null;
        const newCorners = differenceCorners(target, other);
        if (newCorners) {
          // Per-edge wall thicknesses BEFORE re-centring (computed in target's local
          // frame); recentre preserves the edge order, so they stay aligned. Kept
          // walls keep their thickness; the new cut edge inherits the other's wall.
          const wallEdges = differenceWallEdges(target, other, newCorners);
          target.corners = newCorners;
          const r = recenterCorners(target);
          target.x = r.x;
          target.y = r.y;
          target.width = r.width;
          target.height = r.height;
          target.corners = r.corners;
          target.wallEdges = wallEdges;
          // Drop the selection so the freshly trimmed rooms read as committed
          // (no lingering edges/overlap cues), like finishing any other edit.
          selectionRef.current = new Set();
          activeEdgeRef.current = null;
          commitHistory();
        }
        mode = 'none';
        handle = null;
        dragItems = [];
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          // already released; ignore.
        }
        requestDraw('scene');
        updateHoverCursor(e);
        return;
      }

      // Interior-overlap region, clean click (no drag): UNION the two rooms into one.
      // `a` absorbs `b` (keeping `a`'s title); each merged edge retains its source
      // room's wall thickness. A drag instead moved the shape (pull-apart).
      if (pendingUnion && !draggedSinceDown) {
        const { a, b } = pendingUnion;
        pendingUnion = null;
        const merged = unionCorners(a, b);
        if (merged) {
          const wallEdges = unionWallEdges(a, b, merged);
          a.corners = merged;
          a.wallEdges = wallEdges;
          const r = recenterCorners(a);
          a.x = r.x;
          a.y = r.y;
          a.width = r.width;
          a.height = r.height;
          a.corners = r.corners;
          // Remove the absorbed room; the merged room is one space with one title.
          shapesRef.current = shapesRef.current.filter((s) => s.id !== b.id);
          selectionRef.current = new Set();
          activeEdgeRef.current = null;
          commitHistory();
        }
        mode = 'none';
        handle = null;
        dragItems = [];
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          // already released; ignore.
        }
        requestDraw('scene');
        updateHoverCursor(e);
        return;
      }

      // Drop a dragged selection onto the Library button → save the arrangement and
      // snap the shapes back where they started (the drag was a "save", not a move).
      if (mode === 'move' && draggedSinceDown && overLibrary) {
        for (const item of dragItems) {
          item.shape.x = item.orig.x;
          item.shape.y = item.orig.y;
        }
        onLibraryDrop?.(dragItems.map((item) => cloneGeom(item.orig)));
        // Clear the selection so the saved cluster reads as "done" — the user
        // shouldn't have to manually deselect after dropping into the Library.
        selectionRef.current = new Set();
        activeEdgeRef.current = null;
        overLibrary = false;
        onLibraryHover?.(false);
        // Settle the shrink animation instantly — the selection is gone, stored.
        libraryShrinkRef.current.scale = 1;
        libraryShrinkRef.current.target = 1;
        mode = 'none';
        dragItems = [];
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          // already released; ignore.
        }
        requestDraw('scene');
        updateHoverCursor(e);
        return;
      }

      if (mode === 'marquee') {
        const m = marqueeRef.current;
        if (m) selectFromMarquee(m, cameraRef.current);
        marqueeRef.current = null;
        activeEdgeRef.current = null; // a marquee selects infills (move target)
        requestDraw('scene');
      }
      // Record one undo step per shape-changing gesture: a real drag in a
      // mutating mode, or an Alt-duplicate (which changes state even without a
      // drag). New gesture types only need to be added to this condition.
      const mutated =
        gestureDuplicated ||
        (draggedSinceDown &&
          (mode === 'move' ||
            mode === 'resize' ||
            mode === 'thickness' ||
            mode === 'rotate' ||
            mode === 'vertex'));
      // A reshape just ended: re-centre each quad on its bounding box (once), so
      // it now rotates about its visual centre like a rectangle. Visually a no-op
      // (the geometry stays put) — only the pivot/extents are normalised.
      if (draggedSinceDown && (mode === 'vertex' || mode === 'resize')) {
        for (const item of dragItems) {
          if (!item.shape.corners) continue;
          const r = recenterCorners(item.shape);
          item.shape.x = r.x;
          item.shape.y = r.y;
          item.shape.width = r.width;
          item.shape.height = r.height;
          item.shape.corners = r.corners;
        }
      }
      if (mutated) commitHistory();

      // A plain click (no drag) dismisses the vertex dots of any shape it landed
      // outside of; a click-and-drag (pan/marquee/move/resize/…) leaves them.
      if (!draggedSinceDown) {
        const { sx, sy } = localPoint(e);
        const clicked = hitTopShape(shapesRef.current, screenToWorld(sx, sy, cameraRef.current));
        let cleared = false;
        for (const s of shapesRef.current) {
          if (s.dots && s !== clicked) {
            s.dots = false;
            cleared = true;
          }
        }
        if (cleared) {
          commitHistory();
          requestDraw('scene');
        }
      }

      // Arm the magenta edge faces on a clean edge click (press + release, no
      // drag), and keep them armed after a thickness drag so the faces stay
      // available for continued adjustment.
      edgeClickArmed = (mode === 'resize' && !draggedSinceDown) || mode === 'thickness';
      // The per-edge wall dimensions follow the same arming: a clean edge click (or a
      // thickness adjustment of an already-armed edge) shows them; any other gesture
      // — a pure resize drag, move, etc. — leaves them off.
      wallDimsArmedRef.current = edgeClickArmed;
      resizingRef.current = false;
      if (rotatingRef.current) {
        rotatingRef.current = null;
        requestDraw('scene'); // clear the angle readout
      }
      mode = 'none';
      handle = null;
      thicknessFace = null;
      thicknessAll = false;
      rotateTarget = null;
      dragItems = [];
      // Drop any wall-alignment guides from the move that just ended.
      if (alignGuidesRef.current) {
        alignGuidesRef.current = null;
        requestDraw('scene');
      }
      snapState = emptySnapState();
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        // pointer may already be released; ignore.
      }
      updateHoverCursor(e);
    };

    // Double-click on a shape's white infill toggles its inner-vertex dots. Disabled
    // while a multi-selection is active — vertex editing is a single-shape gesture, so
    // a double-click on a group of selected rooms shouldn't arm it.
    const onDoubleClick = (e: MouseEvent) => {
      if (selectionRef.current.size > 1) return;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const world = screenToWorld(sx, sy, cameraRef.current);
      const hit = hitTopShape(shapesRef.current, world);
      if (hit) {
        hit.dots = !hit.dots;
        commitHistory();
        requestDraw('scene');
      }
    };

    // Layers tool: right-click a cell → open the split menu for that cell (cols × rows). Default canvas
    // context menu is suppressed only while the tool is active and a boundary exists.
    const onContextMenu = (e: MouseEvent) => {
      if (!layersActiveRef?.current) return;
      const doc = partitionDocRef?.current;
      const layer = doc ? partitionActiveLayer(doc) : null;
      if (!layer || !partitionHasBoundary(layer)) return;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const world = screenToWorld(sx, sy, cameraRef.current);
      const ref = hitPartitionCell(layer, world);
      if (!ref) return; // right-clicked outside every border → fall through to the default menu
      // Right-clicking a cell SELECTS its group (so Edit/Assign target it) and opens the split menu. Works in
      // both Border and Panels mode so panels can be created right after placing a border with the cube.
      const grpKey = partitionCellGroupAt(layer, world);
      if (grpKey && partitionGroupSelRef) partitionGroupSelRef.current = new Set([grpKey]);
      e.preventDefault();
      onCellContextMenu?.({ screenX: e.clientX, screenY: e.clientY, ref, rect: partitionCellRefRect(layer, ref) });
      requestDraw('scene'); // reflect the new selection highlight under the popup
    };

    // Escape cancels an armed placement or the armed/in-progress footprint tool.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (placementRef.current) {
        placementRef.current = null;
        alignGuidesRef.current = null; // drop placement snap guides
        setCursor('grab');
        requestDraw('scene');
      }
      if (footprintArmRef.current || footprintDraftRef.current) {
        footprintArmRef.current = false;
        footprintDraftRef.current = null;
        mode = 'none';
        setCursor('grab');
        requestDraw('scene');
      }
    };

    // Shift pressed/released while hovering an armed edge face toggles the
    // all-faces highlight even when the cursor is stationary.
    const onShiftToggle = (e: KeyboardEvent) => {
      if (e.key !== 'Shift') return;
      const next = e.shiftKey && edgeHoverRef.current !== null;
      if (next !== edgeFaceAllRef.current) {
        edgeFaceAllRef.current = next;
        requestDraw('scene');
      }
    };

    setCursor('grab');
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    el.addEventListener('dblclick', onDoubleClick);
    el.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('resize', refreshRect);
    window.addEventListener('scroll', refreshRect, true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keydown', onShiftToggle);
    window.addEventListener('keyup', onShiftToggle);

    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      el.removeEventListener('dblclick', onDoubleClick);
      el.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('resize', refreshRect);
      window.removeEventListener('scroll', refreshRect, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keydown', onShiftToggle);
      window.removeEventListener('keyup', onShiftToggle);
    };
  }, [
    canvasRef,
    cameraRef,
    shapesRef,
    selectionRef,
    marqueeRef,
    placementRef,
    predictionDragRef,
    footprintsRef,
    footprintArmRef,
    footprintDraftRef,
    libraryShrinkRef,
    commitPlacement,
    beginDimensionEdit,
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
    onCellContextMenu,
    onExitFrameEdit,
  ]);
}
