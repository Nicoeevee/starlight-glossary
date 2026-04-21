// Local shim for Starlight's plugin interface. The real
// `@astrojs/starlight/types` export points at `types.ts`, which
// transitively imports Astro-internal virtual modules (`astro:content`,
// `virtual:starlight/*`) that aren't resolvable outside an Astro build
// context. Typechecking against those failed for us under `tsc --noEmit`.
//
// This shim is structural: the runtime shape is still defined by
// Starlight — if the real interface changes, we'll find out at build or
// runtime in the consumer project.

export interface StarlightIntegrationAstroConfigSetupCtx {
  injectRoute: (opts: {
    pattern: string;
    entrypoint: string;
    prerender?: boolean;
  }) => void;
  injectScript: (stage: "page" | "before-hydration", content: string) => void;
  updateConfig: (patch: Record<string, unknown>) => void;
  config: {
    root: URL;
    markdown?: { remarkPlugins?: unknown[] } & Record<string, unknown>;
  } & Record<string, unknown>;
}

export interface StarlightPlugin {
  name: string;
  hooks: {
    "config:setup": (ctx: {
      addIntegration: (integration: unknown) => void;
      logger: {
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error?: (msg: string) => void;
      };
      config: { customCss?: string[] } & Record<string, unknown>;
      updateConfig: (patch: Record<string, unknown>) => void;
    }) => void | Promise<void>;
  };
}
