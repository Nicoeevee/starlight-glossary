import type { StarlightPlugin } from "@astrojs/starlight/types";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import path from "node:path";
import remarkGlossary from "./remark.js";
import {
  joinGlossary,
  type GlossaryIndex,
  type GlossaryCache,
  type ProjectContext,
} from "./data.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface StarlightGlossaryOptions {
  /** URL prefix for the index and JSON data routes. Default: `"/glossary"`. */
  routePrefix?: string;
  /** Path (relative to project root) to the committed index. Default: `"glossary.json"`. */
  indexFile?: string;
  /** Path (relative to project root) to the Wikipedia cache. Default: `"glossary-cache.json"`. */
  cacheFile?: string;
  /** Legacy `[x](<protocol>:slug)` syntax to also accept. Default: `"glossary"`. */
  legacyProtocol?: string;
  /** Base URL used to build Wikipedia links. */
  wikipediaBase?: string;
}

/**
 * Starlight plugin: interactive glossary with hover tooltips, driven by a
 * single `glossary.json` index + `glossary-cache.json` Wikipedia cache.
 *
 *   - `[label](/glossary#slug)` or `[label](glossary:slug)` gets tooltip hooks
 *   - Injects `<routePrefix>` (index) + `<routePrefix>/data.json` (tooltip data)
 *   - Ships its own tooltip stylesheet
 */
export default function starlightGlossary(
  options: StarlightGlossaryOptions = {},
): StarlightPlugin {
  const routePrefix = options.routePrefix ?? "/glossary";
  const indexFile = options.indexFile ?? "glossary.json";
  const cacheFile = options.cacheFile ?? "glossary-cache.json";
  const legacyProtocol = options.legacyProtocol ?? "glossary";
  const wikipediaBase = options.wikipediaBase ?? "https://en.wikipedia.org/wiki/";

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
              const context: ProjectContext = { routePrefix, wikipediaBase };
              const { index, cache } = await loadGlossaryFiles(
                root,
                indexFile,
                cacheFile,
                logger,
              );
              const data = joinGlossary(index, cache, context);
              const knownSlugs = new Set(Object.keys(data.terms));

              // Serialise data for the virtual module.
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
                      { knownSlugs, routePrefix, legacyProtocol },
                    ],
                  ],
                },
                vite: {
                  plugins: [
                    {
                      name: "starlight-glossary-virtual",
                      resolveId(id): string | void {
                        if (id === "virtual:starlight-glossary/data")
                          return "\0virtual:starlight-glossary/data";
                      },
                      load(id): string | void {
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
          },
        });

        logger.info(
          `Glossary plugin active — reading ${indexFile}, index at ${routePrefix}`,
        );
      },
    },
  };
}

async function loadGlossaryFiles(
  root: string,
  indexFile: string,
  cacheFile: string,
  logger: { warn: (msg: string) => void },
): Promise<{ index: GlossaryIndex; cache: GlossaryCache }> {
  let index: GlossaryIndex = { version: 1, terms: {} };
  let cache: GlossaryCache = {
    version: 1,
    fetchedAt: new Date(0).toISOString(),
    terms: {},
  };
  try {
    index = JSON.parse(await readFile(path.join(root, indexFile), "utf8"));
  } catch {
    logger.warn(
      `Could not read ${indexFile}; starting with an empty glossary.`,
    );
  }
  try {
    cache = JSON.parse(await readFile(path.join(root, cacheFile), "utf8"));
  } catch {
    logger.warn(
      `Could not read ${cacheFile}; tooltips will render without Wikipedia summaries.`,
    );
  }
  return { index, cache };
}

export type { StarlightGlossaryOptions as Options };
