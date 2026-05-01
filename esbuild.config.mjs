import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');

const copyHtmlPlugin = {
  name: 'copy-html',
  setup(build) {
    build.onEnd(() => {
      mkdirSync('dist', { recursive: true });
      copyFileSync('src/webview/index.html', 'dist/index.html');
    });
  },
};

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

const webviewConfig = {
  entryPoints: ['src/webview/main.tsx'],
  bundle: true,
  outfile: 'dist/webview.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  jsx: 'automatic',
  jsxImportSource: 'preact',
  loader: { '.css': 'text' },
  plugins: [copyHtmlPlugin],
  logLevel: 'info',
};

if (watch) {
  const ctx1 = await esbuild.context(extensionConfig);
  const ctx2 = await esbuild.context(webviewConfig);
  await Promise.all([ctx1.watch(), ctx2.watch()]);
} else {
  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(webviewConfig),
  ]);
}
