import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  // Bundle the workspace packages (they ship TS source); keep third-party deps
  // (commander, zod, picocolors) external so they resolve from node_modules at
  // runtime — bundling CJS deps into ESM breaks on dynamic requires.
  noExternal: [/^@horus\//],
  // mongodb is a CJS driver with dynamic requires — must stay external and resolve
  // from node_modules at runtime (it's a dependency of @horus/app).
  external: ['mongodb'],
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
});
