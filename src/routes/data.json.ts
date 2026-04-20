// Build-time JSON endpoint that serves a compact map for the client tooltip.
// Shape:
//   { [slug]: { term, aliases, html, wikipedia } }
// `html` is the cached Wikipedia extract (or `definition` when overridden).
import type { APIRoute } from "astro";
import { glossaryData } from "virtual:starlight-glossary/data";

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
        ? `${context.wikipediaBase}${entry.wikipedia.replace(/ /g, "_")}`
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
