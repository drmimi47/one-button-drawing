/**
 * ============================================================================
 *  FACADE AI RENDERER — Gemini 2.5 Flash Image ("Nano Banana")
 * ============================================================================
 *
 * Renders the selected facade panels into a photorealistic image. The rasterised layout of the
 * selection goes in as a reference image and the metadata-built prompt as text; the model returns
 * a rendered image. Mirrors the client-side `fetch` + `VITE_*` key pattern used for the Anthropic
 * calls in backend/parsePrompt.ts. Optional: with no key, {@link geminiEnabled} is false and the
 * Render flow surfaces a "not configured" message (the rest of the app is unaffected).
 */

const MODEL = 'gemini-2.5-flash-image';
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

/** True only when a Gemini API key is configured. */
export const geminiEnabled: boolean = Boolean(import.meta.env.VITE_GEMINI_API_KEY);

/** Thrown with a human-readable message for the render panel. */
export class RenderError extends Error {}

export interface RenderArgs {
  /** PNG data URL of the selected shapes — the layout reference. */
  pngDataUrl: string;
  /** Prompt describing the assembly/material, built from shape metadata (not user-typed). */
  prompt: string;
}

/** Strip the `data:image/png;base64,` prefix → raw base64. */
function base64Of(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

/**
 * Render the selected facade panels and return a data URL of the generated image. Throws a
 * {@link RenderError} (friendly message) when unconfigured, on a network failure, on a non-2xx
 * response, or when the model returns no image.
 */
export async function renderFacade({ pngDataUrl, prompt }: RenderArgs): Promise<string> {
  const key = import.meta.env.VITE_GEMINI_API_KEY;
  if (!key) {
    throw new RenderError(
      'AI renderer not configured. Add VITE_GEMINI_API_KEY to .env.local (a Google AI Studio key) and restart the dev server.',
    );
  }

  let res: Response;
  try {
    res = await fetch(`${API_URL}?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              { inlineData: { mimeType: 'image/png', data: base64Of(pngDataUrl) } },
            ],
          },
        ],
        // Ask for an image back. If a model build rejects this param, it can be removed.
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      }),
    });
  } catch {
    throw new RenderError('Network error reaching the renderer — check your connection.');
  }

  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      if (j?.error?.message) detail = ` — ${j.error.message}`;
    } catch {
      /* ignore body parse errors */
    }
    throw new RenderError(`Renderer error (${res.status})${detail}`);
  }

  const data = await res.json();
  const parts: unknown[] = data?.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    // The REST JSON may use camelCase (inlineData) or snake_case (inline_data).
    const inline = (part as { inlineData?: InlineData; inline_data?: InlineData }).inlineData
      ?? (part as { inline_data?: InlineData }).inline_data;
    if (inline?.data) {
      const mime = inline.mimeType ?? inline.mime_type ?? 'image/png';
      return `data:${mime};base64,${inline.data}`;
    }
  }
  throw new RenderError('The renderer returned no image. Try again or adjust the selection.');
}

interface InlineData {
  data?: string;
  mimeType?: string;
  mime_type?: string;
}
