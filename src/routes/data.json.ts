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
      description?: string;
      aliases?: string[];
      html: string;
      wikipedia?: string;
      wikipediaUrl?: string;
      wikipediaTitle?: string;
      mergedInto?: string;
      /** Per-alias fragment overrides — tooltip client consults this when
       *  a link has no data-glossary-fragment attribute (e.g. when the
       *  reference was auto-tagged from plain text without explicit
       *  fragment syntax). */
      aliasFragments?: Record<string, string>;
    }
  > = {};

  for (const entry of Object.values(terms)) {
    // Merged entries: emit a tiny redirect record so the tooltip client
    // can follow the pointer client-side.
    if (entry.mergedInto) {
      out[entry.slug] = {
        term: entry.term,
        html: "",
        mergedInto: entry.mergedInto,
      } as (typeof out)[string];
      continue;
    }
    const html =
      entry.definition != null
        ? `<p>${entry.definition}</p>`
        : entry.cached?.extract_html ?? "";
    // Prefer Wikipedia's canonical title when it differs only in casing —
    // matches what /glossary renders so tooltip and index agree.
    const displayTerm =
      entry.cached?.title &&
      entry.cached.title.toLowerCase() === entry.term.toLowerCase()
        ? entry.cached.title
        : entry.term;
    out[entry.slug] = {
      term: displayTerm,
      description: entry.cached?.description || undefined,
      aliases: entry.aliases.length > 1 ? entry.aliases : undefined,
      html,
      wikipedia: entry.wikipedia ?? undefined,
      wikipediaUrl: entry.wikipedia
        ? buildWikipediaUrl(context.wikipediaBase, entry.wikipedia)
        : undefined,
      wikipediaTitle: entry.wikipedia
        ? prettifyWikipediaTitle(entry.wikipedia)
        : undefined,
      aliasFragments:
        entry.aliasFragments && Object.keys(entry.aliasFragments).length > 0
          ? entry.aliasFragments
          : undefined,
    };
  }

  return new Response(JSON.stringify(out), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Revalidate on every request. A cached `data.json` that went out
      // empty (e.g. during a build before the Wikipedia cache had been
      // populated) could otherwise linger in the browser cache for the
      // whole max-age window.
      "Cache-Control": "public, max-age=0, must-revalidate",
    },
  });
};
