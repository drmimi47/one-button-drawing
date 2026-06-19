/**
 * ============================================================================
 *  FACADE ASSEMBLY METADATA — the "smart panel" data layer.
 * ============================================================================
 *
 * Each facade assembly TYPE (keyed by the shape's `name`, e.g. "UCWP") carries a sheet of real
 * construction data. This is a property of the TYPE, not the individual panel — editing it in the
 * inspector updates every panel of that assembly, and the visually-relevant fields are woven into the
 * AI render prompt so the image reflects the actual assembly.
 *
 * The schema is intentionally flexible (all fields optional): glazed assemblies (curtain walls) use the
 * glass/thermal/framing fields; opaque assemblies (cladding / infill) use the material/joint fields.
 * The per-category field SETS below decide which rows the inspector shows.
 *
 * This module is the leaf of the facade layer (no facade imports), so it owns
 * {@link DEFAULT_FACADE_ASSEMBLY}; `catalog.ts` and `assemblies.ts` build on it.
 */

/** The assembly a plain dropped shape defaults to in Facade mode (unitized curtain wall). */
export const DEFAULT_FACADE_ASSEMBLY = 'UCWP';

/** One assembly's editable data sheet. Fields are optional; the type's category selects which apply. */
export interface AssemblyMetadata {
  // --- Glazed (curtain walls) ---
  glassType?: string;
  glassMakeup?: string;
  glassTint?: string;
  uFactor?: number; // Btu/h·ft²·°F (assembly NFRC U-factor) — used by both glazed & opaque
  shgc?: number; // solar heat gain coefficient (0–1)
  vlt?: number; // visible light transmittance (0–1)
  frameMetal?: string;
  frameFinish?: string;
  mullionWidthIn?: number; // glazed BAND field — the visible mullion face width (drives the canvas band)
  mullionDepthIn?: number; // informational (system depth, into the page)
  // --- Opaque (cladding / infill / mixed) ---
  material?: string;
  finishColor?: string;
  jointWidthIn?: number; // opaque BAND field — the joint/reveal width (drives the canvas band)
  insulation?: string;
}

/* -------------------------------------------------------------------------- */
/*  Option lists for the select fields                                         */
/* -------------------------------------------------------------------------- */

export const GLASS_TYPES = [
  'Double-glazed low-E IGU (low-iron)',
  'Double-glazed low-E IGU (clear)',
  'Triple-glazed low-E IGU',
  'Laminated low-E IGU',
  'Single-glazed (monolithic)',
];

export const GLASS_TINTS = [
  'Neutral / subtle blue-green',
  'Clear',
  'Blue',
  'Green',
  'Grey',
  'Bronze',
];

export const FRAME_METALS = [
  'Thermally-broken extruded aluminium (6063-T6)',
  'Non-thermal extruded aluminium',
  'Steel',
  'Stainless steel',
];

export const FRAME_FINISHES = [
  'Matte silver-grey PVDF (Kynar 500)',
  'Clear anodized',
  'Dark bronze anodized',
  'Champagne anodized',
  'Black PVDF',
];

export const INSULATIONS = ['Mineral wool, R-13', 'Rigid polyiso, R-12', 'Spray foam, R-15', 'None'];

export const CLADDING_MATERIALS = [
  'Aluminium composite panel (ACM)',
  'Fibre-cement panel',
  'Face brick veneer',
  'Architectural precast concrete',
  'Terracotta rainscreen',
  'Natural stone',
  'Profiled metal panel',
  'Perforated metal mesh',
  'Woven wire mesh',
  'Timber board',
];

export const CLADDING_FINISHES = [
  'Warm grey',
  'Charcoal',
  'Off-white',
  'Terracotta red',
  'Sand / buff',
  'Weathered steel (corten)',
  'Natural timber',
  'Concrete grey',
];

/* -------------------------------------------------------------------------- */
/*  Field schema — the inspector maps over these to render rows                */
/* -------------------------------------------------------------------------- */

/** A field row in the inspector; the inspector maps over a group's fields to render them. */
export interface FacadeField {
  key: keyof AssemblyMetadata;
  label: string;
  kind: 'number' | 'select' | 'text';
  unit?: string;
  options?: string[];
  /** Step for number inputs (defaults to 1). */
  step?: number;
}

/** A labelled group of fields (a section in the inspector). */
export interface FacadeFieldGroup {
  title: string;
  fields: FacadeField[];
}

/** Fields shown for GLAZED assemblies (curtain walls). The R-value row is derived by the inspector. */
export const GLAZED_FIELD_GROUPS: FacadeFieldGroup[] = [
  {
    title: 'Glass',
    fields: [
      { key: 'glassType', label: 'Glass type', kind: 'select', options: GLASS_TYPES },
      { key: 'glassMakeup', label: 'Makeup', kind: 'text' },
      { key: 'glassTint', label: 'Tint', kind: 'select', options: GLASS_TINTS },
    ],
  },
  {
    title: 'Thermal',
    fields: [
      { key: 'uFactor', label: 'U-factor', kind: 'number', unit: 'Btu/h·ft²·°F', step: 0.01 },
      { key: 'shgc', label: 'SHGC', kind: 'number', step: 0.01 },
      { key: 'vlt', label: 'VLT', kind: 'number', step: 0.01 },
    ],
  },
  {
    title: 'Framing',
    fields: [
      { key: 'frameMetal', label: 'Metal', kind: 'select', options: FRAME_METALS },
      { key: 'frameFinish', label: 'Finish', kind: 'select', options: FRAME_FINISHES },
      { key: 'mullionWidthIn', label: 'Mullion width', kind: 'number', unit: 'in', step: 0.25 },
      { key: 'mullionDepthIn', label: 'Mullion depth', kind: 'number', unit: 'in', step: 0.25 },
    ],
  },
];

/** Fields shown for OPAQUE assemblies (cladding / infill / mixed). */
export const OPAQUE_FIELD_GROUPS: FacadeFieldGroup[] = [
  {
    title: 'Material',
    fields: [
      { key: 'material', label: 'Material', kind: 'select', options: CLADDING_MATERIALS },
      { key: 'finishColor', label: 'Finish', kind: 'select', options: CLADDING_FINISHES },
    ],
  },
  {
    title: 'Thermal',
    fields: [
      { key: 'uFactor', label: 'U-factor', kind: 'number', unit: 'Btu/h·ft²·°F', step: 0.01 },
      { key: 'insulation', label: 'Insulation', kind: 'select', options: INSULATIONS },
    ],
  },
  {
    title: 'Joint',
    fields: [{ key: 'jointWidthIn', label: 'Joint / reveal width', kind: 'number', unit: 'in', step: 0.25 }],
  },
];

/** Thermal resistance (R-value) derived from the assembly U-factor. */
export function derivedRValue(uFactor: number | undefined): number {
  if (!uFactor || uFactor <= 0) return 0;
  return Math.round((1 / uFactor) * 100) / 100;
}

/**
 * Material-specific surface texture cue for an opaque cladding material — what the panel face should
 * actually look like, so brick reads as brick and mesh as mesh (not a blank smooth panel).
 */
export function materialTexture(material: string): string {
  const m = material.toLowerCase();
  if (/brick/.test(m))
    return 'its face built from individual clay bricks laid in a running-bond pattern with visible recessed mortar joints';
  if (/mesh|woven|wire|perforated/.test(m))
    return 'a metallic perforated / woven mesh screen with a fine, regular pattern of openings and visible depth behind it';
  if (/precast|concrete/.test(m))
    return 'a board-formed architectural precast concrete surface with subtle form lines and a matte mineral finish';
  if (/terracotta/.test(m))
    return 'rows of extruded terracotta tiles or baguettes with a matte ceramic surface';
  if (/timber|wood/.test(m))
    return 'vertical timber boards with natural wood grain and fine shadow gaps between boards';
  if (/stone/.test(m))
    return 'honed natural stone panels with subtle veining and stone texture';
  if (/fibre|fiber|cement/.test(m))
    return 'smooth flat fibre-cement panels with a fine matte texture';
  if (/profiled metal/.test(m))
    return 'ribbed / profiled metal sheet with regular vertical corrugations';
  if (/composite|acm|metal/.test(m))
    return 'flat metal composite panels with a smooth, evenly painted matte surface';
  return 'a solid panelised cladding surface with realistic material texture';
}

/**
 * Turn an assembly's metadata into a render-prompt clause describing how it LOOKS. Only visually
 * meaningful fields are used; performance numbers (U/R/SHGC/VLT) are inspector-only. Branches on
 * whether the assembly is glazed (glass + mullions) or opaque (solid cladding material + joints).
 */
export function metadataToRenderClause(meta: AssemblyMetadata, glazed: boolean): string {
  if (glazed) {
    const glassType = meta.glassType ?? 'double-glazed low-iron';
    const lowIron = /low-iron/i.test(glassType);
    const triple = /triple/i.test(glassType);
    const laminated = /laminated/i.test(glassType);
    const tint = (meta.glassTint ?? 'neutral').toLowerCase();
    const glassDesc =
      `${triple ? 'triple-glazed' : laminated ? 'laminated double-glazed' : 'double-glazed'} ` +
      `${lowIron ? 'low-iron ' : ''}architectural glass with a ${tint} tint and a soft low-E reflective sheen`;
    const metal = (meta.frameMetal ?? 'aluminium').replace(/\s*\(.*\)\s*/, '').toLowerCase();
    const finish = (meta.frameFinish ?? 'silver-grey').toLowerCase();
    const sightline = meta.mullionWidthIn ?? 2.5;
    return (
      `a glazed curtain wall in which each panel is ONE single, continuous sheet of ${glassDesc}, set in ` +
      `slender ${finish} ${metal} mullions and perimeter frames with roughly ${sightline}-inch sightlines ` +
      `(no internal bars)`
    );
  }
  const material = (meta.material ?? 'cladding panel').toLowerCase();
  const finish = (meta.finishColor ?? 'neutral').toLowerCase();
  const joint = meta.jointWidthIn ?? 0.5;
  return (
    `an opaque, solid ${material} facade in a ${finish} finish — ${materialTexture(meta.material ?? '')}. ` +
    `Each drawn panel is a solid, opaque cladding unit (definitely NOT glass — no transparency, no glazing, ` +
    `no glossy reflections), separated from its neighbours by crisp ${joint}-inch recessed joints`
  );
}
