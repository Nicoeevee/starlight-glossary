// Hand-rolled validators for glossary.json and glossary-cache.json.
// The goal is a clear, path-aware error for a user who hand-edited their
// JSON — not exhaustive coverage of every possible malformed tree. Fail
// loud at config:setup so typos show up as a proper error, not a cryptic
// runtime crash several seconds later.
//
// We deliberately don't ship zod as a runtime dep. These schemas are tiny
// and stable; a ~150-line hand-rolled pass is clearer than a zod expression
// for readers who only want to know "what does glossary.json accept."

import type { GlossaryCache, GlossaryIndex } from "./data.js";

export class GlossaryValidationError extends Error {
  readonly problems: string[];
  constructor(source: string, problems: string[]) {
    const listed = problems.map((p) => `  · ${p}`).join("\n");
    super(
      `${source} failed validation (${problems.length} problem${
        problems.length === 1 ? "" : "s"
      }):\n${listed}`,
    );
    this.name = "GlossaryValidationError";
    this.problems = problems;
  }
}

/** Validate and return a typed GlossaryIndex. Throws GlossaryValidationError
 *  with a list of path-annotated problems when the input is malformed. */
export function validateGlossaryIndex(
  raw: unknown,
  source: string = "glossary.json",
): GlossaryIndex {
  const problems: string[] = [];

  if (!isObject(raw)) {
    throw new GlossaryValidationError(source, [
      "root must be a JSON object",
    ]);
  }
  const root = raw as Record<string, unknown>;

  if (root.version !== undefined && typeof root.version !== "number") {
    problems.push(`version: expected number, got ${describeType(root.version)}`);
  }
  if (!isObject(root.terms)) {
    problems.push(
      `terms: expected object, got ${describeType(root.terms)}`,
    );
    // Without `terms` we can't continue into per-entry checks.
    throw new GlossaryValidationError(source, problems);
  }

  const terms = root.terms as Record<string, unknown>;
  for (const [slug, entry] of Object.entries(terms)) {
    const at = `terms["${slug}"]`;
    if (!isObject(entry)) {
      problems.push(`${at}: expected object, got ${describeType(entry)}`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.term !== "string" || e.term.length === 0) {
      problems.push(`${at}.term: expected non-empty string`);
    }
    if (!isArrayOf(e.aliases, "string")) {
      problems.push(`${at}.aliases: expected string[]`);
    }
    if (e.wikipedia !== null && typeof e.wikipedia !== "string") {
      problems.push(`${at}.wikipedia: expected string or null`);
    }
    if (typeof e.caseSensitive !== "boolean") {
      problems.push(`${at}.caseSensitive: expected boolean`);
    }
    if (e.definition !== null && typeof e.definition !== "string") {
      problems.push(`${at}.definition: expected string or null`);
    }
    if (e.groupWith !== null && typeof e.groupWith !== "string") {
      problems.push(`${at}.groupWith: expected string or null`);
    }
    if (
      e.mergedInto !== undefined &&
      e.mergedInto !== null &&
      typeof e.mergedInto !== "string"
    ) {
      problems.push(`${at}.mergedInto: expected string, null, or absent`);
    }
    if (
      e.wikipediaRedirectAcknowledged !== undefined &&
      e.wikipediaRedirectAcknowledged !== null &&
      typeof e.wikipediaRedirectAcknowledged !== "string"
    ) {
      problems.push(
        `${at}.wikipediaRedirectAcknowledged: expected string, null, or absent`,
      );
    }
    if (e.aliasFragments !== undefined) {
      if (!isObject(e.aliasFragments)) {
        problems.push(`${at}.aliasFragments: expected object`);
      } else {
        for (const [k, v] of Object.entries(
          e.aliasFragments as Record<string, unknown>,
        )) {
          if (typeof v !== "string") {
            problems.push(`${at}.aliasFragments["${k}"]: expected string`);
          }
        }
      }
    }
  }

  // Cross-reference checks: groupWith and mergedInto must point at real
  // slugs. We run these even when per-entry checks failed, to catch as
  // many problems as possible in one pass.
  const slugs = new Set(Object.keys(terms));
  for (const [slug, entry] of Object.entries(terms)) {
    if (!isObject(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.groupWith === "string" && !slugs.has(e.groupWith)) {
      problems.push(
        `terms["${slug}"].groupWith: points at unknown slug "${e.groupWith}"`,
      );
    }
    if (typeof e.mergedInto === "string" && !slugs.has(e.mergedInto)) {
      problems.push(
        `terms["${slug}"].mergedInto: points at unknown slug "${e.mergedInto}"`,
      );
    }
  }

  if (problems.length > 0) {
    throw new GlossaryValidationError(source, problems);
  }

  // Narrow: every field we care about has been validated above.
  return raw as unknown as GlossaryIndex;
}

/** Validate the cache. More tolerant: missing cache entries are treated
 *  as holes to fill, not errors, so we only guard against structurally
 *  broken files. */
export function validateGlossaryCache(
  raw: unknown,
  source: string = "glossary-cache.json",
): GlossaryCache {
  const problems: string[] = [];

  if (!isObject(raw)) {
    throw new GlossaryValidationError(source, [
      "root must be a JSON object",
    ]);
  }
  const root = raw as Record<string, unknown>;

  if (root.version !== undefined && typeof root.version !== "number") {
    problems.push(`version: expected number, got ${describeType(root.version)}`);
  }
  if (root.fetchedAt !== undefined && typeof root.fetchedAt !== "string") {
    problems.push(`fetchedAt: expected string`);
  }
  if (!isObject(root.terms)) {
    problems.push(`terms: expected object, got ${describeType(root.terms)}`);
    throw new GlossaryValidationError(source, problems);
  }
  const terms = root.terms as Record<string, unknown>;
  for (const [slug, entry] of Object.entries(terms)) {
    const at = `terms["${slug}"]`;
    if (!isObject(entry)) {
      problems.push(`${at}: expected object, got ${describeType(entry)}`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    for (const field of ["title", "description", "extract_html", "url"]) {
      if (typeof e[field] !== "string") {
        problems.push(`${at}.${field}: expected string`);
      }
    }
  }
  if (problems.length > 0) {
    throw new GlossaryValidationError(source, problems);
  }
  return raw as unknown as GlossaryCache;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isArrayOf(v: unknown, type: "string"): v is string[] {
  if (!Array.isArray(v)) return false;
  return v.every((x) => typeof x === type);
}

function describeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
