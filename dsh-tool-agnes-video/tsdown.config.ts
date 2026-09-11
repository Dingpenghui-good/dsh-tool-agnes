import { defineConfig } from 'tsdown'

export default defineConfig({
  name: '@dingpenghui/agnes-video',
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  sourcemap: true,
  clean: true,
})
