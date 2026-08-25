import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'),
) as { version: string };

// 版本以 module/module.prop 为单一事实来源（UI 徽标与模块版本保持一致）。
function readAppVersion(): string {
  try {
    const prop = readFileSync(
      fileURLToPath(new URL('./module/module.prop', import.meta.url)),
      'utf-8',
    );
    const v = /^version=(.*)$/m.exec(prop)?.[1]?.trim() ?? "";
    if (v) return v.replace(/^v/i, "");
  } catch {
    /* fall through to pkg.version */
  }
  return pkg.version;
}

function copySqlWasm(): Plugin {
  return {
    name: 'copy-sql-wasm',
    apply: 'build',
    async closeBundle() {
      const src = fileURLToPath(new URL('./node_modules/sql.js/dist/sql-wasm.wasm', import.meta.url));
      const destDir = fileURLToPath(new URL('./dist/assets/', import.meta.url));
      await fs.mkdir(destDir, { recursive: true });
      await fs.copyFile(src, path.join(destDir, 'sql-wasm.wasm'));
    },
  };
}

export default defineConfig({
  plugins: [vue(), copySqlWasm()],
  define: {
    __APP_VERSION__: JSON.stringify(readAppVersion()),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    rollupOptions: {
      output: {
        // KernelSU WebView loads via file://, so relative asset paths are mandatory
        assetFileNames: 'assets/[name]-[hash][extname]',
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
      },
    },
  },
  base: './',
  worker: {
    format: 'es',
  },
});
