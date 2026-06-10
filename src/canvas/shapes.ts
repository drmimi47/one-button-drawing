import type { Camera, Marquee, ShapeTheme, Square, Walls } from '../types';
import { worldToScreen, type Vec2 } from './coords';
import {
  AREA_LABEL_FADE_END,
  AREA_LABEL_FADE_START,
  AREA_LABEL_FONT_PX,
  DEFAULT_WALL_WORLD,
  EDGE_HIT_TOLERANCE,
  ROTATION_CORNER_RADIUS,
  WORLD_UNITS_PER_FOOT,
} from '../constants';

/** A fresh per-side wall set, every side at the 6" default thickness. */
export function defaultWalls(): Walls {
  return { n: DEFAULT_WALL_WORLD, e: DEFAULT_WALL_WORLD, s: DEFAULT_WALL_WORLD, w: DEFAULT_WALL_WORLD };
}

/** Garamond-first stack, mirroring the app's global font. */
const LABEL_FONT_STACK = "Garamond, 'EB Garamond', 'Times New Roman', Georgia, serif";

/** Dimension labels match the square-footage readout's on-screen size. */
const DIMENSION_FONT_PX = AREA_LABEL_FONT_PX;

/** How far the outside dimension brackets + labels reach beyond a wall, px. */
const DIMENSION_REACH = 80;

/** Distance from the outer wall to a dimension bracket line, px. */
const DIMENSION_GAP = 36;

/** Text offset outside the bracket line, px. */
const DIMENSION_LABEL_GAP = 11;

/** Half-extent of the oblique architect's tick, px (also its bounding-box reach). */
const TICK_HALF = 4;

/**
 * Optional AutoCAD-style oblique "/" tick where each dimension line meets its
 * extension lines. Off by default; flip to `true` to show the ticks.
 */
const SHOW_DIMENSION_TICKS = false;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Live square-footage readout, e.g. "144 ft²". A decimal is shown only when the
 * value isn't whole (rounded to one place): "144 ft²" vs "150.5 ft²".
 */
function formatArea(shape: Square): string {
  // True polygon area (shoelace), so a reshaped quad reads its actual footage.
  const sqFeet = polygonAreaWorld(localCorners(shape)) / (WORLD_UNITS_PER_FOOT * WORLD_UNITS_PER_FOOT);
  const area = Math.round(sqFeet * 10) / 10;
  const value = Number.isInteger(area) ? `${area}` : area.toFixed(1);
  return `${value} ft²`;
}

/** The numeric part of a feet measurement, e.g. 120 → "12" (one decimal if needed). */
function feetValue(worldLen: number): string {
  const feet = Math.round((worldLen / WORLD_UNITS_PER_FOOT) * 10) / 10;
  return Number.isInteger(feet) ? `${feet}` : feet.toFixed(1);
}

/** A feet measurement with the prime foot mark, e.g. 120 → "12′". */
function formatFeet(worldLen: number): string {
  return `${feetValue(worldLen)}′`;
}

/** Fixed gap (px) drawn between the number and the foot mark. */
const DIMENSION_PRIME_GAP = 2;

/**
 * Draws a feet measurement centred at the current origin, with the number and
 * the prime (foot mark) placed by hand with a fixed gap. Drawing the two glyphs
 * explicitly — rather than relying on the font's tight spacing — keeps the mark
 * from looking cramped and renders identically whatever the rotation. Assumes
 * the dimension font and `textBaseline = 'middle'` are already set.
 */
function drawFeetLabel(ctx: CanvasRenderingContext2D, worldLen: number): void {
  const num = feetValue(worldLen);
  const prime = '′';
  const prevAlign = ctx.textAlign;
  ctx.textAlign = 'left';
  const numW = ctx.measureText(num).width;
  const primeW = ctx.measureText(prime).width;
  const total = numW + DIMENSION_PRIME_GAP + primeW;
  const startX = -total / 2; // centre the number + gap + prime on the origin
  ctx.fillText(num, startX, 0);
  ctx.fillText(prime, startX + numW + DIMENSION_PRIME_GAP, 0);
  ctx.textAlign = prevAlign;
}

/** The eight resize handles: corners and edge midpoints. */
export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** A wall's two faces: the interior-facing line vs. the outer boundary line. */
export type EdgeFace = 'inner' | 'outer';

/** A region of a shape the pointer can be over: a wall edge, or the infill. */
export type HoverRegion = HandleId | 'infill';

const DEG2RAD = Math.PI / 180;

/** Snap to a half-pixel so a 1px stroke stays crisp. */
const snap = (v: number): number => Math.round(v) + 0.5;

/** Corner order shared everywhere: top-left, top-right, bottom-right, bottom-left. */
const CORNER_HANDLES = ['nw', 'ne', 'se', 'sw'] as const;
/** Which polygon edge (corner i → i+1) each wall side runs along. */
const SIDE_EDGE: Record<'n' | 'e' | 's' | 'w', number> = { n: 0, e: 1, s: 2, w: 3 };

/**
 * The room's four interior corners in the LOCAL frame (centre-origin,
 * pre-rotation, world units), ordered [nw, ne, se, sw]. A free-form shape stores
 * these directly; a plain rectangle derives them from width/height.
 */
function localCorners(shape: Square): Vec2[] {
  if (shape.corners && shape.corners.length === 4) {
    return shape.corners.map((p) => ({ x: p.x, y: p.y }));
  }
  const hw = shape.width / 2;
  const hh = shape.height / 2;
  return [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ];
}

/** Intersection of line (p + t·r) and line (q + u·s), or null if parallel. */
function lineIntersect(p: Vec2, r: Vec2, q: Vec2, s: Vec2): Vec2 | null {
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < 1e-6) return null;
  const t = ((q.x - p.x) * s.y - (q.y - p.y) * s.x) / denom;
  return { x: p.x + t * r.x, y: p.y + t * r.y };
}

/**
 * The outer (wall) corners for an interior polygon, each edge pushed outward
 * along its normal by that side's thickness and adjacent offset edges mitered at
 * their intersection. `thick` is indexed by edge (n, e, s, w). Reduces exactly to
 * the offset rectangle when the interior is a rect.
 */
function outerCorners(iPts: Vec2[], thick: number[]): Vec2[] {
  const n = iPts.length;
  // Outward normal of each edge i (iPts[i] → iPts[i+1]); the corner winding is
  // clockwise in screen space (y down), so the outward normal is (dy, -dx).
  const normals = iPts.map((a, i) => {
    const b = iPts[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dy / len, y: -dx / len };
  });
  return iPts.map((corner, i) => {
    const prev = (i + n - 1) % n; // edge ending at this corner
    const next = i; // edge leaving this corner
    const pPoint = {
      x: corner.x + thick[prev] * normals[prev].x,
      y: corner.y + thick[prev] * normals[prev].y,
    };
    const pDir = { x: corner.x - iPts[prev].x, y: corner.y - iPts[prev].y };
    const nPoint = {
      x: corner.x + thick[next] * normals[next].x,
      y: corner.y + thick[next] * normals[next].y,
    };
    const nDir = { x: iPts[(i + 1) % n].x - corner.x, y: iPts[(i + 1) % n].y - corner.y };
    return lineIntersect(pPoint, pDir, nPoint, nDir) ?? pPoint;
  });
}

/** Signed-area (shoelace) magnitude of a local polygon, in world units². */
function polygonAreaWorld(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/**
 * Area centroid of a shape's interior, in its LOCAL frame (relative to the
 * centre). For a rectangle this is (0,0); for a reshaped quad it's the true
 * polygon centroid, so the area readout sits at the visual middle of the room.
 */
function shapeCentroidLocal(shape: Square): Vec2 {
  const pts = localCorners(shape);
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const cross = p.x * q.y - q.x * p.y;
    a += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  if (Math.abs(a) < 1e-6) return { x: 0, y: 0 }; // degenerate → fall back to centre
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/** Ray-cast point-in-polygon test (point and polygon in the same frame). */
function pointInPolygon(pt: Vec2, pts: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    const straddles = a.y > pt.y !== b.y > pt.y;
    if (straddles && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Corner handle (nw/ne/se/sw) → its index in the [nw,ne,se,sw] corner order. */
export function cornerIndexForHandle(handle: HandleId): number {
  const i = (CORNER_HANDLES as readonly string[]).indexOf(handle);
  return i < 0 ? 0 : i;
}

/** World-space outward unit normal of interior edge `e` (corner e → e+1). */
function edgeNormalWorld(shape: Square, e: number): Vec2 {
  const pts = localCorners(shape);
  const a = pts[e];
  const b = pts[(e + 1) % pts.length];
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const len = Math.hypot(ex, ey) || 1;
  const lnx = ey / len; // local outward normal (clockwise winding, y-down)
  const lny = -ex / len;
  const t = shape.rotation * DEG2RAD;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  return { x: lnx * cos - lny * sin, y: lnx * sin + lny * cos };
}

/**
 * Moves a set of interior corners by the same world-space delta, so the room
 * becomes a free quadrilateral. The drag is mapped into the local frame and the
 * corners are stored relative to the UNCHANGED centre. Keeping the centre fixed
 * is what stops the shape jittering: the render rounds the centre and each corner
 * separately, so a centre that shifted every frame would make the anchored
 * corners wobble ±1px under the double-rounding. width/height bound the corners
 * symmetrically about the centre, which keeps culling/marquee correct.
 */
function moveCorners(
  original: Square,
  indices: number[],
  worldDx: number,
  worldDy: number,
): Square {
  const t = original.rotation * DEG2RAD;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const ldx = worldDx * cos + worldDy * sin;
  const ldy = -worldDx * sin + worldDy * cos;

  const pts = localCorners(original);
  for (const index of indices) {
    pts[index] = { x: pts[index].x + ldx, y: pts[index].y + ldy };
  }
  return finalizeCorners(original, pts);
}

/**
 * Rebuilds a Square from a new set of LOCAL corners while holding the centre
 * fixed (so anchored corners stay pixel-stable — see moveCorners). width/height
 * are symmetric half-extents about the centre, keeping the AABB a valid bound.
 */
function finalizeCorners(original: Square, pts: Vec2[]): Square {
  let maxX = 0;
  let maxY = 0;
  for (const p of pts) {
    maxX = Math.max(maxX, Math.abs(p.x));
    maxY = Math.max(maxY, Math.abs(p.y));
  }
  const newW = maxX * 2;
  const newH = maxY * 2;
  const cx = original.x + original.width / 2;
  const cy = original.y + original.height / 2;
  return {
    ...original,
    x: cx - newW / 2,
    y: cy - newH / 2,
    width: newW,
    height: newH,
    corners: pts,
  };
}

/** Moves a single interior corner by a world delta (free-form vertex drag). */
export function moveVertex(
  original: Square,
  index: number,
  worldDx: number,
  worldDy: number,
): Square {
  return moveCorners(original, [index], worldDx, worldDy);
}

/**
 * Stretches one side of a free-form quad. The edge is offset along its own
 * outward normal by the perpendicular drag, then its two endpoints slide ALONG
 * the two adjacent edges' lines (kept on their original directions). So the
 * neighbouring edges only grow or shrink — they don't change angle — and the two
 * far corners stay anchored. Pulling toward where those lines would meet shortens
 * the edge; pulling the other way lengthens it. (Rectangles use `resizeShape`,
 * staying rectangular.)
 */
/**
 * New positions for edge `e`'s two endpoints when that edge is offset along its
 * outward normal by `perp` (local units): the endpoints slide along the two
 * adjacent edge lines (kept on their original directions), so the neighbouring
 * edges only lengthen/shorten. Falls back to a plain perpendicular move if an
 * adjacent edge is parallel to this one.
 */
function offsetEdgeEndpoints(pts: Vec2[], e: number, perp: number): { p0: Vec2; p1: Vec2 } {
  const i0 = e;
  const i1 = (e + 1) % 4;
  const iPrev = (e + 3) % 4;
  const iNext = (e + 2) % 4;
  const dEx = pts[i1].x - pts[i0].x;
  const dEy = pts[i1].y - pts[i0].y;
  const len = Math.hypot(dEx, dEy) || 1;
  const nEx = dEy / len; // outward (clockwise winding, y-down)
  const nEy = -dEx / len;
  const off = { x: pts[i0].x + nEx * perp, y: pts[i0].y + nEy * perp };
  const dE = { x: dEx, y: dEy };
  const dPrev = { x: pts[i0].x - pts[iPrev].x, y: pts[i0].y - pts[iPrev].y };
  const dNext = { x: pts[i1].x - pts[iNext].x, y: pts[i1].y - pts[iNext].y };
  const p0 = lineIntersect(pts[iPrev], dPrev, off, dE) ?? off;
  const p1 =
    lineIntersect(pts[iNext], dNext, off, dE) ?? { x: pts[i1].x + nEx * perp, y: pts[i1].y + nEy * perp };
  return { p0, p1 };
}

export function stretchEdge(
  original: Square,
  handle: HandleId,
  worldDx: number,
  worldDy: number,
): Square {
  const e = SIDE_EDGE[handle as 'n' | 'e' | 's' | 'w'];
  const pts = localCorners(original);
  const i0 = e;
  const i1 = (e + 1) % 4;

  // Edge outward normal (local), and the drag projected onto it.
  const dEx = pts[i1].x - pts[i0].x;
  const dEy = pts[i1].y - pts[i0].y;
  const len = Math.hypot(dEx, dEy) || 1;
  const nEx = dEy / len;
  const nEy = -dEx / len;
  const t = original.rotation * DEG2RAD;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const ldx = worldDx * cos + worldDy * sin;
  const ldy = -worldDx * sin + worldDy * cos;
  const perp = ldx * nEx + ldy * nEy;

  const { p0, p1 } = offsetEdgeEndpoints(pts, e, perp);
  const next = pts.slice();
  next[i0] = p0;
  next[i1] = p1;
  return finalizeCorners(original, next);
}

/**
 * Sets one quad edge to an exact length (world units) by typing its dimension.
 * The edge keeps its direction and slides along its two neighbours' lines (as in
 * `stretchEdge`); since the edge length varies linearly with the perpendicular
 * offset, one slope sample solves the needed offset directly. A parallelogram
 * side whose length can't change by sliding is left unchanged.
 */
export function setEdgeLength(
  original: Square,
  handle: HandleId,
  targetWorldLen: number,
): Square {
  const e = SIDE_EDGE[handle as 'n' | 'e' | 's' | 'w'];
  const pts = localCorners(original);
  const i0 = e;
  const i1 = (e + 1) % 4;
  const l0 = Math.hypot(pts[i1].x - pts[i0].x, pts[i1].y - pts[i0].y);
  if (l0 < 1e-6) return original;
  if (Math.abs(targetWorldLen - l0) < 1e-6) return original; // already that length

  const eps = 1;
  const sample = offsetEdgeEndpoints(pts, e, eps);
  const lEps = Math.hypot(sample.p1.x - sample.p0.x, sample.p1.y - sample.p0.y);
  const k = (lEps - l0) / eps;
  if (Math.abs(k) < 1e-6) return original; // length independent of the offset

  const perp = (targetWorldLen - l0) / k;
  const { p0, p1 } = offsetEdgeEndpoints(pts, e, perp);
  const next = pts.slice();
  next[i0] = p0;
  next[i1] = p1;
  return finalizeCorners(original, next);
}

/** Pointer expressed in a shape's local (un-rotated, centre-origin) screen frame. */
interface LocalFrame {
  lx: number;
  ly: number;
  /** Half-extents of the shape in screen pixels. */
  hw: number;
  hh: number;
}

function localScreenFrame(
  screenX: number,
  screenY: number,
  shape: Square,
  camera: Camera,
): LocalFrame {
  const c = worldToScreen(shape.x + shape.width / 2, shape.y + shape.height / 2, camera);
  const dx = screenX - c.x;
  const dy = screenY - c.y;
  const a = -shape.rotation * DEG2RAD;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return {
    lx: dx * cos - dy * sin,
    ly: dx * sin + dy * cos,
    hw: (shape.width * camera.scale) / 2,
    hh: (shape.height * camera.scale) / 2,
  };
}

export interface DrawShapesParams {
  ctx: CanvasRenderingContext2D;
  shapes: Square[];
  camera: Camera;
  selectedIds: Set<string>;
  /**
   * The selection's active region. A handle id darkens just that one wall edge;
   * `null` (with a non-empty selection) darkens the white infill instead.
   */
  activeHandle: HandleId | null;
  /**
   * Which face of the active edge to pick out in magenta — `'inner'` or
   * `'outer'`, whichever the pointer is nearer — or `null` when not hovering it.
   * Only one face lights at a time, and only for a single selected edge.
   */
  activeEdgeFace: EdgeFace | null;
  /**
   * The shape the pointer is currently over, and which region of it. Mirrors the
   * selected-state darkening as a hover preview — the infill or the hovered edge
   * darkens — so a shape reads as ready to move/stretch before any click.
   */
  hoverId: string | null;
  hoverRegion: HoverRegion | null;
  /**
   * True while an edge stretch is in progress AND dimensions were already
   * showing (the shape was infill-selected) when it began. Keeps the dimension
   * lines visible and live-updating through the drag; a stretch started on the
   * edge of a non-dim shape leaves this false, so no dimensions appear.
   */
  resizing: boolean;
  width: number;
  height: number;
  theme: ShapeTheme;
}

/**
 * Draws every square (z-order = array order), each rotated about its centre.
 * Selected squares get the emphasised outline. No visible resize/rotate
 * handles are drawn — stretching (edges) and rotating (corners) are discovered
 * via the cursor alone.
 */
export function drawShapes({
  ctx,
  shapes,
  camera,
  selectedIds,
  activeHandle,
  activeEdgeFace,
  hoverId,
  hoverRegion,
  resizing,
  width,
  height,
  theme,
}: DrawShapesParams): void {
  for (const shape of shapes) {
    const c = worldToScreen(shape.x + shape.width / 2, shape.y + shape.height / 2, camera);
    const wS = shape.width * camera.scale;
    const hS = shape.height * camera.scale;
    // Per-side wall thickness in screen pixels.
    const tN = shape.walls.n * camera.scale;
    const tE = shape.walls.e * camera.scale;
    const tS = shape.walls.s * camera.scale;
    const tW = shape.walls.w * camera.scale;

    // Fade shared by the area readout and the dimension lines: both ease out
    // together as the shape gets too small on screen to read.
    const shortSide = Math.min(wS, hS);
    const labelAlpha = clamp01(
      (shortSide - AREA_LABEL_FADE_START) / (AREA_LABEL_FADE_END - AREA_LABEL_FADE_START),
    );

    const selected = selectedIds.has(shape.id);
    const isRect = !shape.corners;
    const singleSel = selected && selectedIds.size === 1;
    // A rectangle shows its two width/height brackets (live during a stretch); a
    // reshaped quad shows one bracket per side (live during a vertex drag). Either
    // way only for a lone infill-selected shape.
    const dimsRect = isRect && singleSel && (!activeHandle || resizing);
    const dimsPoly = !isRect && singleSel;
    const showDims = dimsRect || dimsPoly;

    // Cull, with a margin for the outward wall band and the stroke — plus extra
    // reach for the dimension brackets that sit outside the shape, when shown.
    const reach =
      Math.hypot(wS, hS) / 2 + Math.max(tN, tE, tS, tW) + 2 + (showDims ? DIMENSION_REACH : 0);
    if (c.x + reach < 0 || c.y + reach < 0 || c.x - reach > width || c.y - reach > height) {
      continue;
    }

    const rot = shape.rotation * DEG2RAD;
    const cosR = Math.cos(rot);
    const sinR = Math.sin(rot);
    const rcx = Math.round(c.x);
    const rcy = Math.round(c.y);

    ctx.save();
    ctx.translate(rcx, rcy);
    ctx.rotate(rot);

    // Snap a scaled-local point to a whole pixel in ABSOLUTE screen space, then
    // express it back in this translated+rotated frame. Snapping the absolute
    // position (rather than rounding the centre and the local offset separately)
    // keeps anchored corners pixel-stable while the centre slides during a
    // stretch — and is computed from the EXACT (unrounded) geometry so a moving
    // neighbour can't make an anchored corner's wall miter flicker.
    const stab = (lsx: number, lsy: number): Vec2 => {
      const ax = c.x + lsx * cosR - lsy * sinR;
      const ay = c.y + lsx * sinR + lsy * cosR;
      const dx = Math.round(ax) - rcx;
      const dy = Math.round(ay) - rcy;
      return { x: dx * cosR + dy * sinR, y: -dx * sinR + dy * cosR };
    };

    // Interior corners (exact, then stabilised). For a rect these are the
    // familiar axis-aligned points; for a reshaped quad, the four free vertices.
    const iExact = localCorners(shape).map((p) => ({
      x: p.x * camera.scale,
      y: p.y * camera.scale,
    }));
    const iPts: Vec2[] = iExact.map((p) => stab(p.x, p.y));
    // Outer (wall) corners: each interior edge offset outward by its side's
    // thickness, mitered at the corners (n, e, s, w) — built from the exact inner
    // points so the miters stay steady, then stabilised the same way.
    const oPts = outerCorners(iExact, [tN, tE, tS, tW]).map((p) => stab(p.x, p.y));

    // Convenience for the rectangle-only dimension block further down.
    const left = iPts[0].x;
    const top = iPts[0].y;
    const iRight = iPts[2].x;
    const iBottom = iPts[2].y;
    const oLeft = oPts[0].x;
    const oBottom = oPts[2].y;

    const polyPath = (pts: Vec2[]) => {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
      ctx.closePath();
    };

    // [x0,y0,x1,y1] of one side's inner (interior-facing) or outer face line.
    // Shared by the always-on white border and the magenta hover highlight.
    const faceLine = (hdl: HandleId, face: EdgeFace): [number, number, number, number] => {
      const e = SIDE_EDGE[hdl as 'n' | 'e' | 's' | 'w'];
      const pts = face === 'inner' ? iPts : oPts;
      const a = pts[e];
      const b = pts[(e + 1) % 4];
      return [a.x, a.y, b.x, b.y];
    };

    // An edge reads darker when it's the selected region OR is being hovered;
    // the infill darkens when it's the selected region OR is being hovered.
    const hovered = shape.id === hoverId;
    const hoverEdge: HandleId | null =
      hovered && hoverRegion && hoverRegion !== 'infill' ? hoverRegion : null;
    const darkEdges: HandleId[] = [];
    if (selected && activeHandle) darkEdges.push(activeHandle);
    if (hoverEdge && hoverEdge !== activeHandle) darkEdges.push(hoverEdge);

    // Walls in the base shade (whole band), then overdraw each darkened side's
    // strip (the quad between that side's inner and outer edges).
    ctx.fillStyle = theme.stroke;
    polyPath(oPts);
    ctx.fill();
    if (darkEdges.length > 0) {
      ctx.fillStyle = theme.selectedStroke;
      for (const hdl of darkEdges) {
        const e = SIDE_EDGE[hdl as 'n' | 'e' | 's' | 'w'];
        polyPath([iPts[e], iPts[(e + 1) % 4], oPts[(e + 1) % 4], oPts[e]]);
        ctx.fill();
      }
    }

    // Interior darkened when the infill is the selected region (move) or hovered.
    const infillDark = (selected && !activeHandle) || (hovered && hoverRegion === 'infill');
    ctx.fillStyle = infillDark ? theme.selectedFill : theme.fill;
    polyPath(iPts);
    ctx.fill();

    // Thin white border on every side's inner and outer face — together the
    // inner faces read as a white frame inside the grey band, the outer faces as
    // one outside it. Always on; the magenta highlight later draws over the top.
    ctx.strokeStyle = '#ffffff'; // white edge face-lines
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const hdl of ['n', 's', 'e', 'w'] as const) {
      for (const face of ['inner', 'outer'] as const) {
        const [x0, y0, x1, y1] = faceLine(hdl, face);
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
      }
    }
    ctx.stroke();

    // Optional dots centred exactly on the four interior vertices (draggable to
    // reshape). Toggled by double-click.
    if (shape.dots) {
      const r = VERTEX_DOT_RADIUS;
      ctx.fillStyle = theme.label;
      ctx.strokeStyle = '#ffffff'; // matches the white edge face-lines
      ctx.lineWidth = 1;
      for (const p of iPts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    // Hovering a single selected edge picks out just ONE of that wall's faces —
    // whichever (inner or outer) the cursor is nearer — in magenta.
    if (selected && activeHandle && activeEdgeFace && selectedIds.size === 1) {
      const line = faceLine(activeHandle, activeEdgeFace);
      ctx.strokeStyle = theme.edgeHover;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(line[0], line[1]);
      ctx.lineTo(line[2], line[3]);
      ctx.stroke();
    }

    // Dimension lines: drawn OUTSIDE the shape (beyond the walls) as "[" style
    // brackets whose end feet point in toward the shape. They span the interior
    // extent (walls excluded) and live in the rotated frame, so they stay
    // aligned at any angle. Skipped when too small to read.
    if (dimsRect && labelAlpha > 0) {
      const gap = DIMENSION_GAP;
      const labelGap = DIMENSION_LABEL_GAP;
      // Both the dimension line (spine) and the extension lines overshoot each
      // corner by `ext` — equal-length crossing stubs at all four corners.
      const ext = TICK_HALF * 2.5;
      const cx2 = (left + iRight) / 2;
      const cy2 = (top + iBottom) / 2;
      ctx.globalAlpha = labelAlpha; // fade out with the area readout when small

      ctx.strokeStyle = theme.label;
      ctx.lineWidth = 1;
      ctx.font = `${DIMENSION_FONT_PX}px ${LABEL_FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      // Vertical bracket on the LEFT — measures interior height; its feet run all
      // the way in to the white infill's left edge.
      const vx = oLeft - gap;
      ctx.beginPath();
      // Dimension line overshoots each corner by `ext`...
      ctx.moveTo(vx + 0.5, top - ext + 0.5);
      ctx.lineTo(vx + 0.5, iBottom + ext + 0.5);
      // ...and the extension lines overshoot it by the same `ext`, so the two
      // cross with equal-length stubs at each corner.
      ctx.moveTo(vx - ext + 0.5, top + 0.5);
      ctx.lineTo(left + 0.5, top + 0.5);
      ctx.moveTo(vx - ext + 0.5, iBottom + 0.5);
      ctx.lineTo(left + 0.5, iBottom + 0.5);
      ctx.stroke();

      // Horizontal bracket on the BOTTOM — measures interior width; its feet run
      // all the way up to the white infill's bottom edge.
      const hy = oBottom + gap;
      ctx.beginPath();
      // Dimension line overshoots each corner by `ext`. The feet are snapped a
      // half-pixel INSIDE each infill edge (left+0.5 and iRight-0.5), so the spine
      // ends are anchored to those same foot positions ±ext to keep the overshoot
      // exactly `ext` at BOTH corners (was iRight+ext+0.5, which overshot by ext+1).
      ctx.moveTo(left - ext + 0.5, hy + 0.5);
      ctx.lineTo(iRight + ext - 0.5, hy + 0.5);
      // ...and the extension lines overshoot it by the same `ext`.
      ctx.moveTo(left + 0.5, hy + ext + 0.5);
      ctx.lineTo(left + 0.5, iBottom + 0.5);
      ctx.moveTo(iRight - 0.5, hy + ext + 0.5);
      ctx.lineTo(iRight - 0.5, iBottom + 0.5);
      ctx.stroke();

      // Optional oblique "architect's tick" where each dimension line meets its
      // extension lines — a short 45° slash, the AutoCAD architectural style.
      if (SHOW_DIMENSION_TICKS) {
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (const [tx, ty] of [
          [vx, top],
          [vx, iBottom],
          [left, hy],
          [iRight, hy],
        ] as const) {
          ctx.moveTo(tx - TICK_HALF, ty + TICK_HALF);
          ctx.lineTo(tx + TICK_HALF, ty - TICK_HALF);
        }
        ctx.stroke();
      }

      // Width label below the horizontal bracket, upright. Both labels go
      // through drawFeetLabel from a save/translate so spacing is identical.
      ctx.fillStyle = theme.label;
      ctx.save();
      ctx.translate(Math.round(cx2), Math.round(hy + labelGap));
      drawFeetLabel(ctx, shape.width);
      ctx.restore();

      // Height label left of the vertical bracket, rotated 90°.
      ctx.save();
      ctx.translate(Math.round(vx - labelGap), Math.round(cy2));
      ctx.rotate(-Math.PI / 2);
      drawFeetLabel(ctx, shape.height);
      ctx.restore();

      ctx.globalAlpha = 1;
    }

    // Per-side dimension brackets for a reshaped (irregular) quad: one "[" along
    // each of the four interior edges, offset just beyond that side's wall, with a
    // length label aligned to the edge. Live-updates while a vertex is dragged.
    if (dimsPoly && labelAlpha > 0) {
      const gap = DIMENSION_GAP;
      const labelGap = DIMENSION_LABEL_GAP;
      const ext = TICK_HALF * 2.5; // equal-length crossing stubs at each corner
      const thick = [tN, tE, tS, tW]; // wall px per edge (n, e, s, w)
      ctx.globalAlpha = labelAlpha;
      ctx.strokeStyle = theme.label;
      ctx.fillStyle = theme.label;
      ctx.lineWidth = 1;
      ctx.font = `${DIMENSION_FONT_PX}px ${LABEL_FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      for (let e = 0; e < 4; e++) {
        const A = iPts[e];
        const B = iPts[(e + 1) % 4];
        const ev = { x: B.x - A.x, y: B.y - A.y };
        const len = Math.hypot(ev.x, ev.y);
        if (len < 1) continue;
        const ux = ev.x / len; // along the edge
        const uy = ev.y / len;
        const nx = uy; // outward normal (clockwise winding, y-down)
        const ny = -ux;
        const off = thick[e] + gap; // sit `gap` beyond the outer wall face
        const aOx = A.x + nx * off;
        const aOy = A.y + ny * off;
        const bOx = B.x + nx * off;
        const bOy = B.y + ny * off;

        ctx.beginPath();
        // Spine parallel to the edge, overshooting each corner by `ext`.
        ctx.moveTo(aOx - ux * ext, aOy - uy * ext);
        ctx.lineTo(bOx + ux * ext, bOy + uy * ext);
        // Feet from each interior corner out to the spine, overshooting by `ext`.
        ctx.moveTo(A.x, A.y);
        ctx.lineTo(aOx + nx * ext, aOy + ny * ext);
        ctx.moveTo(B.x, B.y);
        ctx.lineTo(bOx + nx * ext, bOy + ny * ext);
        ctx.stroke();

        // Length label centred on the spine, nudged further out, aligned to the
        // edge and flipped as needed so it never reads upside-down.
        let ang = Math.atan2(uy, ux);
        if (ang >= Math.PI / 2) ang -= Math.PI;
        else if (ang < -Math.PI / 2) ang += Math.PI;
        const mx = (aOx + bOx) / 2 + nx * labelGap;
        const my = (aOy + bOy) / 2 + ny * labelGap;
        ctx.save();
        ctx.translate(Math.round(mx), Math.round(my));
        ctx.rotate(ang);
        drawFeetLabel(ctx, len / camera.scale);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }

    ctx.restore();

    // Area readout — drawn in screen space (after restore) so it stays upright
    // regardless of the shape's rotation. Constant on-screen size; it fades out
    // (with the dimension lines) as the shape gets too small on screen to read.
    // Positioned at the polygon centroid so it sits at the visual middle even for
    // an irregular (reshaped) room.
    if (labelAlpha > 0) {
      const cen = shapeCentroidLocal(shape);
      const cenScreen = localToScreen(shape, camera, cen.x * camera.scale, cen.y * camera.scale);
      ctx.save();
      ctx.globalAlpha = labelAlpha;
      ctx.fillStyle = theme.label;
      ctx.font = `${AREA_LABEL_FONT_PX}px ${LABEL_FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(formatArea(shape), Math.round(cenScreen.x), Math.round(cenScreen.y));
      ctx.restore();
    }
  }
}

/** Draws the rubber-band selection rectangle (canvas-local screen coords). */
export function drawMarquee(
  ctx: CanvasRenderingContext2D,
  m: Marquee,
  fill: string,
  stroke: string,
): void {
  const x = Math.min(m.x0, m.x1);
  const y = Math.min(m.y0, m.y1);
  const w = Math.abs(m.x1 - m.x0);
  const h = Math.abs(m.y1 - m.y0);

  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w, h);
  ctx.lineWidth = 1;
  ctx.strokeStyle = stroke;
  ctx.strokeRect(snap(x), snap(y), Math.round(w), Math.round(h));
}

/**
 * Draws the cursor-following placement preview: a fixed on-screen-size square
 * centred on (centerX, centerY), styled identically to a placed square.
 */
export function drawPlacementPreview(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  size: number,
  theme: ShapeTheme,
  scale: number,
): void {
  const half = size / 2;
  const wallS = DEFAULT_WALL_WORLD * scale;

  // Outward wall band, then the interior over it. The infill uses the darkened
  // "selected" white, since the preview is the shape being actively placed.
  const oLeft = Math.round(centerX - half - wallS);
  const oTop = Math.round(centerY - half - wallS);
  const oRight = Math.round(centerX + half + wallS);
  const oBottom = Math.round(centerY + half + wallS);
  ctx.fillStyle = theme.stroke;
  ctx.fillRect(oLeft, oTop, oRight - oLeft, oBottom - oTop);

  ctx.fillStyle = theme.selectedFill;
  ctx.fillRect(Math.round(centerX - half), Math.round(centerY - half), Math.round(size), Math.round(size));
}

/**
 * Returns the edge of `shape` under the screen point, or null. Edges are
 * grabbable anywhere along their length (within a small perpendicular
 * tolerance), excluding the corner zones — those rotate (see hitCorner). Tested
 * in the shape's local frame so it works at any rotation.
 */
export function hitShapeEdge(
  screenX: number,
  screenY: number,
  shape: Square,
  camera: Camera,
): HandleId | null {
  const { lx, ly } = localScreenFrame(screenX, screenY, shape, camera);
  const t = EDGE_HIT_TOLERANCE;
  const pts = localCorners(shape).map((p) => ({ x: p.x * camera.scale, y: p.y * camera.scale }));
  const thick = [shape.walls.n, shape.walls.e, shape.walls.s, shape.walls.w].map(
    (w) => w * camera.scale,
  );
  const sides = ['n', 'e', 's', 'w'] as const;

  // For each interior edge, grab anywhere from just inside the boundary (t) out
  // across that side's wall band (thickness + t), excluding a small zone at each
  // end so the corners stay unambiguous (they belong to rotation / vertex drag).
  for (let e = 0; e < 4; e++) {
    const a = pts[e];
    const b = pts[(e + 1) % 4];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 1) continue;
    const ux = ex / len;
    const uy = ey / len;
    const nx = uy; // outward normal (clockwise winding, y-down)
    const ny = -ux;
    const rx = lx - a.x;
    const ry = ly - a.y;
    const along = rx * ux + ry * uy;
    const perp = rx * nx + ry * ny;
    const cz = Math.min(t, len / 2); // corner exclusion along the edge
    if (perp >= -t && perp <= thick[e] + t && along >= cz && along <= len - cz) {
      return sides[e];
    }
  }
  return null;
}

/**
 * For `handle`'s wall, which face the screen point is nearer: the inner
 * (interior-facing) line or the outer boundary line. Split at the band midline.
 */
export function edgeFace(
  screenX: number,
  screenY: number,
  shape: Square,
  camera: Camera,
  handle: HandleId,
): EdgeFace {
  const { lx, ly } = localScreenFrame(screenX, screenY, shape, camera);
  const e = SIDE_EDGE[handle as 'n' | 'e' | 's' | 'w'];
  const pts = localCorners(shape).map((p) => ({ x: p.x * camera.scale, y: p.y * camera.scale }));
  const a = pts[e];
  const b = pts[(e + 1) % 4];
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const len = Math.hypot(ex, ey) || 1;
  const nx = ey / len; // outward normal
  const ny = -ex / len;
  const perp = (lx - a.x) * nx + (ly - a.y) * ny; // distance outward from the inner edge
  const wall = (shape.walls[handle as keyof Walls] ?? 0) * camera.scale;
  return perp < wall / 2 ? 'inner' : 'outer';
}

/** Whether the screen point is within a corner grip of `shape` (rotation zone). */
export function hitCorner(
  screenX: number,
  screenY: number,
  shape: Square,
  camera: Camera,
): boolean {
  const { lx, ly, hw, hh } = localScreenFrame(screenX, screenY, shape, camera);
  const r = ROTATION_CORNER_RADIUS;
  // Anchored on the outer (visible) corners of the wall band — per side.
  const xE = hw + shape.walls.e * camera.scale;
  const xW = hw + shape.walls.w * camera.scale;
  const yN = hh + shape.walls.n * camera.scale;
  const yS = hh + shape.walls.s * camera.scale;
  const near = (cx: number, cy: number) => Math.abs(lx - cx) <= r && Math.abs(ly - cy) <= r;
  return near(-xW, -yN) || near(xE, -yN) || near(xE, yS) || near(-xW, yS);
}

/** Radius (px) the drawn vertex dots occupy; grab tolerance is a touch larger. */
const VERTEX_DOT_RADIUS = 5;

/**
 * Which interior-vertex dot the screen point is on (or null). Only meaningful
 * when `shape.dots` is showing. The returned corner handle (`'nw'|'ne'|'se'|'sw'`)
 * drives a corner resize that pulls the two adjacent edges, anchoring the
 * opposite corner — so dragging a dot reshapes the room parametrically.
 */
export function hitCornerDot(
  screenX: number,
  screenY: number,
  shape: Square,
  camera: Camera,
): HandleId | null {
  if (!shape.dots) return null;
  const { lx, ly } = localScreenFrame(screenX, screenY, shape, camera);
  const r = VERTEX_DOT_RADIUS + 4; // a little forgiving around the dot
  const pts = localCorners(shape);
  for (let i = 0; i < pts.length; i++) {
    const cx = pts[i].x * camera.scale;
    const cy = pts[i].y * camera.scale;
    if (Math.abs(lx - cx) <= r && Math.abs(ly - cy) <= r) return CORNER_HANDLES[i];
  }
  return null;
}

/** A dimension label clicked for editing: which measure, where, and its value. */
export interface DimensionLabelHit {
  /** A rectangle's width/height label, or a single edge of a free-form quad. */
  which: 'width' | 'height' | 'edge';
  /** For `which === 'edge'`: which side's length label was hit. */
  edge?: HandleId;
  /** Label centre in canvas-local screen px (for positioning an editor). */
  sx: number;
  sy: number;
  /** Editor rotation in degrees, matching the on-canvas label. */
  angleDeg: number;
  /** Current measurement text, e.g. "12'". */
  text: string;
}

// Cached offscreen context purely for measuring label widths off the hot path.
let measureCtx: CanvasRenderingContext2D | null = null;
function dimensionTextWidth(text: string): number {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * DIMENSION_FONT_PX * 0.5;
  measureCtx.font = `${DIMENSION_FONT_PX}px ${LABEL_FONT_STACK}`;
  return measureCtx.measureText(text).width;
}

/** Local (shape-frame) point → canvas-local screen px. */
function localToScreen(shape: Square, camera: Camera, lcx: number, lcy: number): Vec2 {
  const c = worldToScreen(shape.x + shape.width / 2, shape.y + shape.height / 2, camera);
  const a = shape.rotation * DEG2RAD;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return { x: c.x + lcx * cos - lcy * sin, y: c.y + lcx * sin + lcy * cos };
}

/**
 * The dimension label under the screen point (or null). Mirrors the geometry
 * `drawShapes` uses for the outside brackets, so the clickable target sits right
 * on the drawn text at any rotation. Callers should only test the single
 * infill-selected shape (the only one that shows dimensions).
 */
export function hitDimensionLabel(
  screenX: number,
  screenY: number,
  shape: Square,
  camera: Camera,
): DimensionLabelHit | null {
  const wS = shape.width * camera.scale;
  const hS = shape.height * camera.scale;
  // Matches where the dimension lines fully fade out (so faint labels at the
  // edge of visibility aren't clickable).
  if (Math.min(wS, hS) <= AREA_LABEL_FADE_START) return null;

  const { lx, ly, hw, hh } = localScreenFrame(screenX, screenY, shape, camera);
  const tW = shape.walls.w * camera.scale;
  const tS = shape.walls.s * camera.scale;
  const pad = 4;
  const halfFont = DIMENSION_FONT_PX / 2 + pad;

  // Free-form quad: test the per-side length labels, mirroring how drawShapes
  // lays each one out (centred beyond its edge, aligned to the edge direction).
  if (shape.corners) {
    const pts = localCorners(shape).map((p) => ({ x: p.x * camera.scale, y: p.y * camera.scale }));
    const thick = [shape.walls.n, shape.walls.e, shape.walls.s, shape.walls.w].map(
      (w) => w * camera.scale,
    );
    const sides = ['n', 'e', 's', 'w'] as const;
    for (let e = 0; e < 4; e++) {
      const A = pts[e];
      const B = pts[(e + 1) % 4];
      const evx = B.x - A.x;
      const evy = B.y - A.y;
      const len = Math.hypot(evx, evy);
      if (len < 1) continue;
      const ux = evx / len;
      const uy = evy / len;
      const nx = uy;
      const ny = -ux;
      const off = thick[e] + DIMENSION_GAP + DIMENSION_LABEL_GAP;
      const mx = (A.x + B.x) / 2 + nx * off;
      const my = (A.y + B.y) / 2 + ny * off;
      let ang = Math.atan2(uy, ux);
      if (ang >= Math.PI / 2) ang -= Math.PI;
      else if (ang < -Math.PI / 2) ang += Math.PI;
      // Point relative to the label centre, rotated into the label's own frame.
      const rx = lx - mx;
      const ry = ly - my;
      const ca = Math.cos(-ang);
      const sa = Math.sin(-ang);
      const localX = rx * ca - ry * sa;
      const localY = rx * sa + ry * ca;
      const text = formatFeet(len / camera.scale);
      const halfW = dimensionTextWidth(text) / 2 + pad;
      if (Math.abs(localX) <= halfW && Math.abs(localY) <= halfFont) {
        const p = localToScreen(shape, camera, mx, my);
        return {
          which: 'edge',
          edge: sides[e],
          sx: p.x,
          sy: p.y,
          angleDeg: shape.rotation + (ang * 180) / Math.PI,
          text,
        };
      }
    }
    return null;
  }

  // Width label: centred under the bottom bracket, upright.
  const wText = formatFeet(shape.width);
  const wcy = hh + tS + DIMENSION_GAP + DIMENSION_LABEL_GAP;
  const wHalf = dimensionTextWidth(wText) / 2 + pad;
  if (Math.abs(lx) <= wHalf && Math.abs(ly - wcy) <= halfFont) {
    const p = localToScreen(shape, camera, 0, wcy);
    return { which: 'width', sx: p.x, sy: p.y, angleDeg: shape.rotation, text: wText };
  }

  // Height label: centred left of the left bracket, rotated −90°.
  const hText = formatFeet(shape.height);
  const hcx = -(hw + tW + DIMENSION_GAP + DIMENSION_LABEL_GAP);
  const hHalf = dimensionTextWidth(hText) / 2 + pad;
  if (Math.abs(lx - hcx) <= halfFont && Math.abs(ly) <= hHalf) {
    const p = localToScreen(shape, camera, hcx, 0);
    return { which: 'height', sx: p.x, sy: p.y, angleDeg: shape.rotation - 90, text: hText };
  }
  return null;
}

/** Whether the world point lies inside `s`'s interior (rotation- & shape-aware). */
export function containsPoint(s: Square, world: Vec2): boolean {
  const cx = s.x + s.width / 2;
  const cy = s.y + s.height / 2;
  const a = -s.rotation * DEG2RAD;
  const dx = world.x - cx;
  const dy = world.y - cy;
  const local = { x: dx * Math.cos(a) - dy * Math.sin(a), y: dx * Math.sin(a) + dy * Math.cos(a) };
  return pointInPolygon(local, localCorners(s));
}

/** Top-most square containing the given world point (rotation-aware), or null. */
export function hitTopShape(shapes: Square[], world: Vec2): Square | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    if (containsPoint(shapes[i], world)) return shapes[i];
  }
  return null;
}

/**
 * Resizes `original` by moving the edge(s) named by `handle` by a world-space
 * delta (worldDx, worldDy). The drag is mapped into the shape's local frame so
 * it works at any rotation; the opposite edge stays anchored in world space and
 * the shape cannot collapse below `minWorld`. Delta-based, so the same drag can
 * be applied uniformly across a multi-shape selection.
 */
export function resizeShape(
  original: Square,
  handle: HandleId,
  worldDx: number,
  worldDy: number,
  minWorld: number,
): Square {
  const t = original.rotation * DEG2RAD;
  const cos = Math.cos(t);
  const sin = Math.sin(t);

  // World delta → local delta (rotate by -θ).
  const ldx = worldDx * cos + worldDy * sin;
  const ldy = -worldDx * sin + worldDy * cos;

  let left = -original.width / 2;
  let right = original.width / 2;
  let top = -original.height / 2;
  let bottom = original.height / 2;

  if (handle.includes('w')) left = Math.min(left + ldx, right - minWorld);
  if (handle.includes('e')) right = Math.max(right + ldx, left + minWorld);
  if (handle.includes('n')) top = Math.min(top + ldy, bottom - minWorld);
  if (handle.includes('s')) bottom = Math.max(bottom + ldy, top + minWorld);

  const newW = right - left;
  const newH = bottom - top;

  // The new local centre (offset from the old centre) → world (rotate by +θ),
  // so the anchored edge keeps its world position.
  const lcx = (left + right) / 2;
  const lcy = (top + bottom) / 2;
  const cx = original.x + original.width / 2 + (lcx * cos - lcy * sin);
  const cy = original.y + original.height / 2 + (lcx * sin + lcy * cos);

  return { ...original, x: cx - newW / 2, y: cy - newH / 2, width: newW, height: newH };
}

/**
 * Changes the thickness of `handle`'s wall by dragging one of its faces:
 *  - `'outer'`: the outer face follows the cursor; the room (interior) is fixed,
 *    so the wall grows outward.
 *  - `'inner'`: the inner face (the interior boundary) follows the cursor while
 *    the outer face is held fixed, so pulling inward thickens the wall and
 *    shrinks the room.
 * Walls never go below `minWall`; the room never below `minInterior`.
 */
export function resizeWall(
  original: Square,
  handle: HandleId,
  face: EdgeFace,
  worldDx: number,
  worldDy: number,
  minWall: number,
  minInterior: number,
): Square {
  const side = handle as keyof Walls;

  // Free-form quad: act along the actual edge's outward normal. The outer face
  // adds to the wall; the inner face translates that edge (both its corners) and
  // compensates the wall so the outer face stays put.
  if (original.corners) {
    const e = SIDE_EDGE[handle as 'n' | 'e' | 's' | 'w'];
    const nrm = edgeNormalWorld(original, e);
    const perp = worldDx * nrm.x + worldDy * nrm.y; // + = outward
    if (face === 'outer') {
      const walls = { ...original.walls };
      walls[side] = Math.max(minWall, original.walls[side] + perp);
      return { ...original, walls };
    }
    // Inner face: clamp so the wall can't drop below minWall (outer face fixed).
    const delta = Math.max(perp, minWall - original.walls[side]);
    const moved = moveCorners(original, [e, (e + 1) % 4], nrm.x * delta, nrm.y * delta);
    const walls = { ...moved.walls };
    walls[side] = Math.max(minWall, original.walls[side] - delta);
    return { ...moved, walls };
  }

  if (face === 'inner') {
    // Move the interior boundary, then hold the outer face by compensating the
    // wall: the boundary's outward gain is the wall's loss (and vice versa).
    const next = resizeShape(original, handle, worldDx, worldDy, minInterior);
    const grew =
      handle === 'e' || handle === 'w'
        ? next.width - original.width
        : next.height - original.height;
    const walls = { ...original.walls };
    walls[side] = Math.max(minWall, original.walls[side] - grew);
    return { ...next, walls };
  }

  // Outer face: project the drag onto the side's outward normal and add it to
  // the wall thickness. Interior unchanged.
  const tr = original.rotation * DEG2RAD;
  const cos = Math.cos(tr);
  const sin = Math.sin(tr);
  const ldx = worldDx * cos + worldDy * sin;
  const ldy = -worldDx * sin + worldDy * cos;
  const outDelta = handle === 'e' ? ldx : handle === 'w' ? -ldx : handle === 'n' ? -ldy : ldy;

  const walls = { ...original.walls };
  walls[side] = Math.max(minWall, original.walls[side] + outDelta);
  return { ...original, walls };
}

/** A double-headed arrow cursor pointing along `angleDeg` in screen space. */
function resizeCursor(angleDeg: number): string {
  const a = (((angleDeg % 180) + 180) % 180).toFixed(1);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
    `<g transform="rotate(${a} 16 16)" fill="none" stroke-linecap="round" stroke-linejoin="round">` +
    '<path d="M6 16H26M10 11 5 16l5 5M22 11l5 5-5 5" stroke="white" stroke-width="5"/>' +
    '<path d="M6 16H26M10 11 5 16l5 5M22 11l5 5-5 5" stroke="black" stroke-width="2.2"/>' +
    '</g></svg>';
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, auto`;
}

/**
 * Resize cursor for an edge handle, kept perpendicular to that edge at any
 * shape rotation. Vertical edges (e/w) point along the shape's local x-axis;
 * horizontal edges (n/s) are 90° from it. Both are offset by the shape's
 * rotation so the arrow follows the edge as the shape turns.
 */
export function cursorForHandle(handle: HandleId, rotationDeg: number): string {
  // Only ever called for wall edges. Horizontal edges (n/s) point across their
  // span (90°), vertical edges (e/w) along the local x-axis (0°); both offset by
  // the shape's rotation so the arrow follows the edge as it turns.
  const base = handle === 'n' || handle === 's' ? 90 : 0;
  return resizeCursor(base + rotationDeg);
}
