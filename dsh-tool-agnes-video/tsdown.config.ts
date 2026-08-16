import { defineConfig } from 'tsdown'

export default defineConfig({
  name: '@deepseek-ai/dsh-tool-agnes-video',
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
