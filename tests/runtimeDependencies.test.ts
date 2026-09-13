import './env';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { expect } from './harness';

/**
 * H9: every package the production server loads is a runtime dependency.
 *
 * `npm run build` bundles server.ts with `--packages=external`, so dist/server.cjs
 * loads each bare import from node_modules when it runs. A production install
 * (`npm ci --omit=dev`, `bun install --production`) holds `dependencies` only: a
 * package the server loads from `devDependencies`, or only through another
 * package's dependency, is missing there, and the server fails to start or fails
 * the moment the route that loads it runs.
 *
 * These read the externals from the same esbuild bundle the build makes, not from
 * a hand-kept list. The installed check — a clean production install booting the
 * built server — is `npm run verify:production-install`.
 */

interface PackageManifest {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  engines?: { node?: string };
}

const root = process.cwd();
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as PackageManifest;

const packageName = (specifier: string) => (specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
const isBuiltin = (specifier: string) => specifier.startsWith('node:') || builtinModules.includes(specifier.split('/')[0]);

/** Every package the server bundle loads at run time, statically or through `import()`. */
async function serverRuntimePackages(): Promise<string[]> {
  const esbuild = await import('esbuild');
  const result = await esbuild.build({
    entryPoints: [path.join(root, 'server.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const specifiers = Object.values(result.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter((entry) => entry.external)
    .map((entry) => entry.path);
  return [...new Set(specifiers.filter((specifier) => !isBuiltin(specifier)).map(packageName))].sort();
}

/** bun.lock is JSON with trailing commas. */
function readBunLock(): { workspaces: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>; packages: Record<string, unknown> } {
  return JSON.parse(readFileSync(path.join(root, 'bun.lock'), 'utf8').replace(/,(\s*[}\]])/g, '$1'));
}

describe('H9: the production server loads only runtime dependencies', () => {
  it('declares every package the built server loads in dependencies, and none of them only in devDependencies', async () => {
    const runtime = await serverRuntimePackages();
    // The four H9 found misdeclared, loaded at boot (multer, nanoid) or by a route (mammoth, pdf-parse).
    for (const name of ['multer', 'nanoid', 'mammoth', 'pdf-parse', 'express', 'vite']) expect(runtime).toContain(name);
    for (const name of runtime) {
      expect([name, Object.hasOwn(manifest.dependencies, name), Object.hasOwn(manifest.devDependencies, name)]).toEqual([name, true, false]);
    }
  });

  it('keeps a package out of both lists, so nothing is declared twice', () => {
    const both = Object.keys(manifest.dependencies).filter((name) => Object.hasOwn(manifest.devDependencies, name));
    expect(both).toEqual([]);
  });

  it('pins the Node version the runtime packages require', () => {
    // firebase-admin 14 needs Node 22; sanitize-html 2.17 needs 22.12.
    expect(manifest.engines?.node).toBe('>=22.12.0');
  });
});

describe('H9: the lockfile CI installs from matches package.json', () => {
  it('records exactly the declared dependency lists in bun.lock, with a resolution for every direct package', () => {
    const lock = readBunLock();
    const workspace = lock.workspaces[''];
    expect(workspace.dependencies ?? {}).toEqual(manifest.dependencies);
    expect(workspace.devDependencies ?? {}).toEqual(manifest.devDependencies);
    for (const name of [...Object.keys(manifest.dependencies), ...Object.keys(manifest.devDependencies)]) {
      expect([name, Array.isArray(lock.packages[name])]).toEqual([name, true]);
    }
  });
});
