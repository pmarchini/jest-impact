import { createRequire } from 'node:module';
import { posix } from 'node:path';
import { parse as parseYaml, parseAllDocuments } from 'yaml';
import { nameFromSpec, type LockGraph, type LockPackage } from './graph.ts';

const require = createRequire(import.meta.url);

export type LockfileKind = 'yarn-berry' | 'yarn-classic' | 'npm' | 'pnpm';

export const LOCKFILES: Array<{ file: string; kind: LockfileKind | 'yarn' }> = [
  { file: 'pnpm-lock.yaml', kind: 'pnpm' },
  { file: 'yarn.lock', kind: 'yarn' },
  { file: 'package-lock.json', kind: 'npm' },
  { file: 'npm-shrinkwrap.json', kind: 'npm' },
];

/** Direct dependencies as declared in package.json files, for lockfiles that do not record them. */
export type DeclaredDependencies = Array<{ name: string; range: string }>;

export function parseLockfile(
  file: string,
  content: string,
  declared: DeclaredDependencies,
): { kind: LockfileKind; graph: LockGraph } {
  if (file === 'pnpm-lock.yaml') return { kind: 'pnpm', graph: parsePnpm(content) };
  if (file === 'yarn.lock') {
    return content.includes('__metadata:')
      ? { kind: 'yarn-berry', graph: parseYarnBerry(content) }
      : { kind: 'yarn-classic', graph: parseYarnClassic(content, declared) };
  }
  return { kind: 'npm', graph: parseNpm(content) };
}

function graph(): LockGraph {
  return { packages: new Map(), directDependencies: new Set() };
}

function addPackage(target: LockGraph, pkg: LockPackage): void {
  target.packages.set(pkg.id, pkg);
}

// Yarn 2+: entries keyed by comma-separated descriptors, identified by `resolution`.
function parseYarnBerry(content: string): LockGraph {
  const doc = parseYaml(content) as Record<string, any>;
  const result = graph();
  const idByDescriptor = new Map<string, string>();
  for (const [key, entry] of Object.entries(doc)) {
    if (key === '__metadata') continue;
    for (const descriptor of key.split(/,\s*/)) idByDescriptor.set(descriptor.trim(), entry.resolution);
  }
  const workspaces: any[] = [];
  for (const [key, entry] of Object.entries(doc)) {
    if (key === '__metadata') continue;
    const id: string = entry.resolution;
    const deps = Object.entries<string>({ ...entry.dependencies, ...entry.optionalDependencies })
      .map(([name, range]) => idByDescriptor.get(`${name}@${range}`))
      .filter((d): d is string => !!d);
    if (id.includes('@workspace:')) {
      workspaces.push(deps);
      continue;
    }
    addPackage(result, {
      id,
      name: nameFromSpec(id),
      fingerprint: `${entry.version}|${entry.checksum ?? ''}|${deps.sort().join(',')}`,
      dependencies: deps,
    });
  }
  for (const deps of workspaces) for (const dep of deps) if (!dep.includes('@workspace:')) result.directDependencies.add(dep);
  return result;
}

// Yarn 1: entries keyed by `name@range`, with no record of workspaces.
function parseYarnClassic(content: string, declared: DeclaredDependencies): LockGraph {
  const lockfile = require('@yarnpkg/lockfile');
  const parsed = lockfile.parse(content);
  if (parsed.type !== 'success') throw new Error(`yarn.lock could not be parsed (${parsed.type})`);
  const entries = parsed.object as Record<string, any>;
  const result = graph();
  const idOf = (name: string, range: string) => {
    const entry = entries[`${name}@${range}`];
    return entry ? `${name}@${entry.version}` : undefined;
  };
  for (const [key, entry] of Object.entries(entries)) {
    const name = nameFromSpec(key);
    const deps = Object.entries<string>({ ...entry.dependencies, ...entry.optionalDependencies })
      .map(([depName, range]) => idOf(depName, range))
      .filter((d): d is string => !!d);
    addPackage(result, {
      id: `${name}@${entry.version}`,
      name,
      fingerprint: `${entry.version}|${entry.integrity ?? entry.resolved ?? ''}|${deps.sort().join(',')}`,
      dependencies: deps,
    });
  }
  for (const { name, range } of declared) {
    const id = idOf(name, range);
    if (id) result.directDependencies.add(id);
  }
  return result;
}

// npm 7+: entries keyed by install location; dependencies resolve like Node does.
function parseNpm(content: string): LockGraph {
  const lock = JSON.parse(content);
  if (!lock.packages) throw new Error('package-lock.json v1 is not supported; regenerate it with npm 7 or newer');
  const entries = lock.packages as Record<string, any>;
  const result = graph();
  const resolveFrom = (location: string, name: string): string | undefined => {
    for (const dir of ancestorDirs(location)) {
      const candidate = dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`;
      // Links point at workspace packages, which are not npm dependencies.
      if (candidate in entries) return entries[candidate].link ? undefined : candidate;
    }
    return undefined;
  };
  const depsOf = (location: string, entry: any) =>
    Object.keys({ ...entry.dependencies, ...entry.optionalDependencies, ...entry.devDependencies, ...entry.peerDependencies })
      .map((name) => resolveFrom(location, name))
      .filter((d): d is string => !!d);
  for (const [location, entry] of Object.entries(entries)) {
    if (entry.link) continue;
    const isWorkspace = !location.includes('node_modules/');
    if (isWorkspace) {
      for (const dep of depsOf(location, entry)) result.directDependencies.add(dep);
      continue;
    }
    const deps = depsOf(location, { dependencies: entry.dependencies, optionalDependencies: entry.optionalDependencies });
    addPackage(result, {
      id: location,
      name: entry.name ?? location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length),
      fingerprint: `${entry.version}|${entry.integrity ?? entry.resolved ?? ''}|${deps.sort().join(',')}`,
      dependencies: deps,
    });
  }
  return result;
}

// pnpm 6+: importers list each workspace's dependencies; v9 moves dependencies to `snapshots`.
function parsePnpm(content: string): LockGraph {
  // pnpm 10+ can prepend a document for its own version; the dependency graph is the last one.
  const documents = parseAllDocuments(content);
  if (!Array.isArray(documents)) throw new Error('pnpm-lock.yaml is empty');
  const lock = documents.at(-1)!.toJS() as Record<string, any>;
  const major = parseFloat(String(lock.lockfileVersion));
  if (!(major >= 6)) throw new Error(`pnpm lockfile version ${lock.lockfileVersion} is not supported`);
  const result = graph();
  const v9 = major >= 9;
  const nodes: Record<string, any> = v9 ? (lock.snapshots ?? {}) : (lock.packages ?? {});
  const meta: Record<string, any> = lock.packages ?? {};
  const idFor = (name: string, version: string): string | undefined => {
    if (version.startsWith('link:') || version.startsWith('workspace:')) return undefined;
    // Aliased dependencies record the real package's full spec as their version.
    return /^\d/.test(version) || !version.includes('@') ? `${name}@${version}` : stripSlash(version);
  };
  for (const [key, node] of Object.entries(nodes)) {
    const id = stripSlash(key);
    const deps = Object.entries<string>({ ...node?.dependencies, ...node?.optionalDependencies })
      .map(([name, version]) => idFor(name, String(version)))
      .filter((d): d is string => !!d);
    const info = v9 ? meta[id.replace(/\(.*$/, '')] : node;
    addPackage(result, {
      id,
      name: nameFromSpec(id),
      fingerprint: `${JSON.stringify(info?.resolution ?? {})}|${deps.sort().join(',')}`,
      dependencies: deps,
    });
  }
  const importers: Record<string, any> = lock.importers ?? { '.': lock };
  for (const importer of Object.values(importers)) {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, value] of Object.entries<any>(importer?.[field] ?? {})) {
        const id = idFor(name, String(typeof value === 'object' ? value.version : value));
        if (id) result.directDependencies.add(id);
      }
    }
  }
  return result;
}

/** Directories Node searches for node_modules from `location`, nearest first. */
function* ancestorDirs(location: string): Generator<string> {
  let dir = location;
  for (;;) {
    yield dir;
    if (dir === '') return;
    const nested = dir.lastIndexOf('/node_modules/');
    if (nested !== -1) dir = dir.slice(0, nested);
    else if (dir.startsWith('node_modules/')) dir = '';
    else dir = posix.dirname(dir) === '.' ? '' : posix.dirname(dir);
  }
}

function stripSlash(key: string): string {
  return key.startsWith('/') ? key.slice(1) : key;
}
