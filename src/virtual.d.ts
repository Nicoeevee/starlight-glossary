// Ambient types for the virtual module emitted by the plugin at build
// time. The shape comes from `joinGlossary` in ./data.ts (terms + context
// only — aliasIndex is a Map and skipped during JSON serialisation).
declare module "virtual:starlight-glossary/data" {
  import type {
    ProjectContext,
    RuntimeGlossaryEntry,
  } from "./data.js";
  export const glossaryData: {
    terms: Record<string, RuntimeGlossaryEntry>;
    context: ProjectContext;
  };
}

