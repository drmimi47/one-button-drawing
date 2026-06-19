import type { Square } from '../types';
import { DEFAULT_FACADE_ASSEMBLY, metadataToRenderClause, type AssemblyMetadata } from './metadata';
import { facadeType, metadataForAssembly } from './catalog';

/**
 * ============================================================================
 *  FACADE ASSEMBLIES — naming + prompt for the facade "layer of information".
 * ============================================================================
 *
 * In Facade mode each shape's `name` is a facade assembly TYPE key (from the {@link FACADE_CATALOG}).
 * The AI renderer never sees free text — {@link buildRenderPrompt} composes the prompt from each
 * assembly's live {@link AssemblyMetadata} (the inspector's data sheet) so the panel's real specs drive
 * the look. Glazed types render as glass + mullions; opaque types render as solid cladding + joints.
 */

// Re-export so existing `from './assemblies'` import sites keep working; the constant lives in
// metadata.ts (the leaf module) to avoid an import cycle.
export { DEFAULT_FACADE_ASSEMBLY };

/**
 * The full, human-readable assembly title for a (short) type key — e.g. "UCWP" →
 * "Unitized Curtain Wall". Falls back to the key itself for anything not in the catalog, so non-facade
 * names pass through unchanged. Used to expand the on-canvas label + the inspector title.
 */
export function fullAssemblyName(name: string | undefined): string {
  const key = name ?? '';
  const def = facadeType(key);
  return def.key === key ? def.label : key;
}

/**
 * Compose the AI render prompt for a set of selected shapes from each assembly's live metadata sheet —
 * the user never types this. The rasterised reference image carries the exact layout; this prompt tells
 * the model what each region is made of (glazing vs solid cladding) and to preserve the arrangement.
 * `metaByAssembly` is the App's metadata store, keyed by assembly name.
 */
export function buildRenderPrompt(
  shapes: Square[],
  metaByAssembly: Record<string, AssemblyMetadata>,
): string {
  // One clause per DISTINCT assembly in the selection, built from its metadata sheet + category.
  const names = [...new Set(shapes.map((s) => s.name ?? DEFAULT_FACADE_ASSEMBLY))];
  const defs = names.map((n) => facadeType(n));
  const allGlazed = defs.every((d) => d.glazed);
  const allOpaque = defs.every((d) => !d.glazed);
  const panelCount = shapes.length;
  const clauses = [
    ...new Set(
      names.map((n) =>
        metadataToRenderClause(metadataForAssembly(metaByAssembly, n), facadeType(n).glazed),
      ),
    ),
  ];
  const assemblyText =
    clauses.length <= 1
      ? clauses[0] ??
        metadataToRenderClause(metadataForAssembly(metaByAssembly, DEFAULT_FACADE_ASSEMBLY), true)
      : clauses.map((c, i) => `(${i + 1}) ${c}`).join('; ');

  // Material rendering instructions — adapt to the selection's category so the model doesn't default to
  // glass. Opaque selections get a hard anti-glass push and are told to show real material texture;
  // glazed selections keep the glass language. (The reference uses GREY panels, not white.)
  const materialLines = allOpaque
    ? [
        'Render every mid-grey panel region as the real, SOLID, OPAQUE material stated above — this',
        'facade is masonry / cladding, NOT a glass curtain wall. Do NOT read any region as glass,',
        'glazing, windows, transparency, mirror or sky reflections.',
        "Give each panel the material's true colour and natural surface texture (for example individual",
        'brick courses with mortar joints for brickwork; the regular perforation pattern of metal mesh;',
        'board lines and grain for timber; a matte mineral face for concrete).',
        'Render the darker bands as the real recessed joints / reveals described above, in the stated',
        'finish.',
      ]
    : allGlazed
      ? [
          'Render every mid-grey panel region as that real architectural glazing: glossy glass in the',
          'stated tint with soft believable sky/daylight reflections and depth — never a flat grey or',
          'white panel.',
          'Render the darker bands as the real metal mullions and perimeter frames described above, in',
          'the stated metal and finish, with a soft metallic sheen.',
        ]
      : [
          'Render each mid-grey panel region as the specific material stated for its assembly above —',
          'some are glazing and some are solid opaque cladding; match each one exactly. Solid cladding',
          'reads as opaque masonry/panel with real surface texture (no transparency, no reflections);',
          'glazing reads as glass.',
          'Render the darker bands as the framing or joints described above, in the stated finish.',
        ];

  // The "no invented subdivision" rule — glass panels stay one clean pane, but opaque panels MUST keep
  // their natural material texture inside each drawn region (brick courses, mesh holes, grain, etc.).
  const subdivisionLine = allOpaque
    ? 'Do not add any EXTRA structural mullions, panel-division lines or seams beyond those drawn — but DO render the material\'s own natural fine texture (brick courses and mortar, mesh perforations, board lines, grain) across each panel.'
    : allGlazed
      ? 'Each mid-grey panel region is ONE single, continuous pane of glass — do not add any internal mullion, bar, division or seam that is not drawn.'
      : 'Do not add EXTRA structural mullions or panel-division lines beyond those drawn; glazed regions stay one clean pane, while opaque regions still show their natural material texture (brick courses, mesh perforations, grain) within the drawn panel.';

  return [
    // Task.
    'Convert this schematic diagram into a single photorealistic architectural photograph of a building',
    'facade, viewed perfectly straight-on (orthographic elevation, no perspective).',
    // How to read the reference — filled tonal regions, not the final look.
    'The reference image is a flat schematic, not the final look. Each MID-GREY region is one facade',
    'panel to render in the material described below. Each DARKER-GREY band around and between the grey',
    'panels is the mullion / joint / frame, drawn at its true thickness. Everything that is PURE WHITE is',
    'background. Replace the greys with real materials and keep every white area pure white.',
    `The facade is ${assemblyText}.`,
    // Materials (category-aware).
    ...materialLines,
    // Geometry lock — the drawn diagram is the ENTIRE facade; nothing exists past it.
    `There are exactly ${panelCount} panel${panelCount === 1 ? '' : 's'} drawn — render exactly that`,
    'many, in their exact drawn positions and sizes; never add, merge, split, shift or resize a panel.',
    'The drawing shows the complete facade and nothing else. Reproduce it exactly and do not move,',
    'resize, add or remove anything.',
    'The framing/joints exist ONLY where a darker-grey band is actually drawn, and every band ends',
    'exactly where its drawn band ends. Do not extend, continue, repeat, thicken or tile any band past',
    'the drawn diagram, and do not invent extra framing, panels, floors or structure beyond the',
    'diagram\'s outer edge. The outer silhouette of the rendered facade must match the drawn outline exactly.',
    subdivisionLine,
    // Background — hard, unconditional rule, independent of everything else in the image.
    'Everything outside the facade outline is the background. The background must be PURE WHITE',
    '(RGB 255,255,255) — every single background pixel fully white. This is absolute and does not depend',
    'on the facade, the lighting or the reflections: never grey, never off-white, never cream or beige,',
    'no gradient, no vignette, no shadow, no floor, no sky and no surrounding buildings behind or around',
    'the facade. Only the facade itself carries colour and material; all empty space around it stays pure white.',
    // Scene quality.
    'Soft even daylight on the facade, no people. Crisp and high-resolution.',
  ].join(' ');
}
