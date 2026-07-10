// Public-API type barrel — re-exports the rolled distribution types.
//
// The per-module source .d.ts (src/*.d.ts) remain the intellisense source of
// truth during development, but only dist/ ships (see package.json "files").
// This stable top-level entry resolves to the bundled dist/granny-ro.d.ts so
// `granny-ro-js/index.d.ts` stays valid in the published tarball.

export * from './dist/granny-ro.js';
