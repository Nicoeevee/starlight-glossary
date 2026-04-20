import type { StarlightPlugin } from "@astrojs/starlight/types";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
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
  const lintEnabled = options.lint?.enabled ?? false;
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
              const indexPath = path.join(root, indexFile);
              const cachePath = path.join(root, cacheFile);

              const context: ProjectContext = { routePrefix, wikipediaBase };
              const { index, cache } = await loadGlossaryFiles(
                indexPath,
                cachePath,
                logger,
              );
              const data = joinGlossary(index, cache, context);
              const knownSlugs = new Set(Object.keys(data.terms));

              // Collect references + alias candidates seen during remark pass.
              const references: GlossaryReference[] = [];
              const aliasCandidates = new Map<string, Set<string>>();
              const onReference = (ref: GlossaryReference) => {
                references.push(ref);
                if (ref.label && ref.label !== ref.slug) {
                  const set =
                    aliasCandidates.get(ref.slug) ?? new Set<string>();
                  set.add(ref.label);
                  aliasCandidates.set(ref.slug, set);
                }
              };

              const lint = createLintCollector({
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
                    lint.remarkPlugin(),
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

              // At end of build, reconcile discoveries + alias promotions +
              // lint findings, write files atomically.
              astroCtx.addWatchFile?.(indexPath);
              astroCtx.addWatchFile?.(cachePath);

              const finalize = async () => {
                let mutated = false;

                // Promote alias candidates onto existing entries.
                for (const [slug, labels] of aliasCandidates) {
                  const entry = index.terms[slug];
                  if (!entry) continue;
                  for (const label of labels) {
                    if (label === slug) continue;
                    if (!entry.aliases.includes(label)) {
                      entry.aliases.push(label);
                      mutated = true;
                      logger.info(
                        `glossary: auto-promoted "${label}" as alias of "${entry.term}"`,
                      );
                    }
                  }
                }

                // Discover missing slugs via Wikipedia.
                if (discoveryEnabled) {
                  const missing = new Map<string, UnresolvedReference>();
                  for (const ref of references) {
                    if (index.terms[ref.slug]) continue;
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
                      `glossary: discovering ${missing.size} new term(s) via Wikipedia…`,
                    );
                    const report = await discoverMissingTerms(
                      Array.from(missing.values()),
                      index,
                      cache,
                      logger,
                    );
                    if (report.added.length > 0) mutated = true;
                  }
                }

                if (mutated) {
                  cache.fetchedAt = new Date().toISOString();
                  await writeJsonAtomic(indexPath, index);
                  await writeJsonAtomic(cachePath, cache);
                  logger.info(
                    `glossary: saved updates to ${indexFile} + ${cacheFile}`,
                  );
                }

                if (lintEnabled) {
                  const findings = lint.findings();
                  if (findings.length > 0) {
                    const out = path.join(root, ".astro/glossary-lint.md");
                    await writeJsonAtomic(out, renderLintReport(findings));
                    logger.info(
                      `glossary: lint report → ${out} (${findings.length} candidate(s))`,
                    );
                  }
                }
              };

              // Hook finalize into the astro:build:done signal. Dev mode
              // doesn't fire build:done on every edit, so we also finalize
              // after the first full dev prerender — but in practice the
              // dev server keeps references accumulating across reloads,
              // so we debounce writes.
              addIntegration({
                name: "starlight-glossary/finalize",
                hooks: {
                  "astro:build:done": finalize,
                  "astro:server:done": finalize,
                },
              } as unknown as never);

              // Re-expose for callers using addIntegration pattern:
              void addIntegration;
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
      `Could not read ${cachePath}; tooltips will render without Wikipedia summaries until :refresh runs.`,
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
