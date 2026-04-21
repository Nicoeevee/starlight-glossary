import { describe, expect, it, vi } from "vitest";

import type { GlossaryCache, GlossaryIndex } from "./data.js";
import {
  discoverMissingTerms,
  fillCacheHoles,
  type UnresolvedReference,
} from "./discovery.js";

function silentLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function emptyIndex(): GlossaryIndex {
  return { version: 1, terms: {} };
}

function emptyCache(): GlossaryCache {
  return { version: 1, fetchedAt: "", terms: {} };
}

describe("discoverMissingTerms — wikipedia.enabled=false", () => {
  it("returns an empty report without hitting the network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("fetch should not have been called");
    });
    const logger = silentLogger();
    const unresolved: UnresolvedReference[] = [
      { slug: "foo", label: "Foo", locations: ["docs/foo.md"] },
    ];
    try {
      const report = await discoverMissingTerms(
        unresolved,
        emptyIndex(),
        emptyCache(),
        logger,
        { enabled: false },
      );
      expect(report.added).toEqual([]);
      expect(report.errored).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
      // Logger warns so the user sees their unknown ref didn't get resolved.
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("unresolved"),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("no warning when there's nothing unresolved anyway", async () => {
    const logger = silentLogger();
    const report = await discoverMissingTerms(
      [],
      emptyIndex(),
      emptyCache(),
      logger,
      { enabled: false },
    );
    expect(report.added).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("discoverMissingTerms — wikipedia.strict", () => {
  it("throws when any fetch errored and strict is true", async () => {
    // Mock a failed fetch.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    } as Response);
    const logger = silentLogger();
    try {
      await expect(
        discoverMissingTerms(
          [{ slug: "foo", label: "Foo", locations: [] }],
          emptyIndex(),
          emptyCache(),
          logger,
          { enabled: true, strict: true, timeoutMs: 5000 },
        ),
      ).rejects.toThrow(/wikipedia\.strict/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("does NOT throw when a fetch errored but strict is false", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    } as Response);
    const logger = silentLogger();
    try {
      const report = await discoverMissingTerms(
        [{ slug: "foo", label: "Foo", locations: [] }],
        emptyIndex(),
        emptyCache(),
        logger,
        { enabled: true, strict: false, timeoutMs: 5000 },
      );
      expect(report.errored).toContain("foo");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("fillCacheHoles — wikipedia.enabled=false", () => {
  it("does not hit network and returns 0", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("fetch should not have been called");
    });
    const logger = silentLogger();
    const index: GlossaryIndex = {
      version: 1,
      terms: {
        tls: {
          term: "TLS",
          aliases: ["TLS"],
          wikipedia: "Transport_Layer_Security",
          caseSensitive: false,
          definition: null,
          groupWith: null,
        },
      },
    };
    try {
      const filled = await fillCacheHoles(index, emptyCache(), logger, {
        enabled: false,
      });
      expect(filled).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("wikipedia.enabled=false"),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("no warning when there are no holes to fill", async () => {
    const logger = silentLogger();
    const index: GlossaryIndex = {
      version: 1,
      terms: {
        tls: {
          term: "TLS",
          aliases: ["TLS"],
          wikipedia: "Transport_Layer_Security",
          caseSensitive: false,
          definition: null,
          groupWith: null,
        },
      },
    };
    const cache: GlossaryCache = {
      version: 1,
      fetchedAt: "",
      terms: {
        tls: {
          title: "Transport Layer Security",
          description: "",
          extract_html: "",
          url: "",
        },
      },
    };
    const filled = await fillCacheHoles(index, cache, logger, {
      enabled: false,
    });
    expect(filled).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
