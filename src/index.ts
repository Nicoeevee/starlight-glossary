import type { StarlightPlugin } from "@astrojs/starlight/types";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import remarkGlossary, {
  defaultSlugify,
  type GlossaryReference,
} from "./remark.js";
import {
  joinGlossary,
  type GlossaryCache,
  type GlossaryEntry,
  type GlossaryIndex,
  type ProjectContext,
} from "./data.js";
import {
  discoverMissingTerms,
  fillCacheHoles,
  type UnresolvedReference,
} from "./discovery.js";
import { reconcileWikipediaRedirects } from "./reconcile.js";
import { rewriteDocRefs } from "./rewrite-refs.js";
import { remarkAutoTag, type AutoTagMode } from "./autotag.js";
import { createLintCollector, renderLintReport } from "./lint.js";
import { writeJsonAtomic } from "./persist.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface StarlightGlossaryOptions {
  /** URL prefix for the index and JSON data routes. Default: `"/glossary"`. */
  routePrefix?: string;
  /** Path (relative to project root) to the committed index. */
  indexFile?: string;
  /** Path (relative to project root) to the Wikipedia cache. */
  cacheFile?: string;
  /** Base URL used to build Wikipedia links. */
  wikipediaBase?: string;
  autoTag?: {
    /** Default: `"first"`. `"off"` disables auto-tag entirely. */
    mode?: AutoTagMode;
  };
  discovery?: {
    /** Default: `true`. Set to `false` to leave unknown refs unresolved. */
    enabled?: boolean;
  };
  lint?: {
    /** Default: `false`. When enabled, writes `.astro/glossary-lint.md`. */
    enabled?: boolean;
    /** Default: `3`. */
    minOccurrences?: number;
  };
}

export default function starlightGlossary(
  options: StarlightGlossaryOptions = {},
): StarlightPlugin {
  const routePrefix = options.routePrefix ?? "/glossary";
  const indexFile = options.indexFile ?? "glossary.json";
  const cacheFile = options.cacheFile ?? "glossary-cache.json";
  const wikipediaBase = options.wikipediaBase ?? "https://en.wikipedia.org/wiki/";
  const autoTagMode: AutoTagMode = options.autoTag?.mode ?? "first";
  const discoveryEnabled = options.discovery?.enabled ?? true;
  const lintEnabled = options.lint?.enabled ?? true;
  const lintMinOccurrences = options.lint?.minOccurrences ?? 3;

  return {
    name: "starlight-glossary",
    hooks: {
      async "config:setup"({ addIntegration, logger, config, updateConfig }) {
        updateConfig({
          customCss: [
            "starlight-glossary/styles.css",
            ...(config.customCss ?? []),
          ],
        });

        // Shared state between the integration's setup and finalize hooks.
        // Captured here so both config:setup and build:done close over the
        // same references/candidate maps populated during remark passes.
        const references: GlossaryReference[] = [];
        const aliasCandidates = new Map<string, Set<string>>();
        let indexPath = "";
        let cachePath = "";
        let indexRef!: GlossaryIndex;
        let cacheRef!: GlossaryCache;
        let lintCollector: ReturnType<typeof createLintCollector> | null = null;
        // Dev-mode bookkeeping. We don't poll — instead, the remark
        // pass's onReference callback schedules a debounced finalize when
        // it sees content we haven't processed yet (new slug OR new
        // alias label for an existing slug). That way work only happens
        // when docs actually change.
        let finalizing = false;
        let devDebounce: ReturnType<typeof setTimeout> | null = null;
        let devMode = false;
        const knownSlugsSeen = new Set<string>();
        const knownAliasCandidates = new Map<string, Set<string>>();

        const scheduleDevFinalize = () => {
          if (!devMode) return;
          if (devDebounce) clearTimeout(devDebounce);
          devDebounce = setTimeout(async () => {
            devDebounce = null;
            if (finalizing) return;
            finalizing = true;
            try {
              await finalize();
            } catch (err) {
              logger.warn(
                `dev-mode finalize failed: ${(err as Error).message}`,
              );
            } finally {
              finalizing = false;
            }
          }, 2000);
        };

        const finalize = async () => {
          let mutated = false;

          // Promote alias candidates onto existing entries.
          for (const [slug, labels] of aliasCandidates) {
            const entry = indexRef.terms[slug];
            if (!entry) continue;
            for (const rawLabel of labels) {
              // Always store a clean form — no underscores / %28 artifacts
              // from Wikipedia slugs that happen to match.
              const label = cleanAlias(rawLabel);
              if (!label || label === slug || label === entry.term) continue;
              if (entry.aliases.includes(label)) continue;
              // Skip if the cleaned form equals a clean version of an
              // existing alias (avoid trailing duplicates).
              if (entry.aliases.some((a) => cleanAlias(a) === label)) continue;
              entry.aliases.push(label);
              mutated = true;
              logger.info(
                `auto-promoted "${label}" as alias of "${entry.term}"`,
              );
            }
          }

          // Discover any new slugs that appeared in doc references but
          // weren't in the index yet. (Known-slug cache holes get filled
          // earlier in config:setup so routes see the data.)
          if (discoveryEnabled) {
            const missing = new Map<string, UnresolvedReference>();
            for (const ref of references) {
              if (indexRef.terms[ref.slug]) continue;
              const existing = missing.get(ref.slug);
              if (existing) {
                if (!existing.locations.includes(ref.label))
                  existing.locations.push(ref.label);
              } else {
                missing.set(ref.slug, {
                  slug: ref.slug,
                  label: ref.label,
                  locations: [ref.label],
                });
              }
            }
            if (missing.size > 0) {
              logger.info(
                `discovering ${missing.size} new term(s) via Wikipedia…`,
              );
              const report = await discoverMissingTerms(
                Array.from(missing.values()),
                indexRef,
                cacheRef,
                logger,
              );
              if (report.added.length > 0) mutated = true;
            }
          }

          if (mutated) {
            cacheRef.fetchedAt = new Date().toISOString();
            await writeJsonAtomic(indexPath, indexRef);
            await writeJsonAtomic(cachePath, cacheRef);
            logger.info(`saved updates to ${indexFile} + ${cacheFile}`);
          }

          if (lintEnabled && lintCollector) {
            const findings = lintCollector.findings();
            if (findings.length > 0) {
              logger.info(
                `lint: ${findings.length} term(s) appear ≥${lintMinOccurrences}× without a glossary entry:`,
              );
              for (const f of findings.slice(0, 20)) {
                logger.info(`  · "${f.term}" (${f.occurrences}× · ${f.kind})`);
              }
              if (findings.length > 20) {
                logger.info(
                  `  … and ${findings.length - 20} more (see .astro/glossary-lint.md)`,
                );
              }
              const reportPath = path.join(
                path.dirname(indexPath),
                ".astro/glossary-lint.md",
              );
              await mkdir(path.dirname(reportPath), { recursive: true });
              await writeFile(reportPath, renderLintReport(findings), "utf8");
            } else {
              logger.info(
                "lint: every candidate term is already in the glossary",
              );
            }
          }
        };

        addIntegration({
          name: "starlight-glossary/integration",
          hooks: {
            async "astro:config:setup"(astroCtx) {
              const {
                injectRoute,
                injectScript,
                updateConfig,
                config: astroConfig,
              } = astroCtx;

              const root = fileURLToPath(astroConfig.root);
              indexPath = path.join(root, indexFile);
              cachePath = path.join(root, cacheFile);

              const context: ProjectContext = { routePrefix, wikipediaBase };
              const { index, cache } = await loadGlossaryFiles(
                indexPath,
                cachePath,
                logger,
              );
              indexRef = index;
              cacheRef = cache;

              // Normalise aliases before anything sees them: drop underscored
              // and URL-encoded duplicates (leftovers from the Wikipedia-slug
              // era of the data). The cleaned form gets persisted on the
              // next finalize write.
              let normalised = false;
              for (const entry of Object.values(indexRef.terms)) {
                const before = entry.aliases.length;
                entry.aliases = normaliseAliases(entry.aliases, entry.term);
                if (entry.aliases.length !== before) normalised = true;
              }

              // Critical: fill Wikipedia cache holes BEFORE we build the
              // virtual module. Route renders (including /glossary and the
              // tooltip data.json) happen after this returns — if the cache
              // was empty at this point, the serialised data would be empty
              // too and nothing short of a restart would fix it.
              let shouldPersist = normalised;
              if (discoveryEnabled) {
                const filled = await fillCacheHoles(
                  indexRef,
                  cacheRef,
                  logger,
                );
                if (filled > 0) shouldPersist = true;
              }

              // Now that cache is populated, reconcile Wikipedia redirects.
              // Conservative: only adopt canonical names that are case-only
              // or prefix-related to the user's term, and only merge when
              // another entry clearly owns the same article.
              const { report, mutated: reconciled } =
                reconcileWikipediaRedirects(indexRef, cacheRef);
              for (const r of report.merged) {
                logger.info(
                  `merged "${r.fromTerm}" (${r.from}) into "${r.intoTerm}" (${r.into})`,
                );
              }
              for (const r of report.renamed) {
                logger.info(
                  `adopted Wikipedia canonical name "${r.newTerm}" for slug "${r.slug}" (was "${r.oldTerm}")`,
                );
              }
              if (report.skipped.length > 0) {
                logger.info(
                  `${report.skipped.length} entries have Wikipedia redirects with substantial title changes — review glossary.json if you want to update them:`,
                );
                for (const s of report.skipped.slice(0, 10)) {
                  logger.info(
                    `  · "${s.term}" (${s.slug}) → Wikipedia: "${s.cachedTitle}"`,
                  );
                }
                if (report.skipped.length > 10) {
                  logger.info(
                    `  … and ${report.skipped.length - 10} more`,
                  );
                }
              }

              // Rewrite doc references so `[x](glossary:old-slug)` in
              // source becomes `[x](glossary:new-slug)` automatically.
              // Runs after merge/rename so slug changes propagate without
              // any manual find-and-replace. The mergedInto stubs remain
              // as a safety net for any refs we might miss.
              if (report.merged.length > 0) {
                const rewrites = new Map<string, string>();
                for (const m of report.merged) rewrites.set(m.from, m.into);
                const { filesChanged, refsChanged } = await rewriteDocRefs(
                  path.join(root, "src/content/docs"),
                  rewrites,
                  logger,
                );
                if (filesChanged > 0) {
                  logger.info(
                    `rewrote ${refsChanged} glossary link(s) across ${filesChanged} doc file(s) to match merged slugs`,
                  );
                }
              }

              if (reconciled) shouldPersist = true;

              if (shouldPersist) {
                cacheRef.fetchedAt = new Date().toISOString();
                await writeJsonAtomic(indexPath, indexRef);
                await writeJsonAtomic(cachePath, cacheRef);
              }

              const data = joinGlossary(indexRef, cacheRef, context);
              const knownSlugs = new Set(Object.keys(data.terms));
              // Map of merged-out slug → canonical slug, so remark can
              // forward doc links that still point at the old slug.
              const redirects = new Map<string, string>();
              for (const [slug, e] of Object.entries(indexRef.terms)) {
                if (e.mergedInto) redirects.set(slug, e.mergedInto);
              }

              const onReference = (ref: GlossaryReference) => {
                references.push(ref);
                let isNew = false;
                if (!knownSlugsSeen.has(ref.slug)) {
                  knownSlugsSeen.add(ref.slug);
                  if (!indexRef.terms[ref.slug]) isNew = true; // unknown slug → discovery candidate
                }
                if (ref.label && ref.label !== ref.slug) {
                  const set =
                    aliasCandidates.get(ref.slug) ?? new Set<string>();
                  set.add(ref.label);
                  aliasCandidates.set(ref.slug, set);
                  const dedupe =
                    knownAliasCandidates.get(ref.slug) ?? new Set<string>();
                  if (!dedupe.has(ref.label)) {
                    dedupe.add(ref.label);
                    knownAliasCandidates.set(ref.slug, dedupe);
                    isNew = true;
                  }
                }
                if (isNew) scheduleDevFinalize();
              };

              lintCollector = createLintCollector({
                enabled: lintEnabled,
                minOccurrences: lintMinOccurrences,
                data,
              });

              const serialised = JSON.stringify({
                terms: data.terms,
                context: data.context,
              });

              const existing = astroConfig.markdown?.remarkPlugins ?? [];
              updateConfig({
                markdown: {
                  remarkPlugins: [
                    ...existing,
                    [
                      remarkGlossary,
                      { routePrefix, knownSlugs, redirects, onReference },
                    ],
                    [
                      remarkAutoTag,
                      { mode: autoTagMode, routePrefix, data },
                    ],
                    lintCollector.remarkPlugin,
                  ],
                },
                vite: {
                  plugins: [
                    {
                      name: "starlight-glossary",
                      // Append our install directory onto the resolved
                      // fs.allow list rather than trying to merge via
                      // config() or updateConfig — both paths were seen
                      // to replace the array instead of extending it,
                      // which broke serving of starlight/node_modules
                      // assets. configResolved() runs after Vite has
                      // merged everything else, so we just push.
                      configResolved(config: {
                        server?: { fs?: { allow?: string[] } };
                      }) {
                        if (!config.server) return;
                        if (!config.server.fs) return;
                        const allow = config.server.fs.allow;
                        if (!Array.isArray(allow)) return;
                        if (!allow.includes(here)) allow.push(here);
                      },
                      resolveId(id: string): string | void {
                        if (id === "virtual:starlight-glossary/data")
                          return "\0virtual:starlight-glossary/data";
                      },
                      load(id: string): string | void {
                        if (id === "\0virtual:starlight-glossary/data")
                          return `export const glossaryData = ${serialised};`;
                      },
                    },
                  ],
                },
              });

              injectRoute({
                pattern: routePrefix,
                entrypoint: path.join(here, "routes/glossary.astro"),
                prerender: true,
              });
              injectRoute({
                pattern: `${routePrefix}/data.json`,
                entrypoint: path.join(here, "routes/data.json.ts"),
                prerender: true,
              });
              injectScript(
                "page",
                `import ${JSON.stringify(path.join(here, "client/tooltip.js"))};`,
              );
            },
            "astro:build:done": async () => {
              await finalize();
            },
            "astro:server:setup": () => {
              devMode = true;
            },
            "astro:server:done": async () => {
              if (devDebounce) {
                clearTimeout(devDebounce);
                devDebounce = null;
              }
              try {
                await finalize();
              } catch (err) {
                logger.warn(
                  `finalize on shutdown failed: ${(err as Error).message}`,
                );
              }
            },
          },
        });

        logger.info(
          `Glossary plugin active — reading ${indexFile}, index at ${routePrefix}, auto-tag: ${autoTagMode}`,
        );
      },
    },
  };
}

/** Normalise a raw alias string: underscores → spaces, %28/%29 → parens,
 *  trim. Mirrors the prettify rules the UI applies for display. */
function cleanAlias(s: string): string {
  return s
    .replace(/_/g, " ")
    .replace(/%28/g, "(")
    .replace(/%29/g, ")")
    .replace(/%27/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalise an entry's alias list: clean each alias, drop duplicates.
 *  The `term` is always kept as the first alias so auto-tag + lint see it
 *  as a valid match string. */
function normaliseAliases(aliases: string[], term: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [term];
  seen.add(term);
  for (const raw of aliases) {
    const cleaned = cleanAlias(raw);
    if (!cleaned) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

async function loadGlossaryFiles(
  indexPath: string,
  cachePath: string,
  logger: { warn: (msg: string) => void },
): Promise<{ index: GlossaryIndex; cache: GlossaryCache }> {
  let index: GlossaryIndex = { version: 1, terms: {} };
  let cache: GlossaryCache = {
    version: 1,
    fetchedAt: new Date(0).toISOString(),
    terms: {},
  };
  try {
    index = JSON.parse(await readFile(indexPath, "utf8"));
  } catch {
    logger.warn(`Could not read ${indexPath}; starting with an empty glossary.`);
  }
  try {
    cache = JSON.parse(await readFile(cachePath, "utf8"));
  } catch {
    logger.warn(
      `${cachePath} not found — any glossary references will be looked up on Wikipedia during this build.`,
    );
  }
  return { index, cache };
}

export { defaultSlugify };
export type {
  GlossaryEntry,
  GlossaryIndex,
  GlossaryCache,
  StarlightGlossaryOptions as Options,
};
