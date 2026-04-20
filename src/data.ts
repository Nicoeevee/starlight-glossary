// Data types for the glossary index and the Wikipedia cache.
// The plugin loads these from JSON files at project root and exposes them
// to routes + remark via a Vite virtual module.

export interface GlossaryEntry {
  /** Display name, e.g. "HPKE". */
  term: string;
  /** Strings that should auto-resolve to this entry (includes `term`). */
  aliases: string[];
  /** Wikipedia article slug (e.g. `"Hybrid_public-key_encryption"` or
   *  `"Transport_Layer_Security#TLS_1.3"` for an anchored sub-section).
   *  `null` means no Wikipedia link (tooltip falls back to `definition`). */
  wikipedia: string | null;
  /** If true, auto-tag only matches exact case (good for acronyms). */
  caseSensitive: boolean;
  /** Custom tooltip body; overrides the Wikipedia extract when set. */
  definition: string | null;
  /** When set, this entry appears under another entry on the /glossary page
   *  instead of having its own heading. */
  groupWith: string | null;
}

export interface GlossaryIndex {
  version: number;
  terms: Record<string, GlossaryEntry>;
}

export interface GlossaryCacheEntry {
  title: string;
  description: string;
  extract_html: string;
  url: string;
}

export interface GlossaryCache {
  version: number;
  fetchedAt: string;
  terms: Record<string, GlossaryCacheEntry>;
}

export interface RuntimeGlossaryEntry {
  slug: string;
  term: string;
  aliases: string[];
  wikipedia: string | null;
  caseSensitive: boolean;
  definition: string | null;
  groupWith: string | null;
  cached: GlossaryCacheEntry | null;
}

export interface ProjectContext {
  routePrefix: string;
  wikipediaBase: string;
}

export interface GlossaryData {
  terms: Record<string, RuntimeGlossaryEntry>;
  /** Map from any alias (lowercased for case-insensitive terms, as-is for
   *  case-sensitive terms) to the slug. */
  aliasIndex: Map<string, string>;
  context: ProjectContext;
}

export function joinGlossary(
  index: GlossaryIndex,
  cache: GlossaryCache,
  context: ProjectContext,
): GlossaryData {
  const terms: Record<string, RuntimeGlossaryEntry> = {};
  const aliasIndex = new Map<string, string>();

  for (const [slug, entry] of Object.entries(index.terms)) {
    const cached = cache.terms[slug] ?? null;
    terms[slug] = { slug, ...entry, cached };

    for (const alias of entry.aliases) {
      const key = entry.caseSensitive ? alias : alias.toLowerCase();
      if (!aliasIndex.has(key)) aliasIndex.set(key, slug);
    }
  }

  return { terms, aliasIndex, context };
}
