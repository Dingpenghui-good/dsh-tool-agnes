import { defineConfig } from 'tsdown'

export default defineConfig({
  name: '@deepseek-ai/dsh-tool-agnes-img2vid',
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
