import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { changedFiles, showFile, type ChangedFile } from './git.ts';
import { diffLockGraphs } from './lockfile/graph.ts';
import { LOCKFILES, parseLockfile, type DeclaredDependencies, type LockfileKind } from './lockfile/parsers.ts';

export type ManifestChange = {
  path: string;
  /** Dependency names whose declared range changed. */
  dependencies: string[];
  /** Whether anything other than dependency ranges and metadata changed. */
  otherFields: boolean;
};

export type ChangeSet = {
  files: ChangedFile[];
  lockfile?: {
    file: string;
    kind: LockfileKind;
    changedPackages: string[];
    affectedDirectDependencies: string[];
  };
  /** Set when the lockfile changed but could not be read; the caller must run everything. */
  lockfileError?: string;
  manifests: ManifestChange[];
  /** Package names to hand to sovra as `npm:` entries. */
  npmPackages: string[];
};

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'resolutions', 'overrides'];
const METADATA_FIELDS = ['version', 'description', 'keywords', 'author', 'contributors', 'license', 'repository', 'homepage', 'bugs', 'funding', 'publishConfig', 'private'];

export function collectChanges(workspaceRoot: string, base: string, head: string, manifestPaths: string[]): ChangeSet {
  const files = changedFiles(workspaceRoot, base, head);
  const changedPaths = new Set(files.map((f) => f.path));
  const manifests = files
    .filter((f) => posix.basename(f.path) === 'package.json' && !f.path.includes('node_modules/'))
    .map((f) => diffManifest(workspaceRoot, base, head, f.path));

  const result: ChangeSet = { files, manifests, npmPackages: [] };
  const npm = new Set<string>(manifests.flatMap((m) => m.dependencies));

  const lockfile = LOCKFILES.find(({ file }) => existsSync(join(workspaceRoot, file)));
  if (lockfile && changedPaths.has(lockfile.file)) {
    try {
      const headContent = showFile(workspaceRoot, head, lockfile.file) ?? '';
      const baseContent = showFile(workspaceRoot, base, lockfile.file) ?? '';
      const headLock = parseLockfile(lockfile.file, headContent, declaredDependencies(workspaceRoot, head, manifestPaths));
      const baseLock = parseLockfile(lockfile.file, baseContent, declaredDependencies(workspaceRoot, base, manifestPaths));
      const diff = diffLockGraphs(baseLock.graph, headLock.graph);
      result.lockfile = { file: lockfile.file, kind: headLock.kind, ...diff };
      // Changed packages are included as well as their direct parents, so
      // imports of hoisted packages nobody declares are still matched.
      for (const name of [...diff.affectedDirectDependencies, ...diff.changedPackages]) npm.add(name);
    } catch (error) {
      result.lockfileError = `${lockfile.file}: ${(error as Error).message}`;
    }
  }
  result.npmPackages = [...npm].sort();
  return result;
}

function diffManifest(workspaceRoot: string, base: string, head: string, path: string): ManifestChange {
  const before = parseJson(showFile(workspaceRoot, base, path));
  const after = parseJson(showFile(workspaceRoot, head, path));
  const dependencies = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    const a = before[field] ?? {};
    const b = after[field] ?? {};
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[name]) !== JSON.stringify(b[name])) dependencies.add(name);
    }
  }
  const ignored = new Set([...DEPENDENCY_FIELDS, ...METADATA_FIELDS]);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)].filter((k) => !ignored.has(k)));
  const otherFields = [...keys].some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  return { path, dependencies: [...dependencies].sort(), otherFields };
}

function declaredDependencies(workspaceRoot: string, commit: string, manifestPaths: string[]): DeclaredDependencies {
  const declared: DeclaredDependencies = [];
  for (const path of manifestPaths) {
    const json = parseJson(showFile(workspaceRoot, commit, path));
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, range] of Object.entries<string>(json[field] ?? {})) declared.push({ name, range });
    }
  }
  return declared;
}

function parseJson(content: string | undefined): Record<string, any> {
  if (!content) return {};
  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
}
