import { RESIDENTIAL_ROOMS, MAX_PROMPT_ROOMS } from '../src/rooms/roomCatalog';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

/**
 * One room request parsed out of a natural-language prompt. Sizes are OMITTED
 * unless the user explicitly stated them — the app's room catalog
 * (src/rooms/roomCatalog.ts) supplies the typical size for a named type.
 */
export interface RoomRequestItem {
  /** A room type / name, e.g. "kitchen" or "primary bedroom". */
  type?: string;
  /** How many of this room to create (default 1). */
  count?: number;
  /** Explicit interior width override, in feet (only when the user gave a size). */
  widthFt?: number;
  /** Explicit interior depth override, in feet. */
  heightFt?: number;
  /**
   * The LLM's best-guess typical interior width (feet) for this room name. Used
   * ONLY as a fallback for room types the catalog doesn't recognize — the catalog
   * always wins for known types. Lets obscure names ("wine cellar", "sauna") still
   * get a sensible size instead of the generic default.
   */
  estimatedWidthFt?: number;
  /** The LLM's best-guess typical interior depth (feet); fallback for unknown types. */
  estimatedHeightFt?: number;
}

/** A natural-language room request parsed into a list of typed items. */
export interface RoomSpec {
  rooms: RoomRequestItem[];
}

/** The single tool the model must fill — its schema mirrors {@link RoomSpec}. */
const CREATE_ROOMS_TOOL = {
  name: 'create_rooms',
  description: 'Record the rooms the user asked to create on the floorplan.',
  input_schema: {
    type: 'object',
    properties: {
      rooms: {
        type: 'array',
        description: 'One entry per distinct room request in the prompt.',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              description:
                'The room type / name exactly as the user refers to it, e.g. "kitchen", ' +
                '"primary bedroom", "garage". Use the singular form.',
            },
            count: {
              type: 'integer',
              description: 'How many of this room (default 1 if unspecified).',
            },
            widthFt: {
              type: 'number',
              description:
                'Interior width in feet — ONLY if the user explicitly stated a size; ' +
                'otherwise omit it (the app supplies a typical size).',
            },
            heightFt: {
              type: 'number',
              description:
                'Interior depth in feet — ONLY if the user explicitly stated a size; ' +
                'otherwise omit it.',
            },
            estimatedWidthFt: {
              type: 'number',
              description:
                'ALWAYS provide your best estimate of a typical interior WIDTH in feet ' +
                'for this room based on its name. The app uses it only as a fallback for ' +
                "rooms it doesn't already know.",
            },
            estimatedHeightFt: {
              type: 'number',
              description:
                'ALWAYS provide your best estimate of a typical interior DEPTH in feet ' +
                'for this room based on its name (fallback for unknown rooms).',
            },
          },
        },
      },
    },
  },
} as const;

const KNOWN_LABELS = RESIDENTIAL_ROOMS.map((r) => r.label).join(', ');

const SYSTEM_PROMPT =
  'You convert a natural-language request for RESIDENTIAL floorplan rooms into the ' +
  'create_rooms tool. List each distinct room the user asks for as an item with its ' +
  'type (the room name, verbatim and singular) and count. Rules for sizes: only set ' +
  'widthFt/heightFt when the user EXPLICITLY states a size (e.g. "a 20x20 garage") — ' +
  'the app otherwise supplies a typical size from its own catalog and prioritises it. ' +
  'Separately, ALWAYS fill estimatedWidthFt/estimatedHeightFt with your best guess of a ' +
  "typical interior size in feet for that room name; the app uses this only as a fallback " +
  'for rooms it does not recognise (e.g. "wine cellar", "sauna"). Tolerate typos and ' +
  'varied phrasing. The catalog already knows these room types (map close synonyms to the ' +
  'nearest one): ' +
  KNOWN_LABELS +
  '. A size like 15x15 or 15′×15′ means 15 by 15 feet.';

/**
 * Parse a room-generation prompt into a structured list of room requests. Prefers
 * the Anthropic LLM (handles free-form phrasing + typos) but falls back to a small
 * deterministic parser when no API key is set or the request fails. Empty input
 * yields an empty list.
 */
export async function parsePrompt(text: string): Promise<RoomSpec> {
  const trimmed = text.trim();
  if (!trimmed) return { rooms: [] };

  const key = import.meta.env.VITE_ANTHROPIC_API_KEY;
  if (!key) return parsePromptLocally(trimmed);

  try {
    return await parseWithLLM(trimmed, key);
  } catch (err) {
    console.warn('[prompt] LLM parse failed; using local fallback:', err);
    return parsePromptLocally(trimmed);
  }
}

async function parseWithLLM(text: string, key: string): Promise<RoomSpec> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      // Required for direct browser calls (this app is client-side; see README).
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      tools: [CREATE_ROOMS_TOOL],
      tool_choice: { type: 'tool', name: 'create_rooms' },
      messages: [{ role: 'user', content: text }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}`);

  const data = (await res.json()) as {
    content: Array<{ type: string; name?: string; input?: unknown }>;
  };
  const block = data.content.find((b) => b.type === 'tool_use' && b.name === 'create_rooms');
  if (!block?.input) throw new Error('No create_rooms tool_use block in response');
  return sanitize(block.input as Record<string, unknown>);
}

/** Coerce the model's output into a validated list of room requests. */
function sanitize(raw: Record<string, unknown>): RoomSpec {
  const rooms: RoomRequestItem[] = [];
  const list = Array.isArray(raw.rooms) ? raw.rooms : [];
  for (const entry of list) {
    if (rooms.length >= MAX_PROMPT_ROOMS) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const item: RoomRequestItem = {};
    if (typeof e.type === 'string' && e.type.trim()) item.type = e.type.trim();
    if (typeof e.count === 'number' && e.count > 0) {
      item.count = Math.min(MAX_PROMPT_ROOMS, Math.floor(e.count));
    }
    if (typeof e.widthFt === 'number' && e.widthFt > 0) item.widthFt = e.widthFt;
    if (typeof e.heightFt === 'number' && e.heightFt > 0) item.heightFt = e.heightFt;
    if (typeof e.estimatedWidthFt === 'number' && e.estimatedWidthFt > 0) {
      item.estimatedWidthFt = e.estimatedWidthFt;
    }
    if (typeof e.estimatedHeightFt === 'number' && e.estimatedHeightFt > 0) {
      item.estimatedHeightFt = e.estimatedHeightFt;
    }
    // Keep an item only if it carries a type or an explicit size.
    if (item.type || (item.widthFt != null && item.heightFt != null)) rooms.push(item);
  }
  return { rooms };
}

/** Matches a W×H size (e.g. 15x15, 15'×15', 12 by 14). */
const DIMS_RE =
  /(\d+(?:\.\d+)?)\s*(?:'|′|ft|feet|foot)?\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)\s*(?:'|′|ft|feet|foot)?/i;

/** All catalog aliases (plus keys/labels), longest first, for greedy matching. */
const ALIAS_INDEX: Array<{ alias: string; type: string }> = RESIDENTIAL_ROOMS.flatMap((r) => [
  { alias: r.label.toLowerCase(), type: r.label },
  ...r.aliases.map((a) => ({ alias: a, type: r.label })),
]).sort((a, b) => b.alias.length - a.alias.length);

/** Find the catalog room type named in a text segment (longest alias wins), or null. */
function findTypeInSegment(seg: string): string | null {
  const s = ` ${seg.toLowerCase().replace(/\s+/g, ' ')} `;
  for (const { alias, type } of ALIAS_INDEX) {
    // Word-ish boundary match so "bath" doesn't fire inside "bathrobe", but the
    // alias may itself contain spaces (e.g. "half bath").
    if (s.includes(` ${alias} `) || s.includes(` ${alias}s `) || s.includes(`${alias} `)) {
      return type;
    }
  }
  return null;
}

/**
 * Deterministic fallback. Splits the prompt on commas / "and", and for each
 * segment pulls a count, an optional explicit W×H, and a catalog room type. Also
 * handles the legacy generic phrasing "5 15x15 rooms" (no type → a generic room).
 * Used when there's no API key or the LLM call fails.
 */
export function parsePromptLocally(text: string): RoomSpec {
  const rooms: RoomRequestItem[] = [];
  const segments = text.split(/,|\band\b/i);

  for (const rawSeg of segments) {
    if (rooms.length >= MAX_PROMPT_ROOMS) break;
    const seg = rawSeg.trim();
    if (!seg) continue;

    const item: RoomRequestItem = {};

    // Explicit size override (blank it out so its digits aren't read as a count).
    let rest = seg;
    const dims = seg.match(DIMS_RE);
    if (dims) {
      item.widthFt = parseFloat(dims[1]);
      item.heightFt = parseFloat(dims[2]);
      rest = seg.replace(dims[0], ' ');
    }

    // Count: a leading number, or "a"/"an" → 1.
    const num = rest.match(/(\d+(?:\.\d+)?)/);
    if (num) item.count = Math.max(1, Math.floor(parseFloat(num[1])));
    else if (/\b(a|an)\b/i.test(rest)) item.count = 1;

    // Room type from the catalog.
    const type = findTypeInSegment(rest);
    if (type) item.type = type;

    if (item.type || (item.widthFt != null && item.heightFt != null)) {
      rooms.push(item);
    }
  }

  return { rooms };
}
