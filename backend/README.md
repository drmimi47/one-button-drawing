# backend/

The constraints "service" layer: it turns the plain-English text from the
**Constraints** box into structured rules and decides which rooms break them.

| File | Role |
| --- | --- |
| `types.ts` | The `Constraints` schema — the single source of truth. |
| `parseConstraints.ts` | English → `Constraints`, via the Anthropic LLM with a regex fallback. |
| `violations.ts` | Given a room + the active constraints, which rules it breaks. |

## Running today vs. tomorrow

This currently runs **client-side** — Vite bundles these modules into the page and
`parseConstraints` calls the Anthropic API directly from the browser. This folder
is the seam where a real **serverless proxy** would later live, so the API key
never ships to the client.

## API key

`parseConstraints` reads `import.meta.env.VITE_ANTHROPIC_API_KEY`. Put it in a
gitignored `.env.local` (see `.env.example`). ⚠️ A `VITE_`-prefixed key is
embedded in the client bundle — fine for local/demo use, not for production.

Without a key, `parseConstraints` automatically uses the deterministic regex
fallback, so the seeded `Minimum wall thickness 3"` rule still works offline.
