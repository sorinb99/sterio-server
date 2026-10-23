// Protected build: build/src holds the server as minified, obfuscated bundles
// (no source files, no comments, no readable names) beside the admin page and
// package.json. The Docker image and the Mac app ship build/, never src/.
// Paths the code opens relative to itself (../package.json, ./admin/,
// ../cacert.pem, ./discovery-worker.mjs) keep the same layout, so shared
// chunks sit beside the entries in build/src: in a subfolder, code moved into
// a chunk looked one folder too deep (Home failed: no discovery worker).
import { build } from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..'), out = path.join(root, 'build');
await rm(out, { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: ['src/index.mjs', 'src/cli.mjs', 'src/discovery-worker.mjs', 'src/healthcheck.mjs'],
  outdir: 'build/src', outExtension: { '.js': '.mjs' }, chunkNames: 'chunk-[hash]',
  bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node24',
  minify: true, legalComments: 'none', packages: 'external', logLevel: 'warning',
});
// Names and strings become unreadable; control flow stays as it is, so the
// streaming and scan loops keep their speed.
const options = {
  target: 'node', sourceType: 'module', compact: true, simplify: true,
  identifierNamesGenerator: 'hexadecimal', renameGlobals: false,
  stringArray: true, stringArrayEncoding: ['base64'], stringArrayThreshold: 0.75,
  stringArrayRotate: true, stringArrayShuffle: true, stringArrayIndexShift: true,
  stringArrayWrappersCount: 2, stringArrayWrappersType: 'function',
  splitStrings: true, splitStringsChunkLength: 8, numbersToExpressions: true,
  transformObjectKeys: false, controlFlowFlattening: false, deadCodeInjection: false,
  selfDefending: false, debugProtection: false, unicodeEscapeSequence: false,
};
async function scripts(folder) {
  const files = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) files.push(...await scripts(file));
    else if (entry.name.endsWith('.mjs')) files.push(file);
  }
  return files;
}
for (const file of await scripts(path.join(out, 'src')))
  await writeFile(file, JavaScriptObfuscator.obfuscate(await readFile(file, 'utf8'), options).getObfuscatedCode());
await mkdir(path.join(out, 'src', 'admin'), { recursive: true });
for (const name of ['index.html', 'style.css']) await cp(path.join(root, 'src', 'admin', name), path.join(out, 'src', 'admin', name));
// The dashboard script runs in the browser: minified like the server.
await build({ absWorkingDir: root, entryPoints: ['src/admin/app.js'], outfile: 'build/src/admin/app.js', minify: true, legalComments: 'none', format: 'iife', target: 'es2020', logLevel: 'warning' });
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await writeFile(path.join(out, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: 'module' }) + '\n');
console.log(`Protected build ${pkg.version} in build/`);
