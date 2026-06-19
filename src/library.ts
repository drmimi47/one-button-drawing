import type { Square } from './types';
import { clusterWorldBounds } from './canvas/thumbnail';

/**
 * A saved arrangement of one or more rooms. `shapes` are stored normalised so the
 * cluster's outer bounding box is centred on the world origin — placement is then
 * just "translate every shape to the drop point", preserving relative position,
 * orientation, size and all per-shape properties.
 */
export interface LibraryCluster {
  id: string;
  shapes: Square[];
  createdAt: number;
  /** User-given title; when unset the badge shows a default "Group N" label (by list position). */
  name?: string;
}

const STORAGE_KEY = 'obd.library.v1';

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `lib_${Math.random().toString(36).slice(2)}`;
}

/** Deep-enough clone of a shape (geometry + walls + corners + per-edge walls). */
function cloneShape(s: Square): Square {
  return {
    ...s,
    walls: { ...s.walls },
    corners: s.corners?.map((p) => ({ ...p })),
    wallEdges: s.wallEdges?.slice(),
  };
}

/**
 * Build a Library cluster from a live selection: deep-clone the shapes and shift
 * them so the cluster's outer bounding box is centred on (0, 0).
 */
export function makeCluster(shapes: Square[]): LibraryCluster {
  const b = clusterWorldBounds(shapes);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const normalised = shapes.map((s) => {
    const copy = cloneShape(s);
    copy.x -= cx;
    copy.y -= cy;
    return copy;
  });
  return { id: newId(), shapes: normalised, createdAt: Date.now() };
}

/** Load saved clusters from localStorage (returns [] on any error). */
export function loadLibrary(): LibraryCluster[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LibraryCluster[]) : [];
  } catch {
    return [];
  }
}

/** Persist clusters to localStorage (best-effort; ignores quota/serialisation errors). */
export function saveLibrary(clusters: LibraryCluster[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clusters));
  } catch {
    // ignore (private mode / quota); the in-memory library still works this session.
  }
}
