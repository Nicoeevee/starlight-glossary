import { describe, expect, it } from "vitest";
import {
  GlossaryValidationError,
  validateGlossaryCache,
  validateGlossaryIndex,
} from "./validate.js";

describe("validateGlossaryIndex", () => {
  it("accepts a minimal valid index", () => {
    const result = validateGlossaryIndex({ version: 1, terms: {} });
    expect(result.terms).toEqual({});
  });

  it("accepts a full entry with every optional field", () => {
    const raw = {
      version: 1,
      terms: {
        tls: {
          term: "TLS",
          aliases: ["TLS", "SSL"],
          wikipedia: "Transport_Layer_Security",
          caseSensitive: true,
          definition: null,
          groupWith: null,
          mergedInto: null,
          aliasFragments: { "TLS 1.3": "TLS_1.3" },
          wikipediaRedirectAcknowledged: "Some Title",
        },
      },
    };
    const result = validateGlossaryIndex(raw);
    expect(result.terms.tls.aliases).toEqual(["TLS", "SSL"]);
  });

  it("throws GlossaryValidationError when root is not an object", () => {
    expect(() => validateGlossaryIndex(null)).toThrow(
      GlossaryValidationError,
    );
    expect(() => validateGlossaryIndex("hello")).toThrow(
      GlossaryValidationError,
    );
    expect(() => validateGlossaryIndex([])).toThrow(GlossaryValidationError);
  });

  it("reports missing terms field with a path-annotated error", () => {
    try {
      validateGlossaryIndex({ version: 1 });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GlossaryValidationError);
      const e = err as GlossaryValidationError;
      expect(e.problems.some((p) => p.startsWith("terms:"))).toBe(true);
    }
  });

  it("reports per-entry problems with the slug in the path", () => {
    try {
      validateGlossaryIndex({
        version: 1,
        terms: {
          broken: {
            term: 123,
            aliases: "not an array",
            wikipedia: 42,
            caseSensitive: "yes",
            definition: 0,
            groupWith: false,
          },
        },
      });
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as GlossaryValidationError;
      const joined = e.problems.join("\n");
      expect(joined).toContain('terms["broken"].term');
      expect(joined).toContain('terms["broken"].aliases');
      expect(joined).toContain('terms["broken"].wikipedia');
      expect(joined).toContain('terms["broken"].caseSensitive');
      expect(joined).toContain('terms["broken"].definition');
      expect(joined).toContain('terms["broken"].groupWith');
    }
  });

  it("reports unknown groupWith and mergedInto targets", () => {
    try {
      validateGlossaryIndex({
        version: 1,
        terms: {
          a: {
            term: "A",
            aliases: ["A"],
            wikipedia: null,
            caseSensitive: false,
            definition: null,
            groupWith: "ghost",
            mergedInto: "phantom",
          },
        },
      });
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as GlossaryValidationError;
      const joined = e.problems.join("\n");
      expect(joined).toContain('groupWith: points at unknown slug "ghost"');
      expect(joined).toContain('mergedInto: points at unknown slug "phantom"');
    }
  });

  it("rejects non-string aliasFragments values", () => {
    try {
      validateGlossaryIndex({
        version: 1,
        terms: {
          a: {
            term: "A",
            aliases: ["A"],
            wikipedia: null,
            caseSensitive: false,
            definition: null,
            groupWith: null,
            aliasFragments: { good: "frag", bad: 42 },
          },
        },
      });
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as GlossaryValidationError;
      expect(
        e.problems.some((p) => p.includes('aliasFragments["bad"]')),
      ).toBe(true);
    }
  });

  it("error message lists every problem", () => {
    try {
      validateGlossaryIndex({
        version: "wrong",
        terms: {
          a: { term: "", aliases: [], wikipedia: null, caseSensitive: false, definition: null, groupWith: null },
        },
      });
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as GlossaryValidationError;
      // Both version and term emptyness must appear.
      const joined = e.message;
      expect(joined).toContain("version");
      expect(joined).toContain("term");
    }
  });
});

describe("validateGlossaryCache", () => {
  it("accepts a minimal valid cache", () => {
    const result = validateGlossaryCache({ version: 1, fetchedAt: "", terms: {} });
    expect(result.terms).toEqual({});
  });

  it("accepts a populated cache", () => {
    const result = validateGlossaryCache({
      version: 1,
      fetchedAt: "2025-01-01T00:00:00Z",
      terms: {
        tls: { title: "TLS", description: "secure protocol", extract_html: "<p>x</p>", url: "https://example.com" },
      },
    });
    expect(result.terms.tls.title).toBe("TLS");
  });

  it("rejects non-string entry fields", () => {
    try {
      validateGlossaryCache({
        version: 1,
        fetchedAt: "",
        terms: {
          bad: { title: 1, description: 2, extract_html: 3, url: 4 },
        },
      });
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as GlossaryValidationError;
      const joined = e.problems.join("\n");
      expect(joined).toContain('terms["bad"].title');
      expect(joined).toContain('terms["bad"].description');
      expect(joined).toContain('terms["bad"].extract_html');
      expect(joined).toContain('terms["bad"].url');
    }
  });
});
