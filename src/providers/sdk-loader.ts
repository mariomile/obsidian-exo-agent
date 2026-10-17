import type * as SdkExports from "./sdk-exports";

let sdk: typeof SdkExports | undefined;

/**
 * The Agent SDK, evaluated on first use instead of at plugin load. Its module
 * body is the single biggest startup cost of the bundle (~30ms of top-level
 * evaluation at every Obsidian start), and nothing needs it until the first
 * Claude session or tool server. A bundled `require()` keeps this synchronous:
 * esbuild wraps the SDK in a lazy init inside the same main.js, so callers
 * (session constructor, tool builders) stay sync and behave exactly as before.
 */
export function claudeSdk(): typeof SdkExports {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- a bundled require() is esbuild's synchronous lazy-init form
  return (sdk ??= require("./sdk-exports") as typeof SdkExports);
}
