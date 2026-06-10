import { useEffect, type MutableRefObject, type RefObject } from 'react';
import type { Camera, DrawLayer, Marquee, PendingPlacement, Square } from '../types';
import { screenToWorld } from '../canvas/coords';
import {
  resizeShape,
  resizeWall,
  moveVertex,
  stretchEdge,
  cornerIndexForHandle,
  cursorForHandle,
  edgeFace,
  hitCorner,
  hitCornerDot,
  hitDimensionLabel,
  hitShapeEdge,
  hitTopShape,
  type DimensionLabelHit,
  type EdgeFace,
  type HandleId,
  type HoverRegion,
} from '../canvas/shapes';
import {
  MIN_SHAPE_SCREEN_SIZE,
  MIN_WALL_WORLD,
  ROTATE_CURSOR,
  ROTATION_SNAP_DEG,
} from '../constants';

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
  /** Shape + region under the pointer, for the hover-preview darkening. */
  hoverRef: MutableRefObject<{ id: string; region: HoverRegion } | null>;
  /** True while an edge stretch is dragging (keeps dimensions live). */
  resizingRef: MutableRefObject<boolean>;
  /** Active rubber-band rectangle, or null. */
  marqueeRef: MutableRefObject<Marquee | null>;
  /** Armed placement preview, or null. When set, pointer input places a square. */
  placementRef: MutableRefObject<PendingPlacement | null>;
  /** Commit the armed placement at a canvas-local screen point. */
  commitPlacement: (sx: number, sy: number) => void;
  /** Open the inline editor for a clicked dimension label. */
  beginDimensionEdit: (shapeId: string, hit: DimensionLabelHit) => void;
  /** Snapshot the shapes into undo history after a completed mutation. */
  commitHistory: () => void;
  requestDraw: (layer?: DrawLayer) => void;
}

type Mode = 'none' | 'pan' | 'move' | 'resize' | 'thickness' | 'rotate' | 'marquee' | 'vertex';

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
  hoverRef,
  resizingRef,
  marqueeRef,
  placementRef,
  commitPlacement,
  beginDimensionEdit,
  commitHistory,
  requestDraw,
}: InteractionParams): void {
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    let mode: Mode = 'none';
    let lastClientX = 0;
    let lastClientY = 0;
    let dragStartX = 0; // world-space anchor for move/resize
    let dragStartY = 0;
    let dragItems: DragItem[] = [];
    let handle: HandleId | null = null;
    let thicknessFace: EdgeFace | null = null; // which wall face a thickness drag moves
    let rotateTarget: Square | null = null;
    let rotateStartAngle = 0; // pointer angle at grab (deg)
    let rotateStartRotation = 0; // shape rotation at grab (deg)

    // Click-vs-drag tracking. The magenta edge faces are armed only by a clean
    // click on an edge (press + release with no drag) — never by the release
    // that ends a stretch — so finishing a drag never makes them flash.
    let pressClientX = 0;
    let pressClientY = 0;
    let draggedSinceDown = false;
    let edgeClickArmed = false;
    let gestureDuplicated = false; // an Alt-drag copy was made this gesture
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
      }));
      for (const copy of copies) shapesRef.current.push(copy);
      selectionRef.current = new Set(copies.map((c) => c.id));
    };

    const snapshotSelection = (world: { x: number; y: number }) => {
      dragStartX = world.x;
      dragStartY = world.y;
      dragItems = selectedShapes().map((s) => ({
        shape: s,
        orig: { ...s, walls: { ...s.walls }, corners: s.corners?.map((p) => ({ ...p })) },
      }));
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
      const { sx, sy } = localPoint(e);
      const cam = cameraRef.current;
      const single = singleSelected();
      let redraw = false;

      // Magenta face highlight: only when a single shape has a deliberately
      // selected edge and the pointer is over that same edge's band. Light just
      // the one face (inner or outer) the cursor is nearer.
      const active = activeEdgeRef.current;
      const overActiveEdge =
        edgeClickArmed &&
        !!single &&
        !single.dots &&
        active !== null &&
        hitShapeEdge(sx, sy, single, cam) === active;
      const face: EdgeFace | null =
        overActiveEdge && single && active ? edgeFace(sx, sy, single, cam, active) : null;
      if (face !== edgeHoverRef.current) {
        edgeHoverRef.current = face;
        redraw = true;
      }

      // Hover-preview region: which shape + region the pointer is over, mirroring
      // what a click would act on (selection edges, then any edge, then a body).
      // Edges of a dots-enabled shape aren't stretch targets (the vertices are),
      // so they don't hover-darken or show a resize cursor; quad edges do.
      const hitEdgeRaw = hitSelectionEdge(sx, sy, cam) ?? hitAnyEdge(sx, sy, cam);
      const hitEdge = hitEdgeRaw && !hitEdgeRaw.shape.dots ? hitEdgeRaw : null;
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

      if (redraw) requestDraw('scene');

      if (e.shiftKey) return setCursor('crosshair'); // hint marquee
      if (single && !single.dots && hitCorner(sx, sy, single, cam)) {
        return setCursor(ROTATE_CURSOR);
      }
      // A visible vertex dot is draggable to reshape the room. It uses the plain
      // default pointer (not the resize double-arrow) to read as "grab this point".
      const dotHover = hitAnyVertexDot(sx, sy, cam);
      if (dotHover) return setCursor('default');
      // A dimension label of the infill-selected shape is editable on click.
      if (single && active === null && hitDimensionLabel(sx, sy, single, cam)) {
        return setCursor('text');
      }
      if (hitEdge) return setCursor(cursorForHandle(hitEdge.handle, hitEdge.shape.rotation));
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
      pressClientX = e.clientX;
      pressClientY = e.clientY;
      edgeClickArmed = false;
      edgeHoverRef.current = null;

      // 0) Armed placement → click commits the preview as a real square.
      if (placementRef.current) {
        commitPlacement(sx, sy);
        setCursor('move');
        return;
      }

      // 1) Shift → rubber-band marquee selection.
      if (e.shiftKey) {
        mode = 'marquee';
        marqueeRef.current = { x0: sx, y0: sy, x1: sx, y1: sy };
        setCursor('crosshair');
        el.setPointerCapture(e.pointerId);
        return;
      }

      const world = screenToWorld(sx, sy, cam);

      // 2) Corner of a single selection → rotate about the centre.
      const single = singleSelected();

      // 1.5) Click a dimension label of the infill-selected shape → edit it.
      //      preventDefault keeps the press from moving focus off the editor
      //      input that's about to mount.
      if (single && activeEdgeRef.current === null) {
        const dimHit = hitDimensionLabel(sx, sy, single, cam);
        if (dimHit) {
          e.preventDefault();
          beginDimensionEdit(single.id, dimHit);
          return;
        }
      }

      // While a shape's editable vertices are showing, its rotation knob is
      // disabled so grabbing a corner reshapes (via the dot) instead of rotating.
      if (single && !single.dots && hitCorner(sx, sy, single, cam)) {
        mode = 'rotate';
        rotateTarget = single;
        const cx = single.x + single.width / 2;
        const cy = single.y + single.height / 2;
        rotateStartAngle = Math.atan2(world.y - cy, world.x - cx) * (180 / Math.PI);
        rotateStartRotation = single.rotation;
        setCursor(ROTATE_CURSOR);
        el.setPointerCapture(e.pointerId);
        return;
      }

      // 2.5) A magenta face of an armed selected edge → drag to change that
      //      wall's thickness (inner or outer face, whichever was lit).
      const activeEdge = activeEdgeRef.current;
      if (grabbedFace && activeEdge && single) {
        mode = 'thickness';
        handle = activeEdge;
        thicknessFace = grabbedFace;
        snapshotSelection(world);
        setCursor(cursorForHandle(activeEdge, single.rotation));
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
      // Edge-stretching is disabled only while a shape shows its editable
      // vertices, so a grab near a wall doesn't fight the vertex reshape (the dot
      // itself was handled in 2.7). Free-form quads stretch by edge just like
      // rectangles do.
      const edge = hitSelectionEdge(sx, sy, cam) ?? hitAnyEdge(sx, sy, cam);
      if (edge && !edge.shape.dots) {
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
        snapshotSelection(world);
        setCursor(cursorForHandle(edge.handle, edge.shape.rotation));
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
      // Armed placement → the preview tracks the cursor.
      if (placementRef.current) {
        const { sx, sy } = localPoint(e);
        placementRef.current.sx = sx;
        placementRef.current.sy = sy;
        setCursor('crosshair');
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

      const cam = cameraRef.current;

      if (mode === 'pan') {
        cam.x += e.clientX - lastClientX;
        cam.y += e.clientY - lastClientY;
        lastClientX = e.clientX;
        lastClientY = e.clientY;
        requestDraw('all'); // shapes move with the camera, so both layers
        return;
      }

      if (mode === 'marquee') {
        const { sx, sy } = localPoint(e);
        const m = marqueeRef.current;
        if (m) {
          m.x1 = sx;
          m.y1 = sy;
          requestDraw('scene');
        }
        return;
      }

      const { sx, sy } = localPoint(e);
      const world = screenToWorld(sx, sy, cam);

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

      const dx = world.x - dragStartX;
      const dy = world.y - dragStartY;

      if (mode === 'move') {
        for (const item of dragItems) {
          item.shape.x = item.orig.x + dx;
          item.shape.y = item.orig.y + dy;
        }
        requestDraw('scene'); // grid is static — only the scene changed
      } else if (mode === 'resize' && handle) {
        const minWorld = MIN_SHAPE_SCREEN_SIZE / cam.scale;
        for (const item of dragItems) {
          // A free-form quad stretches by translating the whole grabbed edge; a
          // rectangle stretches axis-locked so it stays rectangular.
          const next = item.orig.corners
            ? stretchEdge(item.orig, handle, dx, dy)
            : resizeShape(item.orig, handle, dx, dy, minWorld);
          item.shape.x = next.x;
          item.shape.y = next.y;
          item.shape.width = next.width;
          item.shape.height = next.height;
          item.shape.corners = next.corners;
        }
        requestDraw('scene');
      } else if (mode === 'vertex' && handle) {
        // Move just the one grabbed interior corner; the room becomes a free
        // quadrilateral and width/height/area/centre renormalise around it.
        const item = dragItems[0];
        if (item) {
          const next = moveVertex(item.orig, cornerIndexForHandle(handle), dx, dy);
          item.shape.x = next.x;
          item.shape.y = next.y;
          item.shape.width = next.width;
          item.shape.height = next.height;
          item.shape.corners = next.corners;
          requestDraw('scene');
        }
      } else if (mode === 'thickness' && handle && thicknessFace) {
        // Single-shape gesture: drag the lit face to retire/grow that wall.
        const minWorld = MIN_SHAPE_SCREEN_SIZE / cam.scale;
        const item = dragItems[0];
        if (item) {
          const next = resizeWall(item.orig, handle, thicknessFace, dx, dy, MIN_WALL_WORLD, minWorld);
          item.shape.x = next.x;
          item.shape.y = next.y;
          item.shape.width = next.width;
          item.shape.height = next.height;
          item.shape.walls = next.walls;
          requestDraw('scene');
        }
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      if (mode === 'none') return;
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
      resizingRef.current = false;
      mode = 'none';
      handle = null;
      thicknessFace = null;
      rotateTarget = null;
      dragItems = [];
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        // pointer may already be released; ignore.
      }
      updateHoverCursor(e);
    };

    // Double-click on a shape's white infill toggles its inner-vertex dots.
    const onDoubleClick = (e: MouseEvent) => {
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

    // Escape cancels an armed placement.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && placementRef.current) {
        placementRef.current = null;
        setCursor('grab');
        requestDraw('scene');
      }
    };

    setCursor('grab');
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    el.addEventListener('dblclick', onDoubleClick);
    window.addEventListener('resize', refreshRect);
    window.addEventListener('scroll', refreshRect, true);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      el.removeEventListener('dblclick', onDoubleClick);
      window.removeEventListener('resize', refreshRect);
      window.removeEventListener('scroll', refreshRect, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [
    canvasRef,
    cameraRef,
    shapesRef,
    selectionRef,
    marqueeRef,
    placementRef,
    commitPlacement,
    beginDimensionEdit,
    commitHistory,
    requestDraw,
  ]);
}
