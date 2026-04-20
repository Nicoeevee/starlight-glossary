// Build-time JSON endpoint that ships a compact map of
//   { [slug]: { term, aliases, html, wikipedia } }
// for the client tooltip to fetch once and cache. Rendered HTML comes
// from Astro's experimental container so we reuse the exact same
// markdown-to-HTML pipeline Starlight uses on the /glossary page.
import type { APIRoute } from "astro";
import { getCollection, render } from "astro:content";
import { experimental_AstroContainer as AstroContainer } from "astro/container";

export const prerender = true;

export const GET: APIRoute = async () => {
  const entries = await getCollection("glossary");
  const container = await AstroContainer.create();

  const out: Record<
    string,
    {
      term: string;
      aliases?: string[];
      html: string;
      wikipedia?: string;
    }
  > = {};

  for (const entry of entries) {
    const { Content } = await render(entry);
    const html = await container.renderToString(Content);
    out[entry.id] = {
      term: entry.data.term,
      aliases: entry.data.aliases,
      html: html.trim(),
      wikipedia: entry.data.wikipedia,
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
