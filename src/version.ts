declare const __MCLI_VERSION__: string;

/** Injected by esbuild at build time (see scripts/build.mjs); "dev" for local builds. */
export const VERSION: string = typeof __MCLI_VERSION__ === 'string' ? __MCLI_VERSION__ : 'dev';
