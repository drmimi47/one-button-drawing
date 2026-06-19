import { WORLD_UNITS_PER_FOOT } from '../constants';
import {
  DEFAULT_FACADE_ASSEMBLY,
  GLAZED_FIELD_GROUPS,
  OPAQUE_FIELD_GROUPS,
  type AssemblyMetadata,
  type FacadeFieldGroup,
} from './metadata';

/**
 * ============================================================================
 *  FACADE CATALOG — the curated list of real facade assembly TYPES.
 * ============================================================================
 *
 * Each type is chosen from the inspector's title dropdown (grouped by category). A type carries its
 * default canvas geometry (panel size + the visible mullion/joint BAND width that maps to the on-canvas
 * wall band) and a category-appropriate metadata sheet. Glazed types (curtain walls) use the
 * glass/framing fields; opaque types (cladding / infill / mixed) use the material/joint fields.
 *
 * Values are representative for a prototype — a future materials database refines them. Adding a type
 * is one entry here.
 */

export type FacadeCategory = 'Curtain Walls' | 'Cladding Walls' | 'Infill Walls' | 'Mixed Walls';

export interface FacadeTypeDef {
  /** Short code stored on `Square.name` and used as the metadata key (e.g. "UCWP"). */
  key: string;
  /** Full display title shown in the inspector + dropdown. */
  label: string;
  category: FacadeCategory;
  /** Glazed → glass fields + glass render clause; opaque → material fields + cladding clause. */
  glazed: boolean;
  /** Which metadata field is the visible band width (mullion for glazed, joint for opaque). */
  bandField: 'mullionWidthIn' | 'jointWidthIn';
  /** Default panel proportions (interior) in feet, applied to NEWLY dropped panels of this type. */
  defaultWidthFt: number;
  defaultHeightFt: number;
  /** The default data sheet (includes the band value on `bandField`). */
  defaultMeta: AssemblyMetadata;
}

/* -------------------------------------------------------------------------- */
/*  Unit + band helpers                                                        */
/* -------------------------------------------------------------------------- */

/** Inches → world units (1 ft = WORLD_UNITS_PER_FOOT). */
export function inchesToWorld(inches: number): number {
  return (inches / 12) * WORLD_UNITS_PER_FOOT;
}

/** World units → inches. */
export function worldToInches(world: number): number {
  return (world / WORLD_UNITS_PER_FOOT) * 12;
}

/** Feet → world units. */
export function feetToWorld(feet: number): number {
  return feet * WORLD_UNITS_PER_FOOT;
}

/* -------------------------------------------------------------------------- */
/*  Catalog                                                                    */
/* -------------------------------------------------------------------------- */

/** Shared glazed defaults (curtain-wall family), overridden per type. */
const glazedBase: AssemblyMetadata = {
  glassType: 'Double-glazed low-E IGU (low-iron)',
  glassMakeup: '1" IGU — 6mm low-E / 1/2" argon / 6mm',
  glassTint: 'Neutral / subtle blue-green',
  uFactor: 0.34,
  shgc: 0.39,
  vlt: 0.7,
  frameMetal: 'Thermally-broken extruded aluminium (6063-T6)',
  frameFinish: 'Matte silver-grey PVDF (Kynar 500)',
  mullionWidthIn: 2.5,
  mullionDepthIn: 8,
};

export const FACADE_CATALOG: FacadeTypeDef[] = [
  // ---- Curtain Walls (glazed) ----
  {
    key: DEFAULT_FACADE_ASSEMBLY, // 'UCWP'
    label: 'Unitized Curtain Wall',
    category: 'Curtain Walls',
    glazed: true,
    bandField: 'mullionWidthIn',
    defaultWidthFt: 5,
    defaultHeightFt: 12,
    defaultMeta: { ...glazedBase, mullionWidthIn: 2.5, mullionDepthIn: 8 },
  },
  {
    key: 'STICK',
    label: 'Stick-Built Curtain Wall',
    category: 'Curtain Walls',
    glazed: true,
    bandField: 'mullionWidthIn',
    defaultWidthFt: 5,
    defaultHeightFt: 12,
    defaultMeta: { ...glazedBase, mullionWidthIn: 2.75, mullionDepthIn: 6 },
  },
  {
    key: 'SSG',
    label: 'Structural Silicone Glazing',
    category: 'Curtain Walls',
    glazed: true,
    bandField: 'mullionWidthIn',
    defaultWidthFt: 5,
    defaultHeightFt: 10,
    defaultMeta: {
      ...glazedBase,
      frameMetal: 'Steel',
      frameFinish: 'Clear anodized',
      mullionWidthIn: 1,
      mullionDepthIn: 6,
    },
  },
  {
    key: 'SPIDER',
    label: 'Spider / Point-Fixed Glazing',
    category: 'Curtain Walls',
    glazed: true,
    bandField: 'mullionWidthIn',
    defaultWidthFt: 6,
    defaultHeightFt: 10,
    defaultMeta: {
      ...glazedBase,
      glassType: 'Laminated low-E IGU',
      frameMetal: 'Stainless steel',
      frameFinish: 'Clear anodized',
      mullionWidthIn: 1,
      mullionDepthIn: 4,
    },
  },
  {
    key: 'DSF',
    label: 'Double-Skin Facade',
    category: 'Curtain Walls',
    glazed: true,
    bandField: 'mullionWidthIn',
    defaultWidthFt: 5,
    defaultHeightFt: 12,
    defaultMeta: { ...glazedBase, uFactor: 0.24, mullionWidthIn: 3, mullionDepthIn: 12 },
  },
  // ---- Cladding Walls (opaque) ----
  {
    key: 'METALCLAD',
    label: 'Lightweight Metal Cladding',
    category: 'Cladding Walls',
    glazed: false,
    bandField: 'jointWidthIn',
    defaultWidthFt: 4,
    defaultHeightFt: 10,
    defaultMeta: {
      material: 'Aluminium composite panel (ACM)',
      finishColor: 'Charcoal',
      uFactor: 0.1,
      insulation: 'Mineral wool, R-13',
      jointWidthIn: 1,
    },
  },
  {
    key: 'BRICK',
    label: 'Brick Veneer',
    category: 'Cladding Walls',
    glazed: false,
    bandField: 'jointWidthIn',
    defaultWidthFt: 8,
    defaultHeightFt: 8,
    defaultMeta: {
      material: 'Face brick veneer',
      finishColor: 'Terracotta red',
      uFactor: 0.1,
      insulation: 'Mineral wool, R-13',
      jointWidthIn: 1,
    },
  },
  {
    key: 'PRECAST',
    label: 'Precast Concrete Cladding',
    category: 'Cladding Walls',
    glazed: false,
    bandField: 'jointWidthIn',
    defaultWidthFt: 10,
    defaultHeightFt: 20,
    defaultMeta: {
      material: 'Architectural precast concrete',
      finishColor: 'Concrete grey',
      uFactor: 0.14,
      insulation: 'Rigid polyiso, R-12',
      jointWidthIn: 1.5,
    },
  },
  {
    key: 'MONO',
    label: 'Monolithic Cladding',
    category: 'Cladding Walls',
    glazed: false,
    bandField: 'jointWidthIn',
    defaultWidthFt: 8,
    defaultHeightFt: 10,
    defaultMeta: {
      material: 'Fibre-cement panel',
      finishColor: 'Off-white',
      uFactor: 0.12,
      insulation: 'Mineral wool, R-13',
      jointWidthIn: 1,
    },
  },
  // ---- Infill Walls (opaque) ----
  {
    key: 'MASONRY',
    label: 'Masonry Infill',
    category: 'Infill Walls',
    glazed: false,
    bandField: 'jointWidthIn',
    defaultWidthFt: 12,
    defaultHeightFt: 12,
    defaultMeta: {
      material: 'Face brick veneer',
      finishColor: 'Sand / buff',
      uFactor: 0.18,
      insulation: 'Mineral wool, R-13',
      jointWidthIn: 4,
    },
  },
  {
    key: 'TIMBER',
    label: 'Timber Infill',
    category: 'Infill Walls',
    glazed: false,
    bandField: 'jointWidthIn',
    defaultWidthFt: 10,
    defaultHeightFt: 10,
    defaultMeta: {
      material: 'Timber board',
      finishColor: 'Natural timber',
      uFactor: 0.16,
      insulation: 'Spray foam, R-15',
      jointWidthIn: 3,
    },
  },
  {
    key: 'STEELINF',
    label: 'Steel Infill',
    category: 'Infill Walls',
    glazed: false,
    bandField: 'jointWidthIn',
    defaultWidthFt: 12,
    defaultHeightFt: 12,
    defaultMeta: {
      material: 'Profiled metal panel',
      finishColor: 'Charcoal',
      uFactor: 0.15,
      insulation: 'Mineral wool, R-13',
      jointWidthIn: 3,
    },
  },
  // ---- Mixed Walls ----
  {
    key: 'VENT',
    label: 'Ventilated Rainscreen System',
    category: 'Mixed Walls',
    glazed: false,
    bandField: 'jointWidthIn',
    defaultWidthFt: 4,
    defaultHeightFt: 10,
    defaultMeta: {
      material: 'Terracotta rainscreen',
      finishColor: 'Terracotta red',
      uFactor: 0.11,
      insulation: 'Mineral wool, R-13',
      jointWidthIn: 1.5,
    },
  },
  {
    key: 'MESH',
    label: 'Metal Mesh Screen',
    category: 'Mixed Walls',
    glazed: false,
    bandField: 'jointWidthIn',
    defaultWidthFt: 5,
    defaultHeightFt: 12,
    defaultMeta: {
      material: 'Perforated metal mesh',
      finishColor: 'Weathered steel (corten)',
      uFactor: 0.6,
      insulation: 'None',
      jointWidthIn: 1,
    },
  },
];

/** Catalog grouped by category, in declaration order — drives the inspector's grouped dropdown. */
export const FACADE_CATEGORIES: { title: FacadeCategory; types: FacadeTypeDef[] }[] = (() => {
  const order: FacadeCategory[] = ['Curtain Walls', 'Cladding Walls', 'Infill Walls', 'Mixed Walls'];
  return order.map((title) => ({ title, types: FACADE_CATALOG.filter((t) => t.category === title) }));
})();

const BY_KEY = new Map(FACADE_CATALOG.map((t) => [t.key, t]));

/** The type def for a key, falling back to the default assembly. */
export function facadeType(key: string | undefined): FacadeTypeDef {
  return BY_KEY.get(key ?? '') ?? BY_KEY.get(DEFAULT_FACADE_ASSEMBLY)!;
}

/** The field groups (glazed vs opaque) for a type. */
export function fieldGroupsFor(key: string | undefined): FacadeFieldGroup[] {
  return facadeType(key).glazed ? GLAZED_FIELD_GROUPS : OPAQUE_FIELD_GROUPS;
}

/** A fresh metadata store seeded with every catalog type's default sheet. */
export function seedAssemblyMetadata(): Record<string, AssemblyMetadata> {
  const store: Record<string, AssemblyMetadata> = {};
  for (const t of FACADE_CATALOG) store[t.key] = { ...t.defaultMeta };
  return store;
}

/** The metadata sheet for an assembly key from the store, falling back to the catalog default. */
export function metadataForAssembly(
  store: Record<string, AssemblyMetadata>,
  key: string | undefined,
): AssemblyMetadata {
  return store[key ?? ''] ?? facadeType(key).defaultMeta;
}

/** The band width (inches) for an assembly's metadata — reads the type's band field. */
export function bandInchesFor(meta: AssemblyMetadata, key: string): number {
  const def = facadeType(key);
  return (meta[def.bandField] as number | undefined) ?? (def.defaultMeta[def.bandField] as number) ?? 2.5;
}

/** A copy of `meta` with the band width (inches) written into the type's band field. */
export function withBandInches(meta: AssemblyMetadata, key: string, inches: number): AssemblyMetadata {
  return { ...meta, [facadeType(key).bandField]: inches };
}
