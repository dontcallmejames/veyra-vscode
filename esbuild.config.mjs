import * as esbuild from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';

const watch = process.argv.includes('--watch');
const require = createRequire(import.meta.url);

const loaders = new Map([
  ['.css', 'text'],
  ['.js', 'js'],
  ['.jsx', 'jsx'],
  ['.json', 'json'],
  ['.ts', 'ts'],
  ['.tsx', 'tsx'],
]);

function resolveFile(baseDir, specifier) {
  const base = isAbsolute(specifier) ? specifier : resolve(baseDir, specifier);
  const candidates = [base];

  if (base.endsWith('.js')) {
    candidates.push(base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx');
  } else if (base.endsWith('.jsx')) {
    candidates.push(base.slice(0, -4) + '.tsx');
  } else if (!extname(base)) {
    candidates.push(
      base + '.ts',
      base + '.tsx',
      base + '.js',
      base + '.jsx',
      join(base, 'index.ts'),
      join(base, 'index.tsx'),
      join(base, 'index.js'),
    );
  }

  return candidates.find((candidate) => existsSync(candidate));
}

const nodeFsResolverPlugin = {
  name: 'node-fs-resolver',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (
        args.path === 'vscode' ||
        args.path.startsWith('node:') ||
        args.path === '@anthropic-ai/claude-agent-sdk'
      ) {
        return { path: args.path, external: true };
      }

      if (args.path.startsWith('.') || isAbsolute(args.path)) {
        const baseDir = args.importer
          ? dirname(args.importer)
          : build.initialOptions.absWorkingDir ?? process.cwd();
        const resolved = resolveFile(baseDir, args.path);
        if (resolved) return { path: resolved };
      }

      try {
        return {
          path: require.resolve(args.path, {
            paths: [args.importer ? dirname(args.importer) : process.cwd()],
          }),
        };
      } catch {
        return undefined;
      }
    });

    build.onLoad({ filter: /.*/ }, (args) => {
      const loader = loaders.get(extname(args.path));
      if (!loader) return undefined;
      return { contents: readFileSync(args.path, 'utf8'), loader };
    });
  },
};

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
  external: [
    'vscode',
    // Don't bundle the Claude Agent SDK — it ships a native claude.exe in
    // a platform-specific sibling package and resolves the binary path via
    // import.meta.url / require.resolve at runtime. Bundling breaks that
    // resolution (import.meta.url ends up pointing at our bundle, not the
    // SDK location), causing the SDK to throw "path argument undefined"
    // when it tries to spawn its native bridge.
    '@anthropic-ai/claude-agent-sdk',
  ],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
  plugins: [nodeFsResolverPlugin],
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
  plugins: [nodeFsResolverPlugin, copyHtmlPlugin],
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
