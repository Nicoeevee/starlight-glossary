// Build-time JSON endpoint that serves a compact map for the client tooltip.
// Shape:
//   { [slug]: { term, aliases, html, wikipedia, wikipediaUrl, wikipediaTitle } }
// - `term`: author's preferred display name (from glossary.json)
// - `html`: cached Wikipedia extract, or `definition` override when set
// - `wikipedia`: raw slug, e.g. "Transport_Layer_Security#TLS_1.3"
// - `wikipediaUrl`: fully-built URL for the "Read on Wikipedia" link
// - `wikipediaTitle`: human-readable form for display, e.g. "Transport Layer Security › TLS 1.3"
import type { APIRoute } from "astro";
import { glossaryData } from "virtual:starlight-glossary/data";
import { buildWikipediaUrl, prettifyWikipediaTitle } from "../url";

export const prerender = true;

export const GET: APIRoute = async () => {
  const { terms, context } = glossaryData;
  const out: Record<
    string,
    {
      term: string;
      aliases?: string[];
      html: string;
      wikipedia?: string;
      wikipediaUrl?: string;
      wikipediaTitle?: string;
    }
  > = {};

  for (const entry of Object.values(terms)) {
    const html =
      entry.definition != null
        ? `<p>${entry.definition}</p>`
        : entry.cached?.extract_html ?? "";
    out[entry.slug] = {
      term: entry.term,
      aliases: entry.aliases.length > 1 ? entry.aliases : undefined,
      html,
      wikipedia: entry.wikipedia ?? undefined,
      wikipediaUrl: entry.wikipedia
        ? buildWikipediaUrl(context.wikipediaBase, entry.wikipedia)
        : undefined,
      wikipediaTitle: entry.wikipedia
        ? prettifyWikipediaTitle(entry.wikipedia)
        : undefined,
    };
  }

  return new Response(JSON.stringify(out), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
