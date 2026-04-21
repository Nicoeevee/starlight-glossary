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
  /** When set, this entry has been merged into another entry (Wikipedia
   *  redirect resolved to a different slug). Doc links to this slug still
   *  resolve — they're forwarded to the target entry at render time. The
   *  target owns all aliases, cached content, etc. */
  mergedInto?: string | null;
  /** Map of alias → Wikipedia fragment. Populated when docs reference the
   *  entry with `glossary:Article#Section` syntax: the label becomes an
   *  alias, the fragment is stored here. Subsequent references to that
   *  alias (explicit or auto-tagged) get the fragment carried through to
   *  the Wikipedia link. Not usually hand-edited. */
  aliasFragments?: Record<string, string>;
  /** When set, suppresses the reconcile "Wikipedia title changed" warning
   *  for this entry as long as the cached Wikipedia title still equals
   *  this string. Useful for entries where the user has *intentionally*
   *  picked a different name than Wikipedia's canonical form (e.g.
   *  ChaCha20 pointing at the Salsa20 article — same authors, distinct
   *  cipher, different community usage). If Wikipedia later changes the
   *  canonical title to something else, the warning resumes so the user
   *  knows to re-review. */
  wikipediaRedirectAcknowledged?: string | null;
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
  mergedInto?: string | null;
  aliasFragments?: Record<string, string>;
  wikipediaRedirectAcknowledged?: string | null;
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

    // Merged entries forward to their target — don't index aliases here;
    // the target owns the alias list.
    if (entry.mergedInto) continue;

    for (const alias of entry.aliases) {
      const key = entry.caseSensitive ? alias : alias.toLowerCase();
      if (!aliasIndex.has(key)) aliasIndex.set(key, slug);
    }
  }

  return { terms, aliasIndex, context };
}

/** Follow `mergedInto` forwards until reaching a canonical entry. Returns
 *  the canonical slug (or the input if nothing's merged). Guards against
 *  cycles / broken chains. */
export function resolveSlug(
  slug: string,
  terms: Record<string, { mergedInto?: string | null }>,
): string {
  let current = slug;
  const seen = new Set<string>([current]);
  while (true) {
    const entry = terms[current];
    if (!entry || !entry.mergedInto) return current;
    if (seen.has(entry.mergedInto)) return current;
    seen.add(entry.mergedInto);
    current = entry.mergedInto;
  }
}
