import { build } from 'esbuild';
import { readdir, rm, chmod, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { preserveAuthPlugin } from './scripts/preserve-auth.mjs';
import { createHash } from 'node:crypto';

await rm('dist', { recursive: true, force: true });
const buildHash = createHash('sha256');
for (const path of ['package.json', 'npm-shrinkwrap.json', 'build.mjs', 'scripts/preserve-auth.mjs', ...(await readdir('src')).sort().map(p => `src/${p}`), ...(await readdir('assets')).sort().map(p => `assets/${p}`)]) {
  buildHash.update(path).update(await readFile(path));
}
const result = await build({
  entryPoints: (await readdir('src')).filter(p => p.endsWith('.ts')).map(p => `src/${p}`),
  outdir: 'dist', bundle: true, splitting: true, platform: 'node', format: 'esm', target: 'node22',
  banner: { js: "import { createRequire as rexCreateRequire } from 'node:module'; const require = rexCreateRequire(import.meta.url);" },
  legalComments: 'linked', metafile: true,
  plugins: [preserveAuthPlugin],
  define: { REX_CLOUD_BUILD: JSON.stringify(buildHash.digest('hex')) },
});
await chmod('dist/cli.js', 0o755);
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs).filter(p => p.startsWith('node_modules/'))) {
  let dir = dirname(input);
  let pkg;
  while (dir !== '.') {
    try { pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')); if (pkg.name) break; } catch {}
    dir = dirname(dir);
  }
  if (!pkg?.name) continue;
  const identity = `${pkg.name}@${pkg.version}`;
  if (packages.has(identity)) continue;
  const licenses = (await readdir(dir)).filter(p => /^(licen[cs]e|copying|notice)(\..*)?$/i.test(p));
  packages.set(identity, `${identity} (${pkg.license ?? 'see upstream'})\n` +
    (await Promise.all(licenses.map(p => readFile(join(dir, p), 'utf8')))).join('\n'));
}
await writeFile('dist/THIRD_PARTY_NOTICES.txt', [...packages.values()].join('\n\n---\n\n') + '\n');
