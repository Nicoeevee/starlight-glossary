import { describe, expect, it } from "vitest";

import type {
  GlossaryCache,
  GlossaryCacheEntry,
  GlossaryEntry,
  GlossaryIndex,
} from "./data.js";
import { reconcileWikipediaRedirects } from "./reconcile.js";

// Helpers ------------------------------------------------------------

function entry(overrides: Partial<GlossaryEntry> & { term: string }): GlossaryEntry {
  return {
    term: overrides.term,
    aliases: overrides.aliases ?? [overrides.term],
    wikipedia: overrides.wikipedia ?? null,
    caseSensitive: overrides.caseSensitive ?? false,
    definition: overrides.definition ?? null,
    groupWith: overrides.groupWith ?? null,
    ...(overrides.mergedInto !== undefined ? { mergedInto: overrides.mergedInto } : {}),
    ...(overrides.aliasFragments !== undefined
      ? { aliasFragments: overrides.aliasFragments }
      : {}),
  };
}

function cached(title: string): GlossaryCacheEntry {
  return { title, description: "", extract_html: "", url: "" };
}

function makeIndex(terms: Record<string, GlossaryEntry>): GlossaryIndex {
  return { version: 1, terms };
}

function makeCache(
  terms: Record<string, GlossaryCacheEntry>,
): GlossaryCache {
  return { version: 1, fetchedAt: "", terms };
}

// Tests --------------------------------------------------------------

describe("reconcileWikipediaRedirects", () => {
  it("returns empty report and mutated=false for an empty index", () => {
    const index = makeIndex({});
    const cache = makeCache({});
    const { report, mutated } = reconcileWikipediaRedirects(index, cache);
    expect(mutated).toBe(false);
    expect(report.renamed).toEqual([]);
    expect(report.merged).toEqual([]);
    expect(report.skipped).toEqual([]);
  });

  it("ignores entries without a wikipedia field", () => {
    const index = makeIndex({
      foo: entry({ term: "foo", wikipedia: null }),
    });
    const cache = makeCache({});
    const { report, mutated } = reconcileWikipediaRedirects(index, cache);
    expect(mutated).toBe(false);
    expect(report.renamed).toEqual([]);
    expect(report.merged).toEqual([]);
    expect(report.skipped).toEqual([]);
    // Entry unchanged.
    expect(index.terms.foo).toEqual(entry({ term: "foo", wikipedia: null }));
  });

  it("takes no action when cached title slugifies to the entry's wikipedia slug", () => {
    const index = makeIndex({
      tls: entry({
        term: "TLS",
        aliases: ["TLS"],
        wikipedia: "Transport_Layer_Security",
      }),
    });
    const cache = makeCache({ tls: cached("Transport Layer Security") });
    const before = JSON.parse(JSON.stringify(index));
    const { report, mutated } = reconcileWikipediaRedirects(index, cache);
    expect(mutated).toBe(false);
    expect(report.renamed).toEqual([]);
    expect(report.merged).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(index).toEqual(before);
  });

  it("renames on a case-only difference (safe)", () => {
    const index = makeIndex({
      tls: entry({
        term: "tls",
        aliases: ["tls"],
        wikipedia: "tls",
      }),
    });
    const cache = makeCache({ tls: cached("TLS") });
    const { report, mutated } = reconcileWikipediaRedirects(index, cache);
    expect(mutated).toBe(true);
    expect(report.renamed).toHaveLength(1);
    expect(report.renamed[0]).toEqual({
      slug: "tls",
      oldTerm: "tls",
      newTerm: "TLS",
    });
    expect(report.merged).toEqual([]);
    expect(report.skipped).toEqual([]);
    const updated = index.terms.tls;
    expect(updated.term).toBe("TLS");
    expect(updated.wikipedia).toBe("TLS");
    // new term first, old term preserved, deduped
    expect(updated.aliases).toEqual(["TLS", "tls"]);
  });

  it("renames when the canonical title extends the current term (prefix-safe)", () => {
    const index = makeIndex({
      "public-key": entry({
        term: "public key",
        aliases: ["public key", "pubkey"],
        wikipedia: "Public_key",
      }),
    });
    const cache = makeCache({
      "public-key": cached("Public-key cryptography"),
    });
    const { report, mutated } = reconcileWikipediaRedirects(index, cache);
    expect(mutated).toBe(true);
    expect(report.renamed).toHaveLength(1);
    expect(report.renamed[0]).toMatchObject({
      slug: "public-key",
      oldTerm: "public key",
      newTerm: "Public-key cryptography",
    });
    const updated = index.terms["public-key"];
    expect(updated.term).toBe("Public-key cryptography");
    expect(updated.wikipedia).toBe("Public-key_cryptography");
    expect(updated.aliases).toEqual([
      "Public-key cryptography",
      "public key",
      "pubkey",
    ]);
  });

  it("does NOT rename when the names differ substantially (ChaCha20 regression)", () => {
    const index = makeIndex({
      chacha20: entry({
        term: "ChaCha20",
        aliases: ["ChaCha20"],
        wikipedia: "ChaCha20",
      }),
    });
    const cache = makeCache({ chacha20: cached("Salsa20") });
    const snapshot = JSON.parse(JSON.stringify(index));
    const { report, mutated } = reconcileWikipediaRedirects(index, cache);
    // The dangerous auto-adoption path must NOT trigger.
    expect(report.renamed).toEqual([]);
    expect(mutated).toBe(false);
    // The skip is recorded.
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]).toMatchObject({
      slug: "chacha20",
      term: "ChaCha20",
      cachedTitle: "Salsa20",
    });
    expect(report.skipped[0]!.reason).toMatch(/differs/i);
    // Entry remains untouched.
    expect(index).toEqual(snapshot);
  });

  it("merges a redirecting entry into an existing canonical owner", () => {
    const index = makeIndex({
      aead: entry({
        term: "AEAD",
        aliases: ["AEAD"],
        wikipedia: "Authenticated_encryption",
      }),
      ae: entry({
        term: "AE",
        aliases: ["AE"],
        wikipedia: "AE",
      }),
    });
    const cache = makeCache({
      aead: cached("Authenticated encryption"),
      ae: cached("Authenticated encryption"),
    });
    const { report, mutated } = reconcileWikipediaRedirects(index, cache);
    expect(mutated).toBe(true);
    expect(report.merged).toHaveLength(1);
    expect(report.merged[0]).toMatchObject({
      from: "ae",
      into: "aead",
      fromTerm: "AE",
      intoTerm: "AEAD",
    });
    // ae becomes a stub forwarding to aead
    const aeStub = index.terms.ae;
    expect(aeStub.mergedInto).toBe("aead");
    expect(aeStub.wikipedia).toBeNull();
    expect(aeStub.aliases).toEqual([]);
    // aead absorbs ae's aliases (and its term)
    expect(index.terms.aead.aliases).toContain("AE");
    // aead's own term is not duplicated into its aliases through the merge
    const aeadAliases = index.terms.aead.aliases;
    const occurrencesOfAEAD = aeadAliases.filter((a) => a === "AEAD").length;
    expect(occurrencesOfAEAD).toBeLessThanOrEqual(1);
    // ae's cache is cleared
    expect(cache.terms.ae).toBeUndefined();
    // aead's cache is preserved
    expect(cache.terms.aead).toBeDefined();
  });

  it("leaves fragment-pinned entries untouched (silent)", () => {
    const index = makeIndex({
      "tls-1-3": entry({
        term: "TLS 1.3",
        aliases: ["TLS 1.3"],
        wikipedia: "Transport_Layer_Security#TLS_1.3",
      }),
    });
    const cache = makeCache({
      "tls-1-3": cached("Transport Layer Security"),
    });
    const snapshot = JSON.parse(JSON.stringify(index));
    const { report, mutated } = reconcileWikipediaRedirects(index, cache);
    expect(mutated).toBe(false);
    expect(report.renamed).toEqual([]);
    expect(report.merged).toEqual([]);
    // Fragment-pinned entries are skipped silently — not even in skipped.
    expect(report.skipped).toEqual([]);
    expect(index).toEqual(snapshot);
  });

  it("leaves groupWith entries untouched (silent)", () => {
    const index = makeIndex({
      "variant-x": entry({
        term: "Variant X",
        aliases: ["Variant X"],
        wikipedia: "Some_article",
        groupWith: "parent",
      }),
      parent: entry({
        term: "Parent",
        aliases: ["Parent"],
        wikipedia: null,
      }),
    });
    const cache = makeCache({
      "variant-x": cached("Different Article Title"),
    });
    const snapshot = JSON.parse(JSON.stringify(index));
    const { report, mutated } = reconcileWikipediaRedirects(index, cache);
    expect(mutated).toBe(false);
    expect(report.renamed).toEqual([]);
    expect(report.merged).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(index).toEqual(snapshot);
  });

  it("mergeDuplicateArticles: kebab-case-matching slug wins", () => {
    const index = makeIndex({
      "authenticated-encryption": entry({
        term: "Authenticated encryption",
        aliases: ["Authenticated encryption"],
        wikipedia: "Authenticated_encryption",
      }),
      "aead-encryption": entry({
        term: "AEAD encryption",
        aliases: ["AEAD encryption", "AEAD"],
        wikipedia: "Authenticated_encryption",
      }),
    });
    const cache = makeCache({
      "authenticated-encryption": cached("Authenticated encryption"),
      "aead-encryption": cached("Authenticated encryption"),
    });
    const { report, mutated } = reconcileWikipediaRedirects(index, cache);
    expect(mutated).toBe(true);
    // winner slug matches kebab-cased article
    expect(index.terms["authenticated-encryption"].mergedInto).toBeFalsy();
    expect(index.terms["aead-encryption"].mergedInto).toBe(
      "authenticated-encryption",
    );
    // winner absorbed loser's aliases + term
    const winnerAliases = index.terms["authenticated-encryption"].aliases;
    expect(winnerAliases).toContain("AEAD encryption");
    expect(winnerAliases).toContain("AEAD");
    // loser stub
    const loser = index.terms["aead-encryption"];
    expect(loser.aliases).toEqual([]);
    expect(loser.wikipedia).toBeNull();
    // report records it
    expect(report.merged).toContainEqual(
      expect.objectContaining({
        from: "aead-encryption",
        into: "authenticated-encryption",
      }),
    );
  });

  it("mergeDuplicateArticles: shortest-slug tiebreak when no kebab match", () => {
    const index = makeIndex({
      "longer-slug-variant": entry({
        term: "Longer slug",
        aliases: ["Longer slug"],
        wikipedia: "Something_completely_different",
      }),
      short: entry({
        term: "Short",
        aliases: ["Short"],
        wikipedia: "Something_completely_different",
      }),
    });
    const cache = makeCache({
      "longer-slug-variant": cached("Something completely different"),
      short: cached("Something completely different"),
    });
    const { report, mutated } = reconcileWikipediaRedirects(index, cache);
    expect(mutated).toBe(true);
    // No slug matches the kebab of the article, so shortest wins → "short"
    expect(index.terms.short.mergedInto).toBeFalsy();
    expect(index.terms["longer-slug-variant"].mergedInto).toBe("short");
    expect(report.merged).toContainEqual(
      expect.objectContaining({
        from: "longer-slug-variant",
        into: "short",
      }),
    );
  });

  it("mergeDuplicateArticles skips fragmented entries from the grouping", () => {
    const index = makeIndex({
      "tls-1-3": entry({
        term: "TLS 1.3",
        aliases: ["TLS 1.3"],
        wikipedia: "Transport_Layer_Security#TLS_1.3",
      }),
      tls: entry({
        term: "TLS",
        aliases: ["TLS"],
        wikipedia: "Transport_Layer_Security",
      }),
    });
    const cache = makeCache({
      "tls-1-3": cached("Transport Layer Security"),
      tls: cached("Transport Layer Security"),
    });
    const snapshot = JSON.parse(JSON.stringify(index));
    const { report, mutated } = reconcileWikipediaRedirects(index, cache);
    // Fragmented entry is excluded from duplicate grouping → no merges
    expect(mutated).toBe(false);
    expect(report.merged).toEqual([]);
    expect(index).toEqual(snapshot);
  });

  it("mergeDuplicateArticles skips groupWith entries from the grouping", () => {
    const index = makeIndex({
      variant: entry({
        term: "Variant",
        aliases: ["Variant"],
        wikipedia: "Shared_article",
        groupWith: "main",
      }),
      main: entry({
        term: "Main",
        aliases: ["Main"],
        wikipedia: "Shared_article",
      }),
    });
    const cache = makeCache({
      variant: cached("Shared article"),
      main: cached("Shared article"),
    });
    const snapshot = JSON.parse(JSON.stringify(index));
    const { report, mutated } = reconcileWikipediaRedirects(index, cache);
    // groupWith entry not grouped → only one non-grouped entry left → no merges
    expect(mutated).toBe(false);
    expect(report.merged).toEqual([]);
    expect(index).toEqual(snapshot);
  });

  describe("canSafelyAdopt edge cases (via reconcile)", () => {
    it("treats space vs hyphen as safe (punctuation stripped in normaliser)", () => {
      const index = makeIndex({
        "a-b-c": entry({
          term: "a b c",
          aliases: ["a b c"],
          wikipedia: "a_b_c",
        }),
      });
      const cache = makeCache({ "a-b-c": cached("a-b-c") });
      const { report, mutated } = reconcileWikipediaRedirects(index, cache);
      // "a b c" vs "a-b-c" normalise to "abc" === "abc" → safe rename.
      expect(mutated).toBe(true);
      expect(report.renamed).toHaveLength(1);
      expect(report.skipped).toEqual([]);
      expect(index.terms["a-b-c"].term).toBe("a-b-c");
    });

    it("does NOT adopt TLS → Transport Layer Security (neither prefixes the other)", () => {
      const index = makeIndex({
        tls: entry({
          term: "TLS",
          aliases: ["TLS"],
          wikipedia: "TLS",
        }),
      });
      const cache = makeCache({ tls: cached("Transport Layer Security") });
      const { report, mutated } = reconcileWikipediaRedirects(index, cache);
      expect(mutated).toBe(false);
      expect(report.renamed).toEqual([]);
      expect(report.skipped).toHaveLength(1);
      expect(report.skipped[0]).toMatchObject({
        slug: "tls",
        term: "TLS",
        cachedTitle: "Transport Layer Security",
      });
    });

    it("does NOT adopt when the current term is empty-after-normalisation", () => {
      // A term like "!!!" normalises to "" → should never adopt.
      const index = makeIndex({
        bang: entry({
          term: "!!!",
          aliases: ["!!!"],
          wikipedia: "bang",
        }),
      });
      const cache = makeCache({ bang: cached("Bang Something") });
      const { report, mutated } = reconcileWikipediaRedirects(index, cache);
      expect(mutated).toBe(false);
      expect(report.renamed).toEqual([]);
      expect(report.skipped).toHaveLength(1);
    });
  });

  it("mutated=true when any rename or merge happens", () => {
    const index = makeIndex({
      tls: entry({
        term: "tls",
        aliases: ["tls"],
        wikipedia: "tls",
      }),
    });
    const cache = makeCache({ tls: cached("TLS") });
    const { mutated } = reconcileWikipediaRedirects(index, cache);
    expect(mutated).toBe(true);
  });

  it("mutated=false when nothing changes", () => {
    const index = makeIndex({
      foo: entry({
        term: "Foo",
        aliases: ["Foo"],
        wikipedia: "Foo",
      }),
    });
    const cache = makeCache({ foo: cached("Foo") });
    const { mutated } = reconcileWikipediaRedirects(index, cache);
    expect(mutated).toBe(false);
  });

  it("preserves and dedupes all aliases after merge (winner never duplicates own term)", () => {
    const index = makeIndex({
      target: entry({
        term: "Target",
        aliases: ["Target", "Shared"],
        wikipedia: "Canonical_article",
      }),
      source: entry({
        term: "Source",
        aliases: ["Source", "Shared", "Extra"],
        wikipedia: "old_slug",
      }),
    });
    const cache = makeCache({
      target: cached("Canonical article"),
      source: cached("Canonical article"),
    });
    const { mutated } = reconcileWikipediaRedirects(index, cache);
    expect(mutated).toBe(true);
    // source became a stub
    expect(index.terms.source.mergedInto).toBe("target");
    // target aliases: original + source's term + source's aliases, deduped, never the winner's own term twice
    const aliases = index.terms.target.aliases;
    // All source contributions present
    expect(aliases).toContain("Source");
    expect(aliases).toContain("Extra");
    expect(aliases).toContain("Shared");
    expect(aliases).toContain("Target");
    // No dupes
    const unique = new Set(aliases);
    expect(unique.size).toBe(aliases.length);
    // "Target" (dst.term) only appears once, even though source's alias list
    // contributed nothing matching it.
    expect(aliases.filter((a) => a === "Target").length).toBe(1);
  });

  it("wikipediaRedirectAcknowledged silences the SKIP warning when matching", () => {
    // ChaCha20 entry intentionally points at the Salsa20 article (same
    // family, distinct cipher). Without acknowledgement, this is a SKIP.
    const baseEntry = entry({
      term: "ChaCha20",
      wikipedia: "ChaCha20",
    });
    const baseCache = makeCache({ chacha20: cached("Salsa20") });

    // Without ack: shows up in skipped.
    const idx1 = makeIndex({ chacha20: { ...baseEntry } });
    const r1 = reconcileWikipediaRedirects(idx1, baseCache);
    expect(r1.report.skipped).toHaveLength(1);
    expect(r1.report.skipped[0].slug).toBe("chacha20");

    // With ack matching the cached title: silent.
    const idx2 = makeIndex({
      chacha20: { ...baseEntry, wikipediaRedirectAcknowledged: "Salsa20" },
    });
    const r2 = reconcileWikipediaRedirects(idx2, baseCache);
    expect(r2.report.skipped).toEqual([]);
    expect(r2.mutated).toBe(false);

    // With ack pointing at the wrong title: warning resumes (Wikipedia
    // changed the canonical title under the user's feet).
    const idx3 = makeIndex({
      chacha20: {
        ...baseEntry,
        wikipediaRedirectAcknowledged: "OldDifferentTitle",
      },
    });
    const r3 = reconcileWikipediaRedirects(idx3, baseCache);
    expect(r3.report.skipped).toHaveLength(1);
  });
});
