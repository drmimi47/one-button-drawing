import type { Square } from '../types';
import { renderShapesToDataURL } from '../canvas/thumbnail';
import { renderFacade, RenderError } from './renderer';
import { buildRenderPrompt } from './assemblies';
import type { AssemblyMetadata } from './metadata';

/**
 * ============================================================================
 *  FACADE RENDER (single pass)
 * ============================================================================
 *
 * Builds ONE reference image of the whole selection (filled tonal regions: grey panels, darker
 * mullion/joint bands, white background) and ONE category-aware prompt covering every material in the
 * selection, then makes a single Gemini call. The prompt + tonal reference carry the accuracy: each
 * grey region is rendered in its stated material (glass / brick / mesh / concrete…), with the panel
 * count + geometry locked so the model doesn't invent mullions or extra panels.
 */

interface RenderArgs {
  /** The selected panels to render (already cloned by the canvas). */
  shapes: Square[];
  /** App's metadata store, keyed by assembly type — drives the per-material prompt clauses. */
  metaByAssembly: Record<string, AssemblyMetadata>;
}

/** Render the selection in a single call. Returns the image + the prompt (Dev view). Throws RenderError. */
export async function renderFacadeSelection({
  shapes,
  metaByAssembly,
}: RenderArgs): Promise<{ image: string; prompt: string }> {
  if (shapes.length === 0) throw new RenderError('Select geometry to render.');
  const png = renderShapesToDataURL(shapes);
  if (!png) throw new RenderError('Could not build the reference image for the selection.');
  const prompt = buildRenderPrompt(shapes, metaByAssembly);
  const image = await renderFacade({ pngDataUrl: png, prompt });
  return { image, prompt };
}
