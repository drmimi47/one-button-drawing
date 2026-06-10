import type { Camera, GridTheme } from '../types';
import { MAJOR_GRID_EVERY, MIN_VISIBLE_SPACING } from '../constants';

export interface DrawGridParams {
  ctx: CanvasRenderingContext2D;
  /** Viewport size in CSS pixels. */
  width: number;
  height: number;
  camera: Camera;
  /** Cell size in world pixels. */
  gridSize: number;
  theme: GridTheme;
  /** Half-extent of the grid square, in cells (out from origin each way). */
  extentCells: number;
  /** How many cells between major (emphasised) lines. */
  majorEvery?: number;
}

/** Snap to a half-pixel so a 1px stroke stays crisp. */
const snap = (v: number): number => Math.round(v) + 0.5;

/**
 * Renders a finite, Rhino-style CPlane: a square grid centred on the world
 * origin with emphasised axes and a boundary. The grid does not tile forever —
 * beyond its edge is empty space — but the camera can still pan/zoom anywhere,
 * so the working area itself is unbounded.
 *
 * Loops are bounded to the intersection of the grid extent and the visible
 * viewport, so cost scales with on-screen lines only — not the plane size or
 * how far you've panned. The context is expected to already be scaled for
 * devicePixelRatio, so all coordinates here are in CSS pixels.
 */
export function drawGrid({
  ctx,
  width,
  height,
  camera,
  gridSize,
  theme,
  extentCells,
  majorEvery = MAJOR_GRID_EVERY,
}: DrawGridParams): void {
  // The grid layer is an opaque (alpha:false) context, so a single fill both
  // clears the previous frame and paints the background.
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);

  const spacing = gridSize * camera.scale; // on-screen pixels per cell
  const half = extentCells;

  // Screen-space bounds of the grid square (world ±half*gridSize).
  const left = camera.x - half * spacing;
  const right = camera.x + half * spacing;
  const top = camera.y - half * spacing;
  const bottom = camera.y + half * spacing;

  // Fully off-screen? Nothing to draw.
  if (right < 0 || left > width || bottom < 0 || top > height) return;

  // Visible cell-index window = grid extent ∩ viewport. Lines outside this are
  // never iterated.
  const colStart = Math.max(-half, Math.ceil((0 - camera.x) / spacing));
  const colEnd = Math.min(half, Math.floor((width - camera.x) / spacing));
  const rowStart = Math.max(-half, Math.ceil((0 - camera.y) / spacing));
  const rowEnd = Math.min(half, Math.floor((height - camera.y) / spacing));

  // Drawn line segments are clamped to the visible portion of the square edges.
  const vTop = Math.max(top, 0);
  const vBottom = Math.min(bottom, height);
  const hLeft = Math.max(left, 0);
  const hRight = Math.min(right, width);

  const showMinor = spacing >= MIN_VISIBLE_SPACING;

  const isMinor = (i: number) => i !== 0 && i % majorEvery !== 0;
  const isMajor = (i: number) => i !== 0 && i % majorEvery === 0;
  const isAxis = (i: number) => i === 0;

  // Weakest to strongest, so emphasised lines sit on top.
  if (showMinor) {
    ctx.strokeStyle = theme.minorLine;
    strokeLines(ctx, 'v', colStart, colEnd, spacing, camera.x, vTop, vBottom, isMinor);
    strokeLines(ctx, 'h', rowStart, rowEnd, spacing, camera.y, hLeft, hRight, isMinor);
  }

  ctx.strokeStyle = theme.majorLine;
  strokeLines(ctx, 'v', colStart, colEnd, spacing, camera.x, vTop, vBottom, isMajor);
  strokeLines(ctx, 'h', rowStart, rowEnd, spacing, camera.y, hLeft, hRight, isMajor);

  ctx.strokeStyle = theme.axisLine;
  strokeLines(ctx, 'v', colStart, colEnd, spacing, camera.x, vTop, vBottom, isAxis);
  strokeLines(ctx, 'h', rowStart, rowEnd, spacing, camera.y, hLeft, hRight, isAxis);

  // CPlane boundary.
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(snap(left), snap(top), Math.round(right - left), Math.round(bottom - top));
}

/**
 * Strokes the parallel grid lines whose index in [`iStart`, `iEnd`] satisfies
 * `predicate`. Each line runs from `crossStart` to `crossEnd` (already clamped
 * to the viewport by the caller).
 */
function strokeLines(
  ctx: CanvasRenderingContext2D,
  orientation: 'v' | 'h',
  iStart: number,
  iEnd: number,
  spacing: number,
  pan: number,
  crossStart: number,
  crossEnd: number,
  predicate: (index: number) => boolean,
): void {
  ctx.beginPath();
  ctx.lineWidth = 1;

  for (let i = iStart; i <= iEnd; i++) {
    if (!predicate(i)) continue;
    const pos = snap(pan + i * spacing);

    if (orientation === 'v') {
      ctx.moveTo(pos, crossStart);
      ctx.lineTo(pos, crossEnd);
    } else {
      ctx.moveTo(crossStart, pos);
      ctx.lineTo(crossEnd, pos);
    }
  }

  ctx.stroke();
}
