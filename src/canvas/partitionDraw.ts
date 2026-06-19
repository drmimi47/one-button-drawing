import type { Camera, LengthUnit } from '../types';
import { worldToScreen, type Vec2 } from './coords';
import { drawBoxDimensions } from './shapes';
import { SHAPE_THEME, BORDER_DIM_GAP } from '../constants';
import {
  borderPolygons,
  borderContaining,
  hasBoundary,
  polyBBox,
  cellRects,
  cellGroups,
  cellIdColors,
  cellNumbers,
  groupFrame,
  groupPanelKind,
  panelFrameBand,
  panelBorderEdges,
  segmentEndpoints,
  splitCell,
  type BorderBooleanHover,
  type CellRef,
  type FacadeDoc,
  type FacadeLayer,
  type GroupFrame,
  type PanelKind,
  type Rect,
  type SegmentRef,
} from '../facade/partition';

/**
 * Convex hull (Andrew's monotone chain) of screen-space points. Used to sweep a frame band's
 * silhouette along the light offset so its cast shadow connects to the frame corners with real
 * diagonal miters — like an extruded 3D solid — rather than a 2D copy nudged sideways.
 */
function convexHull(pts: Vec2[]): Vec2[] {
  if (pts.length < 3) return pts.slice();
  const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Vec2, a: Vec2, b: Vec2) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0)
      lower.pop();
    lower.push(q);
  }
  const upper: Vec2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0)
      upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Signed area (shoelace). Sign encodes winding; we only ever compare two polygons' signs. */
function signedArea(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/**
 * Intersection of a subject polygon with a CONVEX clip polygon (Sutherland–Hodgman). Used to find
 * the part of a frame's glass opening that stays lit during the shadow sweep — `glass ∩ (glass+off)`.
 */
function clipConvex(subject: Vec2[], clip: Vec2[]): Vec2[] {
  if (subject.length < 3 || clip.length < 3) return [];
  const c = signedArea(clip) < 0 ? clip.slice().reverse() : clip; // force CCW for a consistent inside test
  let out = subject.slice();
  const isect = (p1: Vec2, p2: Vec2, a: Vec2, b: Vec2): Vec2 => {
    const r = { x: p2.x - p1.x, y: p2.y - p1.y };
    const s = { x: b.x - a.x, y: b.y - a.y };
    const denom = r.x * s.y - r.y * s.x;
    if (Math.abs(denom) < 1e-9) return p2;
    const t = ((a.x - p1.x) * s.y - (a.y - p1.y) * s.x) / denom;
    return { x: p1.x + t * r.x, y: p1.y + t * r.y };
  };
  for (let i = 0; i < c.length && out.length; i++) {
    const a = c[i];
    const b = c[(i + 1) % c.length];
    const inside = (p: Vec2) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= 0;
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j];
      const prev = input[(j + input.length - 1) % input.length];
      const curIn = inside(cur);
      const prevIn = inside(prev);
      if (curIn) {
        if (!prevIn) out.push(isect(prev, cur, a, b));
        out.push(cur);
      } else if (prevIn) {
        out.push(isect(prev, cur, a, b));
      }
    }
  }
  return out;
}

const ACCENT = '#2563eb';
const CELL_STROKE = '#334155'; // dark slate — the active layer's cell outlines
const CELL_FILL = '#ffffff'; // plain white infill on the active layer (no tint)
const GHOST_STROKE = 'rgba(15, 23, 42, 0.22)'; // trace-paper outline for layers beneath the active one
const SEG_HIGHLIGHT = '#db2777'; // magenta — the shift-selected line segment
const SELECTED_BORDER = '#f59e0b'; // amber — a border picked for a boolean (unite/difference) op
const BOOL_OVERLAP_FILL = 'rgba(0, 200, 220, 0.20)'; // cyan tint marking the shared interior of two picked borders
const BOOL_CUE_LINE = '#6ea8fe'; // accent blue for the union "+" grid / subtract hatch (matches the Plan-mode cues)
const BOOL_TRIM_EDGE = '#ef4444'; // red — the border that a subtract will trim (loses the overlap)
const TRIM_FILL = '#94a3b8'; // slate — the single Edge-Profile perimeter trim band (one consistent profile)
const FRAME_FILL = '#ffffff'; // white infill (matches CELL_FILL) — the per-group (Edit-a-panel) inset frame band
const FRAME_STROKE = CELL_STROKE; // match the panel cell outlines (the lines shown before a frame) — elevation mullion
const FRAME_STROKE_WIDTH = 1; // match the vertical/horizontal grid-line weight
const FRAME_SHADOW = 'rgba(15, 23, 42, 0.35)'; // purely-visual drop shadow lifting the frame assembly off the wall
const SPLIT_PREVIEW = 'rgba(37, 99, 235, 0.55)'; // faint accent — live split-menu subdivision preview
// Border dimensions reuse the room bracket geometry, drawn in the trim accent blue.
const BORDER_DIM_THEME = { ...SHAPE_THEME, label: ACCENT };
// Below this on-screen short side (px) the border dimension labels are hidden (clutter), matching footprints.
const BORDER_DIM_MIN_PX = 24;
// One calibrated semi-transparent grey overlay marks a selected panel in BOTH modes: over white it reads
// as a light grey; over a Material-ID hue it greys the colour down while keeping it recognisable.
const SELECTED_OVERLAY = 'rgba(120, 120, 120, 0.5)';
// Material-ID view uses a much darker grey so the selection clearly stands out, while staying
// translucent enough that the underlying segmentation hue remains readable beneath it.
const SELECTED_OVERLAY_ID = 'rgba(30, 30, 30, 0.62)';

// --- Assigned panel-material fill patterns (the right-click "Assign" kinds) ---
const VISION_LINE = '#7fa3d6'; // crisp blue 45° glass slashes for clear vision glass
const SPANDREL_FILL = '#d9dee6'; // opaque light-grey tint behind spandrel glass
const SPANDREL_LINE = '#9aa6b6'; // diagonals over the spandrel tint
const SOLID_SHEEN_HI = '#f1f4f8'; // smooth-panel gradient: light top-left highlight
const SOLID_SHEEN_MID = '#dde3ea'; // smooth-panel gradient: mid tone
const SOLID_SHEEN_LO = '#c6cdd7'; // smooth-panel gradient: bottom-right shade
const CLADDING_DOT = '#b3bac4'; // stipple dots for heavy cladding
const LOUVER_LINE = '#9fa8b4'; // dense parallel lines for a louver/screen

/**
 * Draw the facade layer stack. The regular axis-aligned cell grid is built on each layer's grid domain and
 * NEVER stretches; instead the deformable TRIM borders act as a clipping mask (the cell grid fills their
 * UNION), so cells crossing an angled border are neatly sliced off. Non-active layers render as faint "trace
 * paper" beneath the active one. Everything maps through the camera.
 */
export function drawPartition(
  ctx: CanvasRenderingContext2D,
  doc: FacadeDoc,
  camera: Camera,
  opts: {
    selectedSegment?: SegmentRef | null;
    /** Group keys of the selected panels — drawn black (ID view) / white (normal view). */
    selectedGroups?: Set<string>;
    /** Material-ID view: paint each cell its flat segmentation colour and drop all chrome. */
    idView?: boolean;
    /** Border mode: the trim border is editable — draw its draggable corner handles. In Panels mode the
     *  border is locked, so the handles are hidden (the outline still shows). */
    borderMode?: boolean;
    /** Indices of borders picked for a boolean (unite/difference) op — highlighted in the selection colour. */
    selectedBorders?: Set<number>;
    /** Live Plan-style boolean classification of the cursor over two picked, overlapping borders: drives the
     *  union "+" grid (shared interior) / subtract hatch (bounding edge) preview. */
    boolHover?: BorderBooleanHover | null;
    /** Active length unit — when set (and in Border mode) each border shows live, editable width/height dims. */
    unit?: LengthUnit;
    /** Optimize overlay: paint each panel its shape-GROUP number, centred (identical panels share a number). */
    showPanelNumbers?: boolean;
    /**
     * Edit-a-panel session: outline the representative cell + magenta-highlight the draggable frame face(s) —
     * just `hoverSide`, or all four when `all` (editing every side at once).
     */
    frameEdit?: {
      rect: Rect;
      frame: GroupFrame;
      hoverSide: 'n' | 'e' | 's' | 'w' | 'b' | null;
      all: boolean;
    } | null;
    /** Live split-menu preview: the cell ref being split into cols × rows. The preview is computed from the
     *  ACTUAL resulting partition (lattice tiled + clipped to the boundary), not a naive even subdivision. */
    splitPreview?: { ref: CellRef; cols: number; rows: number } | null;
    /** Purely-visual drop shadow beneath the per-group frame bands (depth, no geometry change). */
    frameShadow?: boolean;
  } = {},
): void {
  // Map a world rect to its screen rectangle (x, y, w, h in device px).
  const screenRect = (r: Rect): [number, number, number, number] => {
    const tl = worldToScreen(r.x, r.y, camera);
    const br = worldToScreen(r.x + r.w, r.y + r.h, camera);
    return [tl.x, tl.y, br.x - tl.x, br.y - tl.y];
  };

  // Trace a world polygon as a screen path (caller decides clip/stroke/fill).
  const tracePoly = (poly: Vec2[]) => {
    if (poly.length < 2) return;
    ctx.beginPath();
    const p0 = worldToScreen(poly[0].x, poly[0].y, camera);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 1; i < poly.length; i++) {
      const p = worldToScreen(poly[i].x, poly[i].y, camera);
      ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
  };

  // Trace ALL of a layer's trim borders into ONE path (each quad a subpath). With the default nonzero rule a
  // following `ctx.clip()`/`ctx.fill()` covers the UNION of the borders — so the cell grid spans every border.
  const traceAllBorders = (layer: FacadeLayer) => {
    ctx.beginPath();
    for (const poly of borderPolygons(layer)) {
      if (poly.length < 2) continue;
      const p0 = worldToScreen(poly[0].x, poly[0].y, camera);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < poly.length; i++) {
        const p = worldToScreen(poly[i].x, poly[i].y, camera);
        ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
    }
  };

  // Stroke the clean sliced outline of every border, then (in Border mode) its draggable corner dots. Borders
  // picked for a boolean op are stroked in the amber selection colour (slightly heavier) so they read as armed.
  const strokeBorderOutlines = (
    layer: FacadeLayer,
    stroke: string,
    width: number,
    handles: boolean,
    selected?: Set<number>,
  ) => {
    borderPolygons(layer).forEach((poly, bi) => {
      const sel = selected?.has(bi) ?? false;
      const col = sel ? SELECTED_BORDER : stroke;
      tracePoly(poly);
      ctx.strokeStyle = col;
      ctx.lineWidth = sel ? width + 1.5 : width;
      ctx.stroke();
      if (!handles) return;
      for (const c of poly) {
        const p = worldToScreen(c.x, c.y, camera);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = col;
        ctx.stroke();
      }
    });
  };

  // Live width/height dimension brackets around every border's bounding box (Border mode only), in the trim
  // accent — the same CAD geometry rooms/footprints use, so they read identically and stay editable. Drawn
  // UNCLIPPED (the brackets hang outside the border).
  const drawBorderDimensions = (layer: FacadeLayer) => {
    if (!opts.unit) return;
    const scale = camera.scale;
    for (const poly of borderPolygons(layer)) {
      const bb = polyBBox(poly);
      const wS = bb.w * scale;
      const hS = bb.h * scale;
      if (Math.min(wS, hS) <= BORDER_DIM_MIN_PX) continue;
      const c = worldToScreen(bb.x + bb.w / 2, bb.y + bb.h / 2, camera);
      const hw = wS / 2;
      const hh = hS / 2;
      const corners: Vec2[] = [
        { x: -hw, y: -hh },
        { x: hw, y: -hh },
        { x: hw, y: hh },
        { x: -hw, y: hh },
      ];
      // Irregular border ⇒ also stroke the bounding box (in the dimension-line style) so the extents read
      // clearly. A rectangular border's bbox IS its own outline, so skip the outline there to avoid a
      // double-stroke over the blue border edge.
      const EPS = 1e-6;
      const isRect =
        poly.length === 4 &&
        poly.every(
          (p) =>
            (Math.abs(p.x - bb.x) < EPS || Math.abs(p.x - (bb.x + bb.w)) < EPS) &&
            (Math.abs(p.y - bb.y) < EPS || Math.abs(p.y - (bb.y + bb.h)) < EPS),
        );
      ctx.save();
      ctx.translate(Math.round(c.x), Math.round(c.y));
      // Smaller gap than rooms (no wall band) → the dimensions hug the border's actual edges. For a
      // deformed/irregular border the dims (and the outline box) fall back to the bounding box.
      drawBoxDimensions(ctx, corners, corners, bb.w, bb.h, 0, opts.unit, BORDER_DIM_THEME, !isRect, BORDER_DIM_GAP);
      ctx.restore();
    }
  };

  // Draw an assigned panel material's fill PATTERN inside a cell's screen rect (already clipped to the border
  // by the caller). Each pattern is clipped to the cell so it never bleeds into neighbours.
  const drawPanelPattern = (kind: PanelKind, x: number, y: number, w: number, h: number) => {
    if (w < 2 || h < 2) return;
    // n clean 45° diagonal lines (AutoCAD glass convention), CENTRED on the panel: the bundle is symmetric
    // about the centre, so the middle line of an odd count runs straight through it. A fixed 45° angle keeps
    // the slash steep regardless of the panel's aspect ratio. Each line is extended past the cell and clipped.
    const inv = 1 / Math.SQRT2;
    const glassDiagonals = (n: number, color: string, width: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      const cx = x + w / 2;
      const cy = y + h / 2;
      const spacing = Math.max(5, Math.min(14, Math.min(w, h) * 0.16)); // clear gap between adjacent lines
      const L = w + h; // half-length; long enough to span the cell before clipping
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * spacing; // perpendicular offset along (1,1)
        const px = cx + off * inv;
        const py = cy + off * inv;
        ctx.beginPath();
        ctx.moveTo(px - L, py + L); // direction (1,-1): a "/" slash up to the right
        ctx.lineTo(px + L, py - L);
        ctx.stroke();
      }
    };
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    switch (kind) {
      case 'vision1':
      case 'vision2':
      case 'vision3':
        glassDiagonals(kind === 'vision1' ? 1 : kind === 'vision2' ? 2 : 3, VISION_LINE, 1.4);
        break;
      case 'spandrel':
        ctx.fillStyle = SPANDREL_FILL;
        ctx.fillRect(x, y, w, h);
        glassDiagonals(2, SPANDREL_LINE, 1.4);
        break;
      case 'solid': {
        // Smooth metal/composite cassette: a soft diagonal sheen gradient (no inset line — that read as a
        // frame). The gradient runs corner-to-corner so the panel looks like a flat reflective solid surface.
        const g = ctx.createLinearGradient(x, y, x + w, y + h);
        g.addColorStop(0, SOLID_SHEEN_HI);
        g.addColorStop(0.5, SOLID_SHEEN_MID);
        g.addColorStop(1, SOLID_SHEEN_LO);
        ctx.fillStyle = g;
        ctx.fillRect(x, y, w, h);
        break;
      }
      case 'cladding': {
        // Dot stippling on a regular grid.
        const step = 7;
        ctx.fillStyle = CLADDING_DOT;
        for (let gy = y + step / 2; gy < y + h; gy += step) {
          for (let gx = x + step / 2; gx < x + w; gx += step) {
            ctx.beginPath();
            ctx.arc(gx, gy, 1.1, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        break;
      }
      case 'louver': {
        // Dense horizontal parallel lines.
        const step = 5;
        ctx.strokeStyle = LOUVER_LINE;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let ly = y + step; ly < y + h; ly += step) {
          ctx.moveTo(x, ly);
          ctx.lineTo(x + w, ly);
        }
        ctx.stroke();
        break;
      }
    }
    ctx.restore();
  };

  // Edge-Profile mode: fill the whole border region with the single trim colour as an underlay. The whole
  // rectangular panels (only cells fully inside the border) then paint on top, leaving the sliced perimeter
  // showing through as one consistent trim band. Caller must already have clipped to the border.
  const fillTrim = (layer: FacadeLayer) => {
    if (!layer.edgeProfile) return;
    traceAllBorders(layer);
    ctx.fillStyle = TRIM_FILL;
    ctx.fill();
  };

  // Per-group frames (Edit-a-panel): an inset band along every edge of each cell whose group has an override,
  // plus the live Edit-session affordances (representative-cell outline + hovered-side magenta strip).
  const drawGroupFrames = (layer: FacadeLayer) => {
    if (layer.frames && Object.keys(layer.frames).length) {
      ctx.save();
      // Each framed panel's band as (outer outline, inner glass) WORLD polygons. The band hugs every edge of
      // the panel's visible shape — including the trim-border cut — so border-sliced panels get a mullion that
      // runs along the (diagonal) border, and the band re-fits live as the border moves. `outer` is already
      // clipped to the border, so no extra canvas clip is needed.
      const bands: { outer: Vec2[]; glass: Vec2[] }[] = [];
      for (const { rect, key } of cellGroups(layer)) {
        const f = groupFrame(layer, key);
        if (!f) continue;
        const band = panelFrameBand(layer, rect, f);
        if (band) bands.push(band);
      }
      // Add a world polygon as a subpath in screen space (caller controls beginPath / fill / stroke).
      const addPoly = (poly: Vec2[]) => {
        if (poly.length < 2) return;
        const p0 = worldToScreen(poly[0].x, poly[0].y, camera);
        ctx.moveTo(p0.x, p0.y);
        for (let i = 1; i < poly.length; i++) {
          const p = worldToScreen(poly[i].x, poly[i].y, camera);
          ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
      };
      // Shadow pass: cast a real extruded shadow, not a copy nudged down-right. Light comes from
      // the upper-left, so the frame's z-height throws a shadow toward the lower-right. We sweep
      // each band's outer silhouette along that offset (convex hull of the band and its offset
      // copy); the hull's tangent edges become the diagonal corner miters a 3D solid would cast.
      //
      // Everything goes into ONE path filled with NONZERO winding so that (a) where neighbouring
      // frames' shadows overlap they union into a continuous shape instead of cancelling to white
      // seams, and (b) a single fill keeps the translucency uniform (no double-darkening). Each
      // glass opening keeps its inner shadow: only the part that stays lit through the whole sweep,
      // `glass ∩ (glass+off)`, is punched back out — as a reverse-wound subpath so nonzero treats
      // it as a hole. The offset scales with zoom so the shadow stays glued to the frame.
      if (opts.frameShadow) {
        ctx.save();
        ctx.fillStyle = FRAME_SHADOW;
        const off = 9 * camera.scale; // light direction, in screen px (equal x/y => 45° down-right)
        const toScreen = (poly: Vec2[]) => poly.map((p) => worldToScreen(p.x, p.y, camera));
        const shift = (pts: Vec2[]) => pts.map((p) => ({ x: p.x + off, y: p.y + off }));
        const traceScreen = (pts: Vec2[]) => {
          ctx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
          ctx.closePath();
        };
        ctx.beginPath();
        for (const b of bands) {
          const outer = toScreen(b.outer);
          if (outer.length < 3) continue;
          const swept = convexHull([...outer, ...shift(outer)]);
          traceScreen(swept);
          if (b.glass.length >= 3) {
            const g = toScreen(b.glass);
            const lit = clipConvex(shift(g), g); // glass ∩ (glass+off): stays lit through the sweep
            if (lit.length >= 3) {
              // Wind the hole opposite to the hull so nonzero subtracts it (inner-edge shadow remains).
              const hole = signedArea(lit) > 0 === signedArea(swept) > 0 ? lit.slice().reverse() : lit;
              traceScreen(hole);
            }
          }
        }
        ctx.fill('nonzero');
        ctx.restore();
      }
      // Clean pass: white infill (outer − glass via even-odd) + thin grid-weight outline on both rings.
      ctx.fillStyle = FRAME_FILL;
      ctx.strokeStyle = FRAME_STROKE;
      ctx.lineWidth = FRAME_STROKE_WIDTH;
      for (const b of bands) {
        ctx.beginPath();
        addPoly(b.outer);
        if (b.glass.length >= 3) addPoly(b.glass);
        ctx.fill('evenodd');
        ctx.beginPath();
        addPoly(b.outer);
        ctx.stroke();
        if (b.glass.length >= 3) {
          ctx.beginPath();
          addPoly(b.glass);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    const fe = opts.frameEdit;
    if (fe) {
      const [rx, ry, rw, rh] = screenRect(fe.rect);
      // A panel that borders the trim (its visible shape is cut by the diagonal border) isn't really this
      // axis-aligned rectangle, so the dashed "original size" outline and the magenta wash both jut past the
      // border and read as wrong. Drop the dashed outline there, and clip the wash to the border polygon.
      const borderCut = panelBorderEdges(layer, fe.rect).length > 0;
      ctx.save();
      // Dashed outline of the representative panel being edited — only when it sits fully inside the border.
      if (!borderCut) {
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.setLineDash([]);
      }
      // Magenta wash over the draggable face(s): all four strips when editing all sides at once (Shift),
      // otherwise just the hovered axis-aligned side.
      const litSides: ('n' | 'e' | 's' | 'w')[] = fe.all
        ? ['n', 'e', 's', 'w']
        : fe.hoverSide && fe.hoverSide !== 'b'
          ? [fe.hoverSide]
          : [];
      if (litSides.length) {
        const sc = camera.scale;
        const f = fe.frame;
        ctx.save();
        // Clip the wash to the border so a border-sliced panel's strips don't bleed past the boundary.
        if (borderCut) {
          const border = borderContaining(layer, fe.rect);
          if (border.length >= 3) {
            ctx.beginPath();
            const p0 = worldToScreen(border[0].x, border[0].y, camera);
            ctx.moveTo(p0.x, p0.y);
            for (let i = 1; i < border.length; i++) {
              const p = worldToScreen(border[i].x, border[i].y, camera);
              ctx.lineTo(p.x, p.y);
            }
            ctx.closePath();
            ctx.clip();
          }
        }
        ctx.fillStyle = 'rgba(219, 39, 119, 0.5)'; // SEG_HIGHLIGHT magenta, translucent
        for (const side of litSides) {
          let strip: [number, number, number, number];
          if (side === 'n') strip = [rx, ry, rw, f.n * sc];
          else if (side === 's') strip = [rx, ry + rh - f.s * sc, rw, f.s * sc];
          else if (side === 'w') strip = [rx, ry, f.w * sc, rh];
          else strip = [rx + rw - f.e * sc, ry, f.e * sc, rh];
          ctx.fillRect(...strip);
        }
        ctx.restore();
      }
      // The diagonal border-cut frame edge(s): highlight every cut line so they read as draggable. Shown when
      // hovering the border frame, or when Shift previews scaling all edges (the border scales too).
      if (fe.hoverSide === 'b' || fe.all) {
        ctx.strokeStyle = 'rgba(219, 39, 119, 0.85)';
        ctx.lineWidth = 3;
        for (const be of panelBorderEdges(layer, fe.rect)) {
          const a = worldToScreen(be[0].x, be[0].y, camera);
          const b2 = worldToScreen(be[1].x, be[1].y, camera);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b2.x, b2.y);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  };

  // Optimize overlay: paint each panel its shape-group number, centred. The label is composited with the
  // 'difference' blend over white, so its colour auto-inverts against whatever is behind it (like the Windows
  // inverted mouse pointer) — maximum contrast on any panel colour with NO outline/halo/shadow. Identical
  // panels share a number, so the result reads like a paint-by-number key.
  const drawPanelNumbers = (layer: FacadeLayer) => {
    if (!opts.showPanelNumbers) return;
    ctx.save();
    ctx.globalCompositeOperation = 'difference';
    ctx.fillStyle = '#ffffff'; // difference vs white ⇒ inverted colour of the background pixel
    ctx.font = '700 13px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const { cx, cy, num } of cellNumbers(layer)) {
      const p = worldToScreen(cx, cy, camera);
      ctx.fillText(String(num), p.x, p.y);
    }
    ctx.restore();
  };

  // --- Material-ID view: the active layer's cells as flat segmentation colours, clipped to the border —
  //     a clean paint-by-numbers map for masking (no inner grid lines/ghosts). In Border mode the editable
  //     boundary outline + corner dots are drawn on top so the user can still reshape it; Panels mode keeps
  //     the map handle-free.
  const sel = opts.selectedGroups;
  const activeLayer = doc.layers[doc.activeIndex];
  if (opts.idView && activeLayer && hasBoundary(activeLayer)) {
    ctx.save();
    traceAllBorders(activeLayer);
    if (!activeLayer.steppedEdge) ctx.clip(); // stepped mode draws whole cells unclipped (the stair-step)
    fillTrim(activeLayer); // Edge-Profile: perimeter trim underlay (no-op otherwise)
    for (const { rect, color, key } of cellIdColors(activeLayer)) {
      const [x, y, w, h] = screenRect(rect);
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, h);
      if (sel?.has(key)) {
        ctx.fillStyle = SELECTED_OVERLAY_ID; // darken the hue to mark selection, colour still readable
        ctx.fillRect(x, y, w, h);
      }
    }
    ctx.restore();
    // In Border mode the boundary stays editable even over the Material-ID map, so draw the blue outline
    // and corner dots on top of the colours to signal that (Panels mode keeps the clean handle-free map).
    if (opts.borderMode) strokeBorderOutlines(activeLayer, ACCENT, 2, true);
    drawGroupFrames(activeLayer);
    drawPanelNumbers(activeLayer);
    return;
  }

  // --- Ghosted layers (every layer except the active one), each clipped to its own trim border ---
  doc.layers.forEach((layer, i) => {
    if (i === doc.activeIndex || !hasBoundary(layer)) return;
    ctx.save();
    traceAllBorders(layer);
    ctx.clip();
    ctx.strokeStyle = GHOST_STROKE;
    ctx.lineWidth = 1;
    for (const rect of cellRects(layer)) {
      const [x, y, w, h] = screenRect(rect);
      ctx.strokeRect(x, y, w, h);
    }
    ctx.restore();
    // The trim outline itself (clean sliced edge), per border. No corner handles on ghost layers.
    strokeBorderOutlines(layer, GHOST_STROKE, 1, false);
  });

  // --- Active layer: clip the regular grid to the trim border, then draw the border + corner handles ---
  const active = doc.layers[doc.activeIndex];
  if (active && hasBoundary(active)) {
    ctx.save();
    traceAllBorders(active);
    if (!active.steppedEdge) ctx.clip(); // stepped mode draws whole cells unclipped (the stair-step)
    fillTrim(active); // Edge-Profile: perimeter trim underlay (no-op otherwise)
    // Inner cell outlines are only drawn once SOME border has actually been subdivided (a grid exists). Before
    // that the whole boundary is a single panel whose edge IS the blue border outline — stroking the fixed
    // root rect here would linger as a stray dark rectangle once the border is deformed off its drawn spot.
    const showCellOutlines = active.grids.some((g) => g != null);
    // We need per-cell group KEYS when a panel group is selected OR any panel has an assigned material kind
    // (both look up by key). Otherwise take the cheaper plain `cellRects` path (no clipping for keys).
    const hasKinds = !!active.panelKinds && Object.keys(active.panelKinds).length > 0;
    if ((sel && sel.size) || hasKinds) {
      for (const { rect, key } of cellGroups(active)) {
        const [x, y, w, h] = screenRect(rect);
        ctx.fillStyle = CELL_FILL;
        ctx.fillRect(x, y, w, h);
        const kind = hasKinds ? groupPanelKind(active, key) : null;
        if (kind) drawPanelPattern(kind, x, y, w, h);
        if (sel?.has(key)) {
          ctx.fillStyle = SELECTED_OVERLAY; // white + grey overlay → a light grey selected panel
          ctx.fillRect(x, y, w, h);
        }
        if (showCellOutlines) {
          ctx.strokeStyle = CELL_STROKE;
          ctx.lineWidth = 1.25;
          ctx.strokeRect(x, y, w, h);
        }
      }
    } else {
      for (const rect of cellRects(active)) {
        const [x, y, w, h] = screenRect(rect);
        ctx.fillStyle = CELL_FILL;
        ctx.fillRect(x, y, w, h);
        if (showCellOutlines) {
          ctx.strokeStyle = CELL_STROKE;
          ctx.lineWidth = 1.25;
          ctx.strokeRect(x, y, w, h);
        }
      }
    }

    // Shift-selected segment highlight (drawn inside the clip so it slices with the border).
    if (opts.selectedSegment) {
      const ends = segmentEndpoints(active, opts.selectedSegment);
      if (ends) {
        const a = worldToScreen(ends[0].x, ends[0].y, camera);
        const b = worldToScreen(ends[1].x, ends[1].y, camera);
        ctx.strokeStyle = SEG_HIGHLIGHT;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    // Live split-menu preview — dashed outline of the ACTUAL cells the split will produce. We apply the split
    // to a throwaway clone of the active layer and draw its resulting cell grid, so the preview tiles the real
    // lattice across the WHOLE boundary and (being inside the border clip above) is sliced exactly like the
    // committed panels will be — an accurate picture of how they'll populate, not a naive even subdivision.
    const pv = opts.splitPreview;
    if (pv && (pv.cols > 1 || pv.rows > 1)) {
      const preview = JSON.parse(JSON.stringify(active)) as FacadeLayer;
      splitCell(preview, pv.ref, pv.cols, pv.rows);
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = SPLIT_PREVIEW;
      ctx.lineWidth = 1.25;
      for (const rect of cellRects(preview)) {
        const [x, y, w, h] = screenRect(rect);
        ctx.strokeRect(x, y, w, h);
      }
      ctx.restore();
    }
    ctx.restore();

    // Boolean preview: with exactly two borders picked in Border mode, tint their shared interior cyan (the
    // click target). Hovering it shows the UNION "+" grid; hovering an edge that bounds it shows the SUBTRACT
    // hatch over the region the trimmed border loses, plus a red dashed outline of that border. Mirrors the
    // Plan-mode room booleans — the in-canvas replacement for the old Combine buttons.
    if (opts.borderMode && opts.selectedBorders && opts.selectedBorders.size === 2) {
      const polys = borderPolygons(active);
      const idx = [...opts.selectedBorders].filter((i) => i >= 0 && i < polys.length);
      if (idx.length === 2) {
        const A = polys[idx[0]];
        const B = polys[idx[1]];
        // Screen bounding box of both borders — the lattice/hatch is anchored to it and clipped to A ∩ B,
        // so the marks stay put on screen and fill exactly the shared interior.
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const poly of [A, B]) {
          for (const p of poly) {
            const s = worldToScreen(p.x, p.y, camera);
            minX = Math.min(minX, s.x);
            minY = Math.min(minY, s.y);
            maxX = Math.max(maxX, s.x);
            maxY = Math.max(maxY, s.y);
          }
        }
        const bh = opts.boolHover;
        ctx.save();
        tracePoly(A);
        ctx.clip();
        tracePoly(B);
        ctx.clip(); // now clipped to A ∩ B (the shared interior)
        ctx.fillStyle = BOOL_OVERLAP_FILL;
        tracePoly(A);
        ctx.fill();
        ctx.strokeStyle = BOOL_CUE_LINE;
        ctx.lineWidth = 1;
        if (bh?.kind === 'union') {
          // "+" lattice = "click to merge".
          ctx.lineCap = 'round';
          const GRID = 12;
          const ARM = 4;
          ctx.beginPath();
          for (let x = Math.ceil(minX / GRID) * GRID; x <= maxX; x += GRID) {
            for (let y = Math.ceil(minY / GRID) * GRID; y <= maxY; y += GRID) {
              ctx.moveTo(x - ARM, y);
              ctx.lineTo(x + ARM, y);
              ctx.moveTo(x, y - ARM);
              ctx.lineTo(x, y + ARM);
            }
          }
          ctx.stroke();
        } else if (bh?.kind === 'difference') {
          // Diagonal hatch = "this overlap is erased from the trimmed border".
          ctx.beginPath();
          const HATCH_GAP = 8;
          for (let c = minX + minY; c <= maxX + maxY; c += HATCH_GAP) {
            ctx.moveTo(c - minY, minY);
            ctx.lineTo(c - maxY, maxY);
          }
          ctx.stroke();
        }
        ctx.restore();
        // Outside the clip: outline the border that a subtract would trim, so the direction is unambiguous.
        if (bh?.kind === 'difference' && polys[bh.target]) {
          ctx.save();
          tracePoly(polys[bh.target]);
          ctx.strokeStyle = BOOL_TRIM_EDGE;
          ctx.lineWidth = 3;
          ctx.setLineDash([6, 4]);
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    // Trim border outline (the clean sliced boundary) for every border, plus corner handles in Border mode
    // (hidden when the border is locked in Panels mode). Border-mode selection is highlighted for boolean ops.
    strokeBorderOutlines(active, ACCENT, 2, !!opts.borderMode, opts.borderMode ? opts.selectedBorders : undefined);
    // Live, editable width/height dimensions on each border — Border mode only.
    if (opts.borderMode) drawBorderDimensions(active);
    drawGroupFrames(active);
    drawPanelNumbers(active);
  }
}
