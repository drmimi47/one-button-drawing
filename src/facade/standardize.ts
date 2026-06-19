import type { Square } from '../types';
import { WORLD_UNITS_PER_FOOT } from '../constants';

/**
 * ============================================================================
 *  PANEL STANDARDIZATION — group identical facade panels into "types".
 * ============================================================================
 *
 * Standardization is the rule that two panels of the SAME geometry are the same product, so they
 * should be counted as one type. {@link panelSignature} reduces a shape to a geometry key (size +
 * wall thicknesses + any reshaped outline), ignoring position and rotation — so duplicating a panel
 * ten times yields ten panels of ONE type, but the moment one is stretched or its wall thickness is
 * changed it gets a new signature and becomes its own type.
 *
 * {@link computePanelTypes} buckets the canvas's shapes by signature, assigns each bucket a stable
 * colour (by first appearance), and returns both the per-type summary (for the Analyze popup) and a
 * shape-id → colour map (for the canvas to paint the groups). This lets designers count and
 * categorise panel types automatically as they work.
 */

/** Quantise a world-unit length so floating-point noise never splits identical panels. */
function q(n: number): number {
  return Math.round(n * 100);
}

/**
 * A geometry signature for one panel: width, height, the four wall thicknesses, and any reshaped
 * outline (free-polygon corners / per-edge wall thicknesses). Position, rotation, id and name are
 * excluded — only the manufactured shape matters. Two panels with the same signature are the same type.
 */
export function panelSignature(s: Square): string {
  const walls = `${q(s.walls.n)},${q(s.walls.e)},${q(s.walls.s)},${q(s.walls.w)}`;
  const corners = s.corners ? s.corners.map((p) => `${q(p.x)}:${q(p.y)}`).join(';') : '';
  const edges = s.wallEdges ? s.wallEdges.map(q).join(',') : '';
  return `${q(s.width)}x${q(s.height)}|w:${walls}|c:${corners}|e:${edges}`;
}

/** One standardized panel type: a colour-coded bucket of identical shapes plus its dimensions. */
export interface PanelType {
  /** 1-based label order (by first appearance) — drives "Type 1", "Type 2", … */
  index: number;
  /** The geometry signature shared by every shape in this type. */
  signature: string;
  /** Stable colour for this type (hex), shown on the canvas and in the popup swatch. */
  color: string;
  /** How many panels are this type. */
  count: number;
  /** Ids of every shape in this type (drives "select all of this type"). */
  shapeIds: string[];
  /** Representative interior width / height, in feet (rounded to 0.1). */
  widthFt: number;
  heightFt: number;
  /** Representative wall thickness in inches (rounded to 0.1); see {@link uniformWalls}. */
  wallInches: number;
  /** True when all four walls share one thickness (so `wallInches` fully describes the frame). */
  uniformWalls: boolean;
}

/**
 * Distinct but soft colours for the panel types — muted pastels rather than saturated primaries, so a
 * canvas full of coloured panels stays easy on the eyes. The first dozen are hand-picked; beyond that,
 * golden-angle hues at the same gentle saturation/lightness keep additional types separable. Always
 * hex so the canvas can shade them a touch darker for the selected state.
 */
const PANEL_PALETTE = [
  '#e0e8f8', '#f8e4e1', '#e2f0e6', '#f8efd9', '#ebe5f5', '#f8e5ee',
  '#e1eef5', '#f8ecdd', '#e6e8f6', '#ebf3dc', '#e0f1ec', '#f4eed9',
];

function hslToHex(h: number, s: number, l: number): string {
  const a = (s * Math.min(l, 1 - l)) / 100;
  const f = (n: number): string => {
    const k = (n + h / 30) % 12;
    const c = l / 100 - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** The stable colour for the type at appearance index `i`. */
export function colorForIndex(i: number): string {
  if (i < PANEL_PALETTE.length) return PANEL_PALETTE[i];
  const hue = (i * 137.508) % 360; // golden angle → well-spread hues
  return hslToHex(hue, 48, 91); // very pale, airy tint to match the hand-picked palette
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Bucket `shapes` into standardized panel types. Types are ordered (and coloured) by first
 * appearance, so colours stay stable as panels are added or removed. Returns the per-type summary
 * for the Analyze popup plus a shape-id → colour map for painting the groups on the canvas.
 */
export function computePanelTypes(shapes: Square[]): {
  types: PanelType[];
  colorByShapeId: Map<string, string>;
} {
  const order: string[] = [];
  const groups = new Map<string, Square[]>();
  for (const s of shapes) {
    const sig = panelSignature(s);
    let g = groups.get(sig);
    if (!g) {
      g = [];
      groups.set(sig, g);
      order.push(sig);
    }
    g.push(s);
  }

  const types: PanelType[] = [];
  const colorByShapeId = new Map<string, string>();
  order.forEach((sig, i) => {
    const g = groups.get(sig)!;
    const color = colorForIndex(i);
    for (const s of g) colorByShapeId.set(s.id, color);
    const rep = g[0];
    const w = [rep.walls.n, rep.walls.e, rep.walls.s, rep.walls.w];
    const uniformWalls = w.every((t) => Math.abs(t - w[0]) < 1e-6);
    types.push({
      index: i + 1,
      signature: sig,
      color,
      count: g.length,
      shapeIds: g.map((s) => s.id),
      widthFt: round1(rep.width / WORLD_UNITS_PER_FOOT),
      heightFt: round1(rep.height / WORLD_UNITS_PER_FOOT),
      wallInches: round1((rep.walls.n / WORLD_UNITS_PER_FOOT) * 12),
      uniformWalls,
    });
  });
  return { types, colorByShapeId };
}
