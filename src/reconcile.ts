import type { GlossaryCache, GlossaryIndex } from "./data.js";

// Reconcile Wikipedia redirects with the glossary index.
//
// When an entry's cached Wikipedia title differs from its `wikipedia`
// slug, Wikipedia redirected. We only act when it's SAFE to do so — the
// old regression was auto-adopting big name changes (ChaCha20 → Salsa20,
// TLS 1.3 → Transport Layer Security) which destroyed user intent.
//
// Safety rules:
//   RENAME (adopt canonical Wikipedia form as this entry's term +
//   wikipedia fields):
//     - only when the current term and Wikipedia title are a case-only
//       difference, OR
//     - one is a prefix of the other after normalising out case,
//       punctuation, and whitespace (e.g. "public key" vs
//       "Public-key cryptography") — Wikipedia usually adds a
//       disambiguator, and the user clearly meant the same concept.
//
//   MERGE (fold this entry into an existing canonical entry that owns
//   the same Wikipedia article):
//     - only when neither entry has a fragment in its `wikipedia` slug
//       (fragment-pinned entries intentionally differentiate sub-sections
//       — e.g. TLS 1.3 under Transport Layer Security).
//     - never touches entries flagged with `groupWith` (user-declared
//       variant relationship).
//
// In all other cases we leave the entry alone; users can manually edit
// `glossary.json` if they want a different outcome.

export interface ReconcileReport {
  renamed: { slug: string; oldTerm: string; newTerm: string }[];
  merged: { from: string; fromTerm: string; into: string; intoTerm: string }[];
  skipped: { slug: string; term: string; cachedTitle: string; reason: string }[];
}

export function reconcileWikipediaRedirects(
  index: GlossaryIndex,
  cache: GlossaryCache,
): { report: ReconcileReport; mutated: boolean } {
  const report: ReconcileReport = { renamed: [], merged: [], skipped: [] };

  // Pre-pass: fold duplicates where two entries already point at the same
  // non-fragmented Wikipedia article. This catches cases where a previous
  // run of the plugin (or the user) set both entries' `wikipedia` to the
  // same canonical slug, so the redirect-based check below would find
  // nothing to do.
  mergeDuplicateArticles(index, cache, report);

  const canonicalOwner = (): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [slug, entry] of Object.entries(index.terms)) {
      if (entry.mergedInto) continue;
      if (!entry.wikipedia || entry.wikipedia.includes("#")) continue;
      const cached = cache.terms[slug];
      if (!cached?.title) continue;
      if (entry.wikipedia === wikipediaSlug(cached.title)) {
        if (!out.has(entry.wikipedia)) out.set(entry.wikipedia, slug);
      }
    }
    return out;
  };

  let mutated = false;
  const slugs = Object.keys(index.terms);
  for (const slug of slugs) {
    const entry = index.terms[slug];
    if (!entry || entry.mergedInto) continue;
    if (!entry.wikipedia) continue;
    const cached = cache.terms[slug];
    if (!cached?.title) continue;

    const canonicalSlug = wikipediaSlug(cached.title);
    if (canonicalSlug === entry.wikipedia) continue; // no redirect

    // Fragment-pinned entries (e.g. TLS 1.3 → "Transport_Layer_Security#TLS_1.3")
    // intentionally point at a sub-section. We never reconcile these —
    // the parent article's title is expected to differ from the fragment.
    if (entry.wikipedia.includes("#")) {
      continue;
    }
    // Variant entries explicitly grouped under a parent are user-structured.
    if (entry.groupWith) {
      continue;
    }

    const owners = canonicalOwner();
    const target = owners.get(canonicalSlug);

    // MERGE candidate (another entry is already canonical)
    if (target && target !== slug) {
      const dst = index.terms[target];
      if (!dst) continue;
      if (dst.wikipedia && dst.wikipedia.includes("#")) continue;
      if (dst.groupWith) continue;
      // Absorb aliases from the source
      const myAliases = [entry.term, ...entry.aliases];
      for (const a of myAliases) {
        if (!dst.aliases.includes(a) && a !== dst.term) dst.aliases.push(a);
      }
      index.terms[slug] = {
        term: entry.term,
        aliases: [],
        wikipedia: null,
        caseSensitive: false,
        definition: null,
        groupWith: null,
        mergedInto: target,
      };
      delete cache.terms[slug];
      report.merged.push({
        from: slug,
        fromTerm: entry.term,
        into: target,
        intoTerm: dst.term,
      });
      mutated = true;
      continue;
    }

    // RENAME candidate — only when safe
    if (canSafelyAdopt(entry.term, cached.title)) {
      const oldTerm = entry.term;
      entry.term = cached.title;
      entry.wikipedia = canonicalSlug;
      // Put term first in aliases, preserve old term as an alias if it
      // differs, dedupe.
      const seen = new Set<string>();
      const out: string[] = [];
      for (const a of [entry.term, oldTerm, ...entry.aliases]) {
        if (!a || seen.has(a)) continue;
        seen.add(a);
        out.push(a);
      }
      entry.aliases = out;
      report.renamed.push({ slug, oldTerm, newTerm: entry.term });
      mutated = true;
      continue;
    }

    // Not safe to touch automatically — just record.
    report.skipped.push({
      slug,
      term: entry.term,
      cachedTitle: cached.title,
      reason: "term differs substantially from Wikipedia title; edit glossary.json manually",
    });
  }

  return { report, mutated };
}

function wikipediaSlug(title: string): string {
  return title.replace(/ /g, "_");
}

function mergeDuplicateArticles(
  index: GlossaryIndex,
  cache: GlossaryCache,
  report: ReconcileReport,
): void {
  // Group non-merged, non-fragmented, non-groupWith entries by article
  const byArticle = new Map<string, string[]>();
  for (const [slug, entry] of Object.entries(index.terms)) {
    if (entry.mergedInto || entry.groupWith) continue;
    if (!entry.wikipedia || entry.wikipedia.includes("#")) continue;
    const list = byArticle.get(entry.wikipedia) ?? [];
    list.push(slug);
    byArticle.set(entry.wikipedia, list);
  }
  for (const [article, slugs] of byArticle) {
    if (slugs.length < 2) continue;
    // Pick a canonical winner. Preference:
    //   1. Slug that matches article-as-kebab-case (e.g. article
    //      "Authenticated_encryption" → winner slug "authenticated-encryption")
    //   2. Shortest slug otherwise.
    const expectedSlug = article.toLowerCase().replace(/_/g, "-");
    let winner =
      slugs.find((s) => s === expectedSlug) ??
      slugs.slice().sort((a, b) => a.length - b.length)[0];
    if (!winner) continue;
    const losers = slugs.filter((s) => s !== winner);
    const winnerEntry = index.terms[winner];
    if (!winnerEntry) continue;
    for (const loser of losers) {
      const loserEntry = index.terms[loser];
      if (!loserEntry) continue;
      const myAliases = [loserEntry.term, ...loserEntry.aliases];
      for (const a of myAliases) {
        if (
          a &&
          !winnerEntry.aliases.includes(a) &&
          a !== winnerEntry.term
        ) {
          winnerEntry.aliases.push(a);
        }
      }
      index.terms[loser] = {
        term: loserEntry.term,
        aliases: [],
        wikipedia: null,
        caseSensitive: false,
        definition: null,
        groupWith: null,
        mergedInto: winner,
      };
      delete cache.terms[loser];
      report.merged.push({
        from: loser,
        fromTerm: loserEntry.term,
        into: winner,
        intoTerm: winnerEntry.term,
      });
    }
  }
}

function canSafelyAdopt(currentTerm: string, canonicalTitle: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const a = norm(currentTerm);
  const b = norm(canonicalTitle);
  if (!a || !b) return false;
  if (a === b) return true; // pure case/punctuation difference
  if (b.startsWith(a)) return true; // canonical extends current (e.g. "public key" → "Public-key cryptography")
  if (a.startsWith(b)) return true; // current extends canonical (rare)
  return false;
}
