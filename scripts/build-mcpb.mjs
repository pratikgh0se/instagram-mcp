#!/usr/bin/env node
// Builds the platform-independent Claude Desktop bundle (.mcpb) into dist-mcpb/.
// Storage uses Node's built-in node:sqlite and both runtime dependencies are pure JS,
// so one bundle fits every OS/arch.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = join(root, '.mcpb-build');
const stage = join(buildDir, 'stage');
const outDir = join(root, 'dist-mcpb');
const MCPB = '@anthropic-ai/mcpb@2.1.2';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function run(cmd, args, cwd = root) {
  console.log(`\n> ${cmd} ${args.join(' ')}  (cwd: ${cwd})`);
  // shell:true is needed for .cmd shims on Windows; args are all static strings here.
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const pkg = readJson(join(root, 'package.json'));
const manifest = readJson(join(root, 'mcpb', 'manifest.json'));
if (manifest.version !== pkg.version) {
  throw new Error(`mcpb/manifest.json version ${manifest.version} != package.json version ${pkg.version}`);
}

// 1. TypeScript build
run(npm, ['run', 'build']);
if (!existsSync(join(root, 'dist'))) throw new Error('dist/ missing after build');

// 2. Clean staging dir
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const item of ['dist', 'package.json', 'package-lock.json', 'LICENSE', 'README.md']) {
  if (!existsSync(join(root, item))) throw new Error(`missing required file: ${item}`);
  cpSync(join(root, item), join(stage, item), { recursive: true });
}
cpSync(join(root, 'mcpb', '.mcpbignore'), join(stage, '.mcpbignore'));

// 3. Staged manifest (universal: darwin, win32, linux)
writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// 4. Strip lifecycle scripts so the production install does not run tsc
const stagedPkg = readJson(join(stage, 'package.json'));
delete stagedPkg.scripts;
delete stagedPkg.devDependencies;
writeFileSync(join(stage, 'package.json'), JSON.stringify(stagedPkg, null, 2) + '\n');

// 5. Production install; fail if any native addon slipped back in
run(npm, ['ci', '--omit=dev'], stage);

const nativeFiles = [];
(function scan(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) scan(p);
    else if (e.name.endsWith('.node') || e.name === 'binding.gyp') nativeFiles.push(p);
  }
})(join(stage, 'node_modules'));
if (nativeFiles.length > 0) {
  throw new Error(`bundle must be platform-independent, but found native files:\n${nativeFiles.join('\n')}`);
}

// 6. Validate and pack
run(npx, ['-y', MCPB, 'validate', join(stage, 'manifest.json')]);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `instagram-mcp-${pkg.version}.mcpb`);
run(npx, ['-y', MCPB, 'pack', stage, out]);
if (!existsSync(out)) throw new Error(`pack did not produce ${out}`);
console.log(`\nBuilt ${out}`);
