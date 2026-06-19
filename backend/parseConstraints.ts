import type { Constraints } from './types';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

/** The single tool the model must fill — its schema mirrors {@link Constraints}. */
const SET_CONSTRAINTS_TOOL = {
  name: 'set_constraints',
  description: 'Record the floorplan design constraints described by the user.',
  input_schema: {
    type: 'object',
    properties: {
      minWallThicknessInches: {
        type: 'number',
        description: 'Minimum thickness of any wall, in inches.',
      },
      maxWallThicknessInches: {
        type: 'number',
        description: 'Maximum thickness of any wall, in inches.',
      },
      maxRoomAreaSqft: {
        type: 'number',
        description: 'Maximum interior area of any single room, in square feet.',
      },
      minRoomAreaSqft: {
        type: 'number',
        description: 'Minimum interior area every room must maintain, in square feet.',
      },
      minRoomSideFt: {
        type: 'number',
        description: 'Minimum length of any single room side (interior edge), in feet.',
      },
      maxTotalAreaSqft: {
        type: 'number',
        description:
          'Maximum TOTAL combined interior area of ALL rooms together (a global budget ' +
          'across the whole floorplan, not per-room), in square feet.',
      },
      maxTotalGrossAreaSqft: {
        type: 'number',
        description:
          'Maximum TOTAL GROSS area of ALL rooms together — each room\'s outer footprint ' +
          'including its wall thickness (interior area plus the wall band), summed across ' +
          'the whole floorplan, in square feet. Distinct from maxTotalAreaSqft, which is ' +
          'interior-only.',
      },
      maxRoomCount: {
        type: 'integer',
        description:
          'Maximum NUMBER of rooms allowed on the whole floorplan (a global count of ' +
          'rooms, not an area or a size).',
      },
    },
  },
} as const;

const SYSTEM_PROMPT =
  'You convert floorplan design constraints written in plain English into the ' +
  'set_constraints tool. Only include fields the user actually states; omit the ' +
  "rest. Convert each value to the unit named in that field's description " +
  '(inches, feet, or square feet) — e.g. 5 feet → 5 for a feet field, 5 feet → 60 ' +
  'for an inches field.';

/**
 * Removes Python-style comment lines — any line whose first non-whitespace
 * character is `#` (e.g. "# note" or "#note") — so users can annotate the
 * Constraints box with text the parser (and the LLM) ignore entirely.
 */
export function stripComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * Parse the constraints text into the structured schema. Prefers the Anthropic
 * LLM (handles free-form phrasing) but falls back to a small deterministic parser
 * when no API key is set or the request fails — so the app always works, key or
 * not. Comment lines are stripped first; empty input yields no constraints.
 */
export async function parseConstraints(text: string): Promise<Constraints> {
  const trimmed = stripComments(text).trim();
  if (!trimmed) return {};

  const key = import.meta.env.VITE_ANTHROPIC_API_KEY;
  if (!key) return parseConstraintsLocally(trimmed);

  try {
    return await parseWithLLM(trimmed, key);
  } catch (err) {
    console.warn('[constraints] LLM parse failed; using local fallback:', err);
    return parseConstraintsLocally(trimmed);
  }
}

async function parseWithLLM(text: string, key: string): Promise<Constraints> {
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
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      tools: [SET_CONSTRAINTS_TOOL],
      tool_choice: { type: 'tool', name: 'set_constraints' },
      messages: [{ role: 'user', content: text }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}`);

  const data = (await res.json()) as {
    content: Array<{ type: string; name?: string; input?: unknown }>;
  };
  const block = data.content.find((b) => b.type === 'tool_use' && b.name === 'set_constraints');
  if (!block?.input) throw new Error('No set_constraints tool_use block in response');
  return sanitize(block.input as Record<string, unknown>);
}

/** Keep only the known positive-number fields, dropping anything malformed. */
function sanitize(raw: Record<string, unknown>): Constraints {
  const out: Constraints = {};
  if (typeof raw.minWallThicknessInches === 'number' && raw.minWallThicknessInches > 0) {
    out.minWallThicknessInches = raw.minWallThicknessInches;
  }
  if (typeof raw.maxWallThicknessInches === 'number' && raw.maxWallThicknessInches > 0) {
    out.maxWallThicknessInches = raw.maxWallThicknessInches;
  }
  if (typeof raw.maxRoomAreaSqft === 'number' && raw.maxRoomAreaSqft > 0) {
    out.maxRoomAreaSqft = raw.maxRoomAreaSqft;
  }
  if (typeof raw.minRoomAreaSqft === 'number' && raw.minRoomAreaSqft > 0) {
    out.minRoomAreaSqft = raw.minRoomAreaSqft;
  }
  if (typeof raw.minRoomSideFt === 'number' && raw.minRoomSideFt > 0) {
    out.minRoomSideFt = raw.minRoomSideFt;
  }
  if (typeof raw.maxTotalAreaSqft === 'number' && raw.maxTotalAreaSqft > 0) {
    out.maxTotalAreaSqft = raw.maxTotalAreaSqft;
  }
  if (typeof raw.maxTotalGrossAreaSqft === 'number' && raw.maxTotalGrossAreaSqft > 0) {
    out.maxTotalGrossAreaSqft = raw.maxTotalGrossAreaSqft;
  }
  if (typeof raw.maxRoomCount === 'number' && raw.maxRoomCount > 0) {
    out.maxRoomCount = Math.floor(raw.maxRoomCount);
  }
  return out;
}

/**
 * Deterministic fallback covering the known vocabulary. Recognises lines like
 * `minimum wall thickness 3"` and `max room area 200 sq ft`. Used when there's no
 * API key or the LLM call fails, so the seeded constraint keeps working offline.
 */
export function parseConstraintsLocally(text: string): Constraints {
  const out: Constraints = {};
  text = stripComments(text); // ignore any annotation lines, same as the LLM path

  const minWall = text.match(
    /min(?:imum)?\s+wall\s+thickness\s+(\d+(?:\.\d+)?)\s*(?:"|in\b|inch|inches)?/i,
  );
  if (minWall) out.minWallThicknessInches = parseFloat(minWall[1]);

  const maxWall = text.match(
    /max(?:imum)?\s+wall\s+thickness\s+(\d+(?:\.\d+)?)\s*(?:"|in\b|inch|inches)?/i,
  );
  if (maxWall) out.maxWallThicknessInches = parseFloat(maxWall[1]);

  const maxArea = text.match(
    /max(?:imum)?\s+(?:room\s+)?(?:size|area)\s+(\d+(?:\.\d+)?)\s*(?:sq\s*\.?\s*ft|ft2|ft²|square\s+feet)?/i,
  );
  if (maxArea) out.maxRoomAreaSqft = parseFloat(maxArea[1]);

  // Min room area, e.g. "area ≥ 36 sq ft", "minimum room area 36", "at least 36 sq ft".
  const minArea = text.match(
    /(?:area\s*(?:≥|>=|of at least|at least)|min(?:imum)?\s+(?:room\s+)?area)\s*(\d+(?:\.\d+)?)\s*(?:sq\s*\.?\s*ft|ft2|ft²|square\s+feet)?/i,
  );
  if (minArea) out.minRoomAreaSqft = parseFloat(minArea[1]);

  // Min room side length (feet), e.g. "no room side may become < 5'", "min side 5 ft".
  const minSide = text.match(
    /side\b[^\n]*?(\d+(?:\.\d+)?)\s*(?:'|ft\b|feet|foot)/i,
  );
  if (minSide) out.minRoomSideFt = parseFloat(minSide[1]);

  // Max TOTAL area (global), e.g. "Maximum total area 5,000 sq ft" or "total area
  // must not exceed 5000". Numbers may be comma-grouped, so strip commas. Checked
  // before nothing else captures it; "total" distinguishes it from per-room max area.
  const maxTotal =
    text.match(
      /max(?:imum)?\s+total\s+(?:combined\s+)?area\s+(\d[\d,]*(?:\.\d+)?)\s*(?:sq\s*\.?\s*ft|ft2|ft²|square\s+feet)?/i,
    ) ??
    text.match(
      /total\s+(?:combined\s+)?area\b[^\n]*?(?:exceed|over|above|more than|max(?:imum)?|under|below|no more than|≤|<=)\D*?(\d[\d,]*(?:\.\d+)?)/i,
    );
  if (maxTotal) out.maxTotalAreaSqft = parseFloat(maxTotal[1].replace(/,/g, ''));

  // Max TOTAL GROSS area (global) — the outer footprints summed, e.g. "Maximum total
  // gross area 20,000 sq ft". The word "gross" distinguishes it from the interior
  // total above; numbers may be comma-grouped.
  const maxGross =
    text.match(
      /max(?:imum)?\s+(?:total\s+)?gross\s+(?:total\s+)?area\s+(\d[\d,]*(?:\.\d+)?)\s*(?:sq\s*\.?\s*ft|ft2|ft²|square\s+feet)?/i,
    ) ??
    text.match(
      /gross\s+(?:total\s+)?area\b[^\n]*?(?:exceed|over|above|more than|max(?:imum)?|under|below|no more than|≤|<=)\D*?(\d[\d,]*(?:\.\d+)?)/i,
    );
  if (maxGross) out.maxTotalGrossAreaSqft = parseFloat(maxGross[1].replace(/,/g, ''));

  // Max ROOM COUNT (global), e.g. "Maximum room count 100", "max rooms 50", "no more
  // than 50 rooms". Integer; "count"/"rooms" keeps it clear of the area rules above.
  const maxRooms =
    text.match(/max(?:imum)?\s+(?:number\s+of\s+)?rooms?\s+count\s+(\d+)/i) ??
    text.match(/max(?:imum)?\s+room\s+count\s+(\d+)/i) ??
    text.match(/max(?:imum)?\s+(?:number\s+of\s+)?rooms?\s+(\d+)/i) ??
    text.match(/(?:no more than|up to|at most|≤|<=)\s*(\d+)\s+rooms?\b/i);
  if (maxRooms) out.maxRoomCount = parseInt(maxRooms[1], 10);

  return out;
}
