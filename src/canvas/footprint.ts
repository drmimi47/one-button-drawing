import type { Camera, Footprint, LengthUnit, Square } from '../types';
import { worldToScreen } from './coords';
import { drawBoxDimensions } from './shapes';
import { SHAPE_THEME } from '../constants';

/** The textbox/popup accent blue, shared by the outline and the dimensions. */
const FOOTPRINT_ACCENT = '#6ea8fe';
/** Outline colour: the same accent blue the dimension lines use. */
const FOOTPRINT_STROKE = FOOTPRINT_ACCENT;
/** Thin outline (screen px), matching the slim dimension/edge lines. */
const FOOTPRINT_LINE_WIDTH = 1;
/** Dimension theme: rooms' bracket geometry, but drawn in the accent blue. */
const FOOTPRINT_DIM_THEME = { ...SHAPE_THEME, label: FOOTPRINT_ACCENT };

/** Below this on-screen short side (px) the dimension labels are hidden (clutter). */
const FOOTPRINT_DIM_MIN_PX = 24;

/** Half-pixel snap so the 1px outline stays crisp on axis-aligned edges. */
const snap = (v: number): number => Math.round(v) + 0.5;

/**
 * A footprint expressed as a minimal {@link Square} (no walls, no rotation), so the
 * existing dimension-label geometry/hit-tests (`hitDimensionLabel`, `drawBoxDimensions`)
 * apply unchanged. Only the fields those helpers read are populated.
 */
export function footprintAsShape(fp: Footprint): Square {
  return {
    id: fp.id,
    x: fp.x,
    y: fp.y,
    width: fp.width,
    height: fp.height,
    rotation: 0,
    walls: { n: 0, e: 0, s: 0, w: 0 },
    dots: false,
  };
}

/**
 * Draws each building footprint: a white-filled, black-outlined rectangle plus its
 * Length/Width dimension brackets (the same style rooms use). Call this BEFORE
 * `drawShapes` so the rooms and their dimensions render on top of the footprint.
 */
export function drawFootprints(
  ctx: CanvasRenderingContext2D,
  footprints: Footprint[],
  camera: Camera,
  unit: LengthUnit,
): void {
  const scale = camera.scale;
  for (const fp of footprints) {
    const wS = fp.width * scale;
    const hS = fp.height * scale;
    const c = worldToScreen(fp.x + fp.width / 2, fp.y + fp.height / 2, camera);
    const rcx = Math.round(c.x);
    const rcy = Math.round(c.y);
    const hw = wS / 2;
    const hh = hS / 2;

    // Transparent interior + thin accent outline (grid/rooms show through). Half-
    // pixel coords keep the 1px line crisp.
    ctx.save();
    ctx.translate(rcx, rcy);
    ctx.beginPath();
    ctx.rect(snap(-hw), snap(-hh), Math.round(wS), Math.round(hS));
    ctx.lineWidth = FOOTPRINT_LINE_WIDTH;
    ctx.strokeStyle = FOOTPRINT_STROKE;
    ctx.stroke();
    ctx.restore();

    // Length/Width dimension brackets (inner === outer — there is no wall band).
    if (Math.min(wS, hS) > FOOTPRINT_DIM_MIN_PX) {
      const corners = [
        { x: -hw, y: -hh },
        { x: hw, y: -hh },
        { x: hw, y: hh },
        { x: -hw, y: hh },
      ];
      ctx.save();
      ctx.translate(rcx, rcy);
      drawBoxDimensions(ctx, corners, corners, fp.width, fp.height, 0, unit, FOOTPRINT_DIM_THEME);
      ctx.restore();
    }
  }
}
