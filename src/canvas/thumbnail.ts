import type { Camera, ShapeTheme, Square } from '../types';
import { footprintScreen } from './shapes';
import { screenToWorld } from './coords';

/** Identity transform: footprintScreen under it yields plain world coordinates. */
const IDENTITY: Camera = { x: 0, y: 0, scale: 1 };

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Combined OUTER bounding box (including wall bands) of a cluster of shapes, in
 * world units. Used to centre a cluster on the origin for storage and to fit it
 * into a thumbnail / preview at any scale.
 */
export function clusterWorldBounds(shapes: Square[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of shapes) {
    for (const p of footprintScreen(s, IDENTITY).outer) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/** Trace a closed polygon path in the current user space. */
function tracePoly(ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[]): void {
  if (pts.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

/** Draw each shape (wall band then interior) under the given camera. */
function paintShapes(
  ctx: CanvasRenderingContext2D,
  shapes: Square[],
  camera: Camera,
  theme: ShapeTheme,
  alpha: number,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  for (const s of shapes) {
    const { inner, outer } = footprintScreen(s, camera);
    ctx.fillStyle = theme.stroke; // wall band
    tracePoly(ctx, outer);
    ctx.fill();
    ctx.fillStyle = theme.fill; // interior
    tracePoly(ctx, inner);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Render a cluster of shapes into a `w`×`h` box (CSS px), scaled to fit with a
 * little padding, preserving relative arrangement, orientation and proportions.
 * `ctx` is assumed already scaled for device pixel ratio by the caller.
 */
export function drawClusterThumbnail(
  ctx: CanvasRenderingContext2D,
  shapes: Square[],
  w: number,
  h: number,
  theme: ShapeTheme,
): void {
  ctx.clearRect(0, 0, w, h);
  if (shapes.length === 0) return;

  const b = clusterWorldBounds(shapes);
  const spanX = Math.max(b.maxX - b.minX, 1e-6);
  const spanY = Math.max(b.maxY - b.minY, 1e-6);
  const pad = 12;
  const scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);

  // Centre the cluster's bbox in the box: screen = world*scale + pan.
  const midX = (b.minX + b.maxX) / 2;
  const midY = (b.minY + b.maxY) / 2;
  const camera: Camera = { x: w / 2 - midX * scale, y: h / 2 - midY * scale, scale };

  paintShapes(ctx, shapes, camera, theme, 1);
}

/** Shared fit transform + canvas size for a facade render (and its masks). */
export interface FacadeRefTransform {
  camera: Camera;
  w: number;
  h: number;
}

/** Padding (px) around the fitted facade in the reference image. */
const FACADE_REF_PAD = 24;

/**
 * The fit transform for rendering a facade selection into a `maxPx`-bounded image. Every render PASS
 * and every compositing MASK uses this same transform, so all passes share one pixel space and the
 * geometry masks line up with the rendered panels. Derived from the FULL selection's outer bounds.
 */
export function facadeRefTransform(allShapes: Square[], maxPx = 1024): FacadeRefTransform {
  const b = clusterWorldBounds(allShapes);
  const spanX = Math.max(b.maxX - b.minX, 1e-6);
  const spanY = Math.max(b.maxY - b.minY, 1e-6);
  const scale = (maxPx - 2 * FACADE_REF_PAD) / Math.max(spanX, spanY);
  const w = Math.max(1, Math.round(spanX * scale + 2 * FACADE_REF_PAD));
  const h = Math.max(1, Math.round(spanY * scale + 2 * FACADE_REF_PAD));
  const camera: Camera = {
    x: FACADE_REF_PAD - b.minX * scale,
    y: FACADE_REF_PAD - b.minY * scale,
    scale,
  };
  return { camera, w, h };
}

// Reference-image tones (explained to the model in the prompt): a flat mid-grey panel field to be
// textured with the material, a darker band for the mullion/joint, on a pure-white background.
const REF_PANEL_FILL = '#bcbcbc';
const REF_BAND_FILL = '#3f3f46';
const REF_EDGE = 'rgba(0, 0, 0, 0.55)';

/**
 * Rasterise a set of shapes to a PNG data URL — the AI facade renderer's reference image. Draws FILLED
 * tonal regions (mid-grey panel field, darker mullion/joint band at true thickness) on a pure-white
 * background, so the model textures unambiguous regions instead of inventing geometry. Pass a shared
 * {@link FacadeRefTransform} to draw a SUBSET in the full selection's pixel space (multi-pass); omit it
 * to fit `shapes` on their own. Returns null for an empty set / no ctx.
 */
export function renderShapesToDataURL(
  shapes: Square[],
  transform?: FacadeRefTransform,
  maxPx = 1024,
): string | null {
  if (shapes.length === 0) return null;
  const t = transform ?? facadeRefTransform(shapes, maxPx);
  const canvas = document.createElement('canvas');
  canvas.width = t.w;
  canvas.height = t.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, t.w, t.h);

  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.5;
  for (const s of shapes) {
    const { inner, outer } = footprintScreen(s, t.camera);
    // Whole footprint = band tone, then the interior = panel tone → the band reads at true thickness.
    ctx.fillStyle = REF_BAND_FILL;
    tracePoly(ctx, outer);
    ctx.fill();
    ctx.fillStyle = REF_PANEL_FILL;
    tracePoly(ctx, inner);
    ctx.fill();
    // Crisp edges so the model locks onto the exact panel + joint boundaries.
    ctx.strokeStyle = REF_EDGE;
    tracePoly(ctx, outer);
    ctx.stroke();
    tracePoly(ctx, inner);
    ctx.stroke();
  }
  return canvas.toDataURL('image/png');
}

/**
 * Cursor-following ghost of a cluster being placed: the (origin-centred) cluster
 * shapes translated so their centre sits at the screen point (sx, sy), drawn at
 * the live camera scale so the preview matches what will be dropped.
 */
export function drawClusterPreview(
  ctx: CanvasRenderingContext2D,
  shapes: Square[],
  sx: number,
  sy: number,
  camera: Camera,
  theme: ShapeTheme,
): void {
  const world = screenToWorld(sx, sy, camera);
  const moved = shapes.map((s) => ({ ...s, x: s.x + world.x, y: s.y + world.y }));
  paintShapes(ctx, moved, camera, theme, 0.6);
}
