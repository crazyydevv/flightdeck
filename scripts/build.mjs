// Build with esbuild only, so the toolchain stays small:
//   node scripts/build.mjs          web app  -> dist/web  (+ a single-file preview)
//   node scripts/build.mjs --mcp    MCP tower -> dist/mcp/tower.mjs
//   node scripts/build.mjs --api    API routes -> dist/api (used by the dev server)
//   node scripts/build.mjs --netlify  web app + one Netlify function -> dist/netlify/functions/api.js
import { build } from 'esbuild';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';

const args = new Set(process.argv.slice(2));
const all = args.has('--all');
const FONTS = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,400..800&family=Martian+Mono:wdth,wght@75..112.5,400..700&display=swap';
const TITLE = 'FLIGHTDECK';

async function web() {
  await rm('dist/web', { recursive: true, force: true });
  await build({
    entryPoints: { app: 'src/ui/main.tsx' },
    outdir: 'dist/web/assets',
    bundle: true, minify: true, format: 'iife', target: 'es2020', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  });
  const js = await readFile('dist/web/assets/app.js', 'utf8');
  const css = await readFile('dist/web/assets/app.css', 'utf8');

  await writeFile('dist/web/index.html', `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${TITLE}</title>
<meta name="description" content="Radar, preflight, tower and black box for leveraged trades on Bitget stock perps and crypto.">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PGcgdHJhbnNmb3JtPSJyb3RhdGUoLTEyIDMyIDMyKSI+PHJlY3QgeD0iNyIgeT0iNyIgd2lkdGg9IjUwIiBoZWlnaHQ9IjUwIiByeD0iMTQuNzA1ODgyMzUyOTQxMTc2IiBmaWxsPSIjZmZjNTNkIi8+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMTcuMjk0MTE3NjQ3MDU4ODI2IDE3LjI5NDExNzY0NzA1ODgyNikgc2NhbGUoMC4xMTQ4ODk3MDU4ODIzNTI5NCkiPjxwYXRoIGQ9Ik0yMTUuNTIsMTk3LjI2YTgsOCwwLDAsMS0xLjg2LDguMzlsLTI0LDI0QTgsOCwwLDAsMSwxODQsMjMyYTcuMDksNy4wOSwwLDAsMS0uNzksMCw4LDgsMCwwLDEtNS44Ny0zLjUybC00NC4wNy02Ni4xMkwxMTIsMTgzLjU5VjIwOGE4LDgsMCwwLDEtMi4zNCw1LjY1cy0xNCwxNC4wNi0xNS44OCwxNS44OEE3LjkxLDcuOTEsMCwwLDEsOTEsMjMxLjQxYTgsOCwwLDAsMS0xMC40MS00LjM1bC0uMDYtLjE1LTE0LjctMzYuNzZMMjksMTc1LjQyYTgsOCwwLDAsMS0yLjY5LTEzLjA4bDE2LTE2QTgsOCwwLDAsMSw0OCwxNDRINzIuNGwyMS4yNy0yMS4yN0wyNy41Niw3OC42NWE4LDgsMCwwLDEtMS4yMi0xMi4zMmwyNC0yNGE4LDgsMCwwLDEsOC4zOS0xLjg2bDg1Ljk0LDMxLjI1TDE3Ni4yLDQwLjE5YTI4LDI4LDAsMCwxLDM5LjYsMzkuNmwtMzEuNTMsMzEuNTNaIiBmaWxsPSIjMDYwNzBjIi8+PC9nPjwvZz48L3N2Zz4=">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="assets/app.css">
</head>
<body>
<div id="root"></div>
<script src="assets/app.js"></script>
</body>
</html>
`);

  // One self-contained file: the same app with its CSS and JS inlined. It has
  // no server behind it, so it always runs on the recorded snapshot.
  await mkdir('dist/preview', { recursive: true });
  await writeFile('dist/preview/flightdeck.html', `<title>${TITLE}</title>
<link rel="stylesheet" href="${FONTS}">
<style>
${css}
</style>
<div id="root"></div>
<script>
${js.replace(/<\/script/gi, '<\\/script')}
</script>
`);
  console.log(`web: app.js ${(js.length / 1024).toFixed(0)} kB, app.css ${(css.length / 1024).toFixed(0)} kB`);
}

async function mcp() {
  await build({
    entryPoints: ['mcp/tower.ts'], outfile: 'dist/mcp/tower.mjs',
    bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'warning',
    banner: { js: '#!/usr/bin/env node' },
  });
  console.log('mcp: dist/mcp/tower.mjs');
}

async function api() {
  const files = (await readdir('api')).filter((f) => f.endsWith('.ts') && !f.startsWith('_'));
  await build({
    entryPoints: files.map((f) => `api/${f}`), outdir: 'dist/api', outExtension: { '.js': '.mjs' },
    bundle: true, platform: 'node', format: 'esm', target: 'node20', logLevel: 'warning',
  });
  console.log(`api: ${files.length} routes`);
}

async function netlify() {
  await rm('dist/netlify', { recursive: true, force: true });
  await build({
    entryPoints: ['netlify/api.ts'], outfile: 'dist/netlify/functions/api.js',
    bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'warning',
  });
  console.log('netlify: dist/netlify/functions/api.js');
}

if (args.has('--mcp') || all) await mcp();
if (args.has('--api') || all) await api();
if (args.has('--netlify')) await netlify();
if (all || args.has('--netlify') || (!args.has('--mcp') && !args.has('--api'))) await web();
