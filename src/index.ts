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
  type UnresolvedReference,
} from "./discovery.js";
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

        const finalize = async () => {
          let mutated = false;

          // Promote alias candidates onto existing entries.
          for (const [slug, labels] of aliasCandidates) {
            const entry = indexRef.terms[slug];
            if (!entry) continue;
            for (const label of labels) {
              if (label === slug) continue;
              if (!entry.aliases.includes(label)) {
                entry.aliases.push(label);
                mutated = true;
                logger.info(
                  `auto-promoted "${label}" as alias of "${entry.term}"`,
                );
              }
            }
          }

          // Discover missing slugs via Wikipedia.
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
              const data = joinGlossary(index, cache, context);
              const knownSlugs = new Set(Object.keys(data.terms));

              const onReference = (ref: GlossaryReference) => {
                references.push(ref);
                if (ref.label && ref.label !== ref.slug) {
                  const set =
                    aliasCandidates.get(ref.slug) ?? new Set<string>();
                  set.add(ref.label);
                  aliasCandidates.set(ref.slug, set);
                }
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
                      { routePrefix, knownSlugs, onReference },
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
                      name: "starlight-glossary-virtual",
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
            "astro:build:done": finalize,
            "astro:server:done": finalize,
          },
        });

        logger.info(
          `Glossary plugin active — reading ${indexFile}, index at ${routePrefix}, auto-tag: ${autoTagMode}`,
        );
      },
    },
  };
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
