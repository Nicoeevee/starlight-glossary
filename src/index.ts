import type { StarlightPlugin } from "@astrojs/starlight/types";
import { fileURLToPath } from "node:url";
import path from "node:path";
import remarkGlossary from "./remark";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface StarlightGlossaryOptions {
  /** Content collection name that holds glossary terms. Default: `"glossary"`. */
  collection?: string;
  /** URL prefix for the index and JSON data routes. Default: `"/glossary"`. */
  routePrefix?: string;
}

/**
 * Starlight plugin: interactive glossary with hover tooltips.
 *
 *   - `[label](glossary:slug)` in any page is rewritten to `/glossary#slug`
 *     with tooltip hooks at build time.
 *   - Injects `<routePrefix>` (index page) and `<routePrefix>/data.json`
 *     (compact definitions for the tooltip client).
 *   - Ships its own stylesheet; no changes to `customCss` required.
 */
export default function starlightGlossary(
  options: StarlightGlossaryOptions = {},
): StarlightPlugin {
  const collection = options.collection ?? "glossary";
  const routePrefix = options.routePrefix ?? "/glossary";

  return {
    name: "starlight-glossary",
    hooks: {
      "config:setup"({ addIntegration, logger, config, updateConfig }) {
        // Ship tooltip CSS; prepend so consumer `customCss` wins on conflicts.
        updateConfig({
          customCss: [
            "starlight-glossary/styles.css",
            ...(config.customCss ?? []),
          ],
        });

        addIntegration({
          name: "starlight-glossary/integration",
          hooks: {
            "astro:config:setup"(astroCtx) {
              const { injectRoute, injectScript, updateConfig, config } =
                astroCtx;
              // Astro's updateConfig replaces arrays, so carry forward any
              // remark plugins Starlight has already registered.
              const existing = config.markdown?.remarkPlugins ?? [];
              updateConfig({
                markdown: {
                  remarkPlugins: [
                    ...existing,
                    [remarkGlossary, { collection }],
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
          `Glossary plugin active — terms read from src/content/${collection}/, index at ${routePrefix}`,
        );
      },
    },
  };
}

export type { StarlightGlossaryOptions as Options };
