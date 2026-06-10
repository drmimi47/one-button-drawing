/**
 * Which render layer(s) a redraw request affects. The grid is static during
 * shape edits, so most interactions only dirty the 'scene' layer.
 */
export type DrawLayer = 'grid' | 'scene' | 'all';

/** Viewport transform for the infinite canvas. */
export interface Camera {
  /** Horizontal pan offset in CSS pixels (screen space). */
  x: number;
  /** Vertical pan offset in CSS pixels (screen space). */
  y: number;
  /** Zoom factor. 1 = 100%. */
  scale: number;
}

/**
 * A square armed for placement: a preview that follows the cursor (in
 * canvas-local screen pixels) and is not committed until the user clicks.
 */
export interface PendingPlacement {
  sx: number;
  sy: number;
}

/** A rubber-band selection rectangle, in canvas-local screen pixels. */
export interface Marquee {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Per-side wall thickness, in world units, each offset outward from the rect. */
export interface Walls {
  n: number;
  e: number;
  s: number;
  w: number;
}

/** A rectangular "space" placed on the canvas, in world units. */
export interface Square {
  id: string;
  /** Top-left corner of the un-rotated rect, in world coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Rotation about the centre, in degrees (clockwise), snapped to 15°. */
  rotation: number;
  /** Outward wall thickness per side; the interior (x/y/width/height) is the room. */
  walls: Walls;
  /** Whether the four inner-vertex dots are shown (toggled by double-click). */
  dots: boolean;
  /**
   * Optional free-form interior corners, in the shape's LOCAL frame (centre-origin,
   * pre-rotation, world units), ordered [nw, ne, se, sw]. When present the room is
   * this quadrilateral rather than the axis-aligned rect; x/y/width/height track its
   * local bounding box. Absent ⇒ a plain rectangle (the default).
   */
  corners?: { x: number; y: number }[];
}

/** Colors used when rendering placed squares and their selection handles. */
export interface ShapeTheme {
  fill: string;
  /** Interior fill when the white infill itself is selected (move target). */
  selectedFill: string;
  stroke: string;
  selectedStroke: string;
  /** Highlight on the inner & outer faces of a selected edge when hovered. */
  edgeHover: string;
  /** Colour of the centred square-footage readout. */
  label: string;
}

/** Colors used when rendering the grid. */
export interface GridTheme {
  background: string;
  minorLine: string;
  majorLine: string;
  /** Lines passing through the world origin (0,0). */
  axisLine: string;
  /** Outline of the finite grid square (the CPlane boundary). */
  border: string;
}
