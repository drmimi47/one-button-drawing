import type { RoomRequestItem } from '../../backend/parsePrompt';

/**
 * ============================================================================
 *  RESIDENTIAL ROOM CATALOG — the single, transparent source of truth for
 *  translating a room NAME into a typical SIZE.
 * ============================================================================
 *
 * This file deliberately keeps the name→size mapping IN THE CODEBASE (not hidden
 * inside the LLM). The Prompt parser only extracts WHAT the user asked for (room
 * types, counts, and any sizes they explicitly stated); the dimensions below are
 * what actually get drawn. A developer can read, audit, and adjust every value
 * here and immediately see how e.g. "kitchen" becomes a 12'×10' space.
 *
 * `widthFt` × `heightFt` are TYPICAL interior footprints (medians from common
 * residential room-size guides — see Sources). They are sensible defaults for
 * quick sketching, NOT code minimums; tune freely.
 *
 * Sources (typical/median residential dimensions):
 *  - sqft.expert — Standard Sizes of Rooms (architects)
 *  - Homenish — Standard Room Sizes
 *  - DesignFiles — Average Room Sizes
 *  - Punch! — Common Room Sizes & Square Footage
 *  - Foyr — Average Master Bedroom Size
 *
 * The app is residential by default; commercial / healthcare catalogs would be
 * added as separate lists.
 */

export interface RoomDef {
  /** Canonical id, e.g. 'primaryBedroom'. */
  key: string;
  /** Display title placed on the created Square, e.g. 'Primary Bedroom'. */
  label: string;
  /** Lowercase synonyms the parser (and the LLM) may use for this room. */
  aliases: string[];
  /** Typical interior width, in feet. */
  widthFt: number;
  /** Typical interior depth, in feet. */
  heightFt: number;
  /** Short rationale / note for the chosen size. */
  note?: string;
}

/** Fallback size for an unknown room type, or when no size is given. */
export const DEFAULT_ROOM_FT = { widthFt: 12, heightFt: 12 };

/** Hard cap on rooms created from one prompt (matches the parser's cap). */
export const MAX_PROMPT_ROOMS = 50;

/**
 * The canonical residential room list. Order is purely for readability. Add a row
 * (with aliases) to teach the app a new room type — no other file needs to change.
 */
export const RESIDENTIAL_ROOMS: RoomDef[] = [
  {
    key: 'living',
    label: 'Living Room',
    aliases: ['living', 'living room', 'lounge', 'sitting room'],
    widthFt: 18,
    heightFt: 12,
    note: 'Standard living room ~18×12 (216 sq ft).',
  },
  {
    key: 'greatRoom',
    label: 'Great Room',
    aliases: ['great room', 'family room', 'family', 'den'],
    widthFt: 20,
    heightFt: 16,
    note: 'Open great/family room, larger than a formal living room.',
  },
  {
    key: 'kitchen',
    label: 'Kitchen',
    aliases: ['kitchen'],
    widthFt: 12,
    heightFt: 10,
    note: 'Mid-size kitchen work area (~120 sq ft).',
  },
  {
    key: 'dining',
    label: 'Dining Room',
    aliases: ['dining', 'dining room', 'dining area'],
    widthFt: 14,
    heightFt: 12,
    note: 'Formal dining room, seats ~6–8.',
  },
  {
    key: 'breakfastNook',
    label: 'Breakfast Nook',
    aliases: ['breakfast nook', 'nook', 'breakfast', 'eat-in'],
    widthFt: 10,
    heightFt: 8,
    note: 'Casual eat-in nook off the kitchen.',
  },
  {
    key: 'bedroom',
    label: 'Bedroom',
    aliases: ['bedroom', 'bed', 'guest room', 'guest bedroom', 'kids room', 'secondary bedroom'],
    widthFt: 12,
    heightFt: 11,
    note: 'Standard secondary bedroom (10×12 to 12×12).',
  },
  {
    key: 'primaryBedroom',
    label: 'Primary Bedroom',
    aliases: [
      'primary bedroom',
      'primary',
      'master',
      'master bedroom',
      "owner's suite",
      'owners suite',
      'main bedroom',
    ],
    widthFt: 16,
    heightFt: 14,
    note: 'Primary/master bedroom, fits a king bed.',
  },
  {
    key: 'fullBath',
    label: 'Bathroom',
    aliases: ['bathroom', 'bath', 'full bath', 'full bathroom', 'washroom'],
    widthFt: 8,
    heightFt: 5,
    note: 'Standard full bath (~5×8).',
  },
  {
    key: 'powderRoom',
    label: 'Powder Room',
    aliases: ['powder room', 'powder', 'half bath', 'half bathroom', 'wc', 'toilet', 'water closet'],
    widthFt: 6,
    heightFt: 3,
    note: 'Half bath / powder room (toilet + sink only).',
  },
  {
    key: 'closet',
    label: 'Closet',
    aliases: ['closet', 'reach-in closet', 'reach in closet', 'wardrobe'],
    widthFt: 5,
    heightFt: 4,
    note: 'Reach-in closet / small storage.',
  },
  {
    key: 'walkInCloset',
    label: 'Walk-in Closet',
    aliases: ['walk-in closet', 'walk in closet', 'walkin closet', 'walk-in', 'wic'],
    widthFt: 8,
    heightFt: 6,
    note: 'Walk-in closet (medium ~6×6 to large ~6×8).',
  },
  {
    key: 'pantry',
    label: 'Pantry',
    aliases: ['pantry', 'larder'],
    widthFt: 6,
    heightFt: 5,
    note: 'Walk-in pantry off the kitchen.',
  },
  {
    key: 'laundry',
    label: 'Laundry Room',
    aliases: ['laundry', 'laundry room', 'utility laundry'],
    widthFt: 8,
    heightFt: 6,
    note: 'Laundry room (washer/dryer + counter).',
  },
  {
    key: 'mudroom',
    label: 'Mud Room',
    aliases: ['mud room', 'mudroom', 'drop zone'],
    widthFt: 8,
    heightFt: 6,
    note: 'Mud room / rear entry with storage.',
  },
  {
    key: 'office',
    label: 'Office',
    aliases: ['office', 'home office', 'study', 'studio'],
    widthFt: 12,
    heightFt: 10,
    note: 'Home office / study (~120 sq ft).',
  },
  {
    key: 'garage2Car',
    label: '2-Car Garage',
    aliases: ['garage', '2-car garage', 'two-car garage', 'two car garage', 'double garage'],
    widthFt: 20,
    heightFt: 20,
    note: 'Standard two-car garage (~20×20).',
  },
  {
    key: 'garage1Car',
    label: '1-Car Garage',
    aliases: ['1-car garage', 'one-car garage', 'one car garage', 'single garage'],
    widthFt: 20,
    heightFt: 12,
    note: 'Single-car garage (~12×20).',
  },
  {
    key: 'foyer',
    label: 'Foyer',
    aliases: ['foyer', 'entry', 'entryway', 'entrance', 'vestibule'],
    widthFt: 8,
    heightFt: 6,
    note: 'Entry foyer.',
  },
  {
    key: 'utility',
    label: 'Utility Room',
    aliases: ['utility', 'utility room', 'mechanical', 'mechanical room', 'furnace room'],
    widthFt: 8,
    heightFt: 6,
    note: 'Mechanical / utility room.',
  },
  {
    key: 'stairwell',
    label: 'Stairwell',
    aliases: ['stairwell', 'stairs', 'stairway', 'staircase'],
    widthFt: 10,
    heightFt: 4,
    note: 'Straight-run stair footprint (~3.5–4 ft wide).',
  },
];

/** A concrete room to place: a display name and an interior size in feet. */
export interface PlacedRoom {
  name: string;
  widthFt: number;
  heightFt: number;
}

/** Normalise a free-form room name for matching: lowercase, collapse spaces. */
function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Look up a room definition by name (key, label, or any alias). Tolerates a
 * trailing plural "s" (e.g. "bedrooms" → bedroom). Returns null if unknown.
 */
export function findRoomDef(name: string): RoomDef | null {
  const n = normalize(name);
  if (!n) return null;
  const candidates = [n];
  if (n.endsWith('s')) candidates.push(n.slice(0, -1)); // strip a simple plural

  for (const def of RESIDENTIAL_ROOMS) {
    const haystack = [def.key.toLowerCase(), def.label.toLowerCase(), ...def.aliases];
    if (candidates.some((c) => haystack.includes(c))) return def;
  }
  return null;
}

/** Keep an LLM size guess within a sane residential range (feet). */
function clampFt(ft: number): number {
  return Math.max(3, Math.min(60, ft));
}

/** Look up a room definition by its canonical `key` (e.g. 'primaryBedroom'). */
export function findRoomByKey(key: string): RoomDef | null {
  return RESIDENTIAL_ROOMS.find((d) => d.key === key) ?? null;
}

/**
 * Catalog keys that do NOT count toward Usable Floor Area (UFA) — circulation and
 * service/support spaces. Used by the live stats to derive UFA from the net interior.
 */
export const NON_USABLE_ROOM_KEYS = new Set<string>([
  'stairwell', 'foyer', // circulation
  'utility', 'laundry', 'mudroom', // service / mechanical
  'closet', 'walkInCloset', 'pantry', // storage / support
  'garage2Car', 'garage1Car', // garage
]);

/**
 * Whether a room (by its display name) counts as Usable Floor Area. A recognised
 * circulation/service type is excluded; an unknown or default "Room" counts as usable.
 */
export function isUsableFloorArea(name: string | undefined): boolean {
  const def = name ? findRoomDef(name) : null;
  return def == null || !NON_USABLE_ROOM_KEYS.has(def.key);
}

/** Title-case a raw type name for display when it isn't in the catalog. */
function titleCase(name: string): string {
  return normalize(name)
    .split(' ')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Translate parsed room requests into a flat list of concrete rooms to place.
 * This is the visible name→size translation step, in priority order:
 *  1. explicit `widthFt`/`heightFt` (the user stated a size) — always win;
 *  2. a catalog match — the app's own typical size + display label (prioritised
 *     over any LLM guess, so known rooms are always consistent);
 *  3. the LLM's `estimatedWidthFt`/`estimatedHeightFt` — a best-guess size for an
 *     unrecognised room name (clamped to a sane range);
 *  4. {@link DEFAULT_ROOM_FT} — last-resort generic size.
 * In all unknown cases the user's name is kept (title-cased), so nothing silently
 * disappears. Each resolution is logged in dev. Capped at {@link MAX_PROMPT_ROOMS}.
 */
export function resolveRoomList(items: RoomRequestItem[]): PlacedRoom[] {
  const out: PlacedRoom[] = [];

  for (const item of items) {
    if (out.length >= MAX_PROMPT_ROOMS) break;
    const count = Math.max(1, Math.floor(item.count ?? 1));
    const def = item.type ? findRoomDef(item.type) : null;
    const hasEstimate = item.estimatedWidthFt != null && item.estimatedHeightFt != null;

    let name: string;
    let widthFt: number;
    let heightFt: number;
    let source: 'catalog' | 'default' | 'explicit' | 'estimate';

    if (item.widthFt != null && item.heightFt != null) {
      // User stated a size — honour it; name from the catalog/type when present.
      widthFt = item.widthFt;
      heightFt = item.heightFt;
      name = def?.label ?? (item.type ? titleCase(item.type) : 'Room');
      source = 'explicit';
    } else if (def) {
      // Catalog always wins for a recognised type (ignores any LLM guess).
      widthFt = def.widthFt;
      heightFt = def.heightFt;
      name = def.label;
      source = 'catalog';
    } else if (hasEstimate) {
      // Unknown room: fall back to the LLM's best guess, clamped to a sane range.
      widthFt = clampFt(item.estimatedWidthFt!);
      heightFt = clampFt(item.estimatedHeightFt!);
      name = item.type ? titleCase(item.type) : 'Room';
      source = 'estimate';
    } else {
      widthFt = DEFAULT_ROOM_FT.widthFt;
      heightFt = DEFAULT_ROOM_FT.heightFt;
      name = item.type ? titleCase(item.type) : 'Room';
      source = item.type ? 'default' : 'catalog';
    }

    if (import.meta.env?.DEV) {
      const from = item.type ?? '(generic)';
      console.debug(`[rooms] ${from} ×${count} → ${name} ${widthFt}×${heightFt} (${source})`);
    }

    for (let i = 0; i < count && out.length < MAX_PROMPT_ROOMS; i++) {
      out.push({ name, widthFt, heightFt });
    }
  }

  return out;
}
