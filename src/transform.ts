import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GlossaryEntry, GlossaryIndex } from "./data.js";
import { buildWikipediaUrl } from "./url.js";

// Source-level transforms for raw markdown output (e.g. `.md` API endpoints,
// llms.txt generators). Reads glossary.json directly — no dependency on the
// Astro content-collections API, so this can be called from any context.

export type GlossaryMap = Map<string, { term: string; wikipedia: string | null }>;

export interface ResolveOptions {
  /** Site origin used for the fallback link. */
  siteOrigin?: string;
  /** Base URL for Wikipedia links. */
  wikipediaBase?: string;
  /** Protocol used in glossary links. */
  linkProtocol?: string;
  /** Route prefix for the on-site glossary page. */
  routePrefix?: string;
  /** Called when the glossary entry has no `wikipedia` field. */
  fallbackHref?: (slug: string) => string;
}

/** Load the glossary index from `glossary.json` at the given root. */
export async function loadGlossaryMap(
  projectRoot: string = process.cwd(),
  filename: string = "glossary.json",
): Promise<GlossaryMap> {
  const raw = await readFile(join(projectRoot, filename), "utf8");
  const data = JSON.parse(raw) as GlossaryIndex;
  const map: GlossaryMap = new Map();
  for (const [slug, entry] of Object.entries(data.terms)) {
    map.set(slug, { term: entry.term, wikipedia: entry.wikipedia });
  }
  return map;
}

/** Rewrite `[label](<protocol>:slug)` and `[label](<routePrefix>#slug)` in
 *  a markdown string to real hrefs. Prefers Wikipedia; falls back to the
 *  on-site /glossary anchor. */
export function resolveGlossaryLinks(
  body: string,
  glossary: GlossaryMap,
  options: ResolveOptions = {},
): string {
  const protocol = options.linkProtocol ?? "glossary";
  const routePrefix = options.routePrefix ?? "/glossary";
  const wikipediaBase = options.wikipediaBase ?? "https://en.wikipedia.org/wiki/";
  const siteOrigin = options.siteOrigin ?? "";
  const fallback =
    options.fallbackHref ??
    ((slug: string) => `${siteOrigin}${routePrefix}#${slug}`);

  const legacyRe = new RegExp(`\\[([^\\]]+)\\]\\(${protocol}:([^)]+)\\)`, "g");
  const canonicalRe = new RegExp(
    `\\[([^\\]]+)\\]\\(${escapeRegex(routePrefix)}#([^)]+)\\)`,
    "g",
  );

  const rewrite = (_m: string, label: string, slug: string) => {
    const entry = glossary.get(slug);
    const href = entry?.wikipedia
      ? buildWikipediaUrl(wikipediaBase, entry.wikipedia)
      : fallback(slug);
    return `[${label}](${href})`;
  };

  return body.replace(legacyRe, rewrite).replace(canonicalRe, rewrite);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type { GlossaryEntry };
