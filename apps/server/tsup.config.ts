import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  clean: true,
  // The shared package ships TypeScript source, so it has to be bundled.
  noExternal: ['@nicotes/shared'],
});
