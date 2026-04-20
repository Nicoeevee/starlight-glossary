import { getCollection } from "astro:content";

// Source-level transform for raw markdown output (e.g. `.md` API endpoints,
// `llms.txt` generators). Does NOT require running the markdown through
// remark — operates on the raw source string and its lookup map. Complements
// the remark transform used during HTML rendering.

export interface GlossaryEntryMeta {
  term: string;
  wikipedia?: string;
}

export type GlossaryMap = Map<string, GlossaryEntryMeta>;

export interface ResolveOptions {
  /** Site origin used for the fallback link, e.g. `"https://docs.example.com"`. */
  siteOrigin?: string;
  /** Base URL for Wikipedia links. Default: `"https://en.wikipedia.org/wiki/"`. */
  wikipediaBase?: string;
  /** Protocol used in glossary links. Default: `"glossary"` (matches `[…](glossary:slug)`). */
  linkProtocol?: string;
  /** Called when the glossary entry has no `wikipedia` field. Defaults to `{siteOrigin}/glossary#{slug}`. */
  fallbackHref?: (slug: string) => string;
}

/**
 * Load the glossary collection into a lookup map keyed by slug (entry id).
 */
export async function loadGlossaryMap(
  collection: string = "glossary",
): Promise<GlossaryMap> {
  const entries = await getCollection(collection as "glossary");
  return new Map(
    entries.map((e) => [
      e.id,
      { term: e.data.term, wikipedia: e.data.wikipedia },
    ]),
  );
}

/**
 * Rewrite `[label](<protocol>:slug)` in a markdown string to a real href.
 * Prefers the Wikipedia URL derived from the entry's `wikipedia` field;
 * falls back to an on-site `/glossary#slug` anchor otherwise.
 */
export function resolveGlossaryLinks(
  body: string,
  glossary: GlossaryMap,
  options: ResolveOptions = {},
): string {
  const protocol = options.linkProtocol ?? "glossary";
  const wikipediaBase = options.wikipediaBase ?? "https://en.wikipedia.org/wiki/";
  const siteOrigin = options.siteOrigin ?? "";
  const fallback =
    options.fallbackHref ?? ((slug: string) => `${siteOrigin}/glossary#${slug}`);

  const re = new RegExp(`\\[([^\\]]+)\\]\\(${protocol}:([^)]+)\\)`, "g");
  return body.replace(re, (_m, label, slug) => {
    const entry = glossary.get(slug);
    const href = entry?.wikipedia
      ? `${wikipediaBase}${entry.wikipedia.replace(/ /g, "_")}`
      : fallback(slug);
    return `[${label}](${href})`;
  });
}
