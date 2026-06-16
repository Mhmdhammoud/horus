import { readFileSync } from 'fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));

export default defineConfig({
  entry: ['src/index.ts'],
  // Source is ESM ("type":"module" in package.json); tsup emits CJS.
  // The .cjs extension tells Node to run it as CommonJS regardless of
  // the package-level "type":"module", so require() and built-ins work.
  format: ['cjs'],
  outExtension: () => ({ js: '.cjs' }),
  target: 'node22',
  platform: 'node',
  bundle: true,
  minify: false,
  sourcemap: false,
  clean: true,
  shims: true,
  define: {
    __HORUS_VERSION__: JSON.stringify(version),
  },
  // Bundle all npm + workspace deps — output is self-contained.
  // Node.js built-ins stay external (platform:'node' ensures this).
  noExternal: [/.*/],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
