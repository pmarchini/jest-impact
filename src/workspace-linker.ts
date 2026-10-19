import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import micromatch from 'micromatch';
import { parse as parseYaml } from 'yaml';

export type WorkspacePackage = {
  name: string;
  /** Directory relative to the workspace root. */
  dir: string;
};

export type LinkResult = {
  linked: WorkspacePackage[];
  /** Packages already present in node_modules, from an install or an earlier run. */
  present: WorkspacePackage[];
};

/** Workspace packages declared by package.json `workspaces` or pnpm-workspace.yaml. */
export function workspacePackages(workspaceRoot: string, files: string[]): WorkspacePackage[] {
  const patterns = workspacePatterns(workspaceRoot);
  if (patterns.length === 0) return [];
  const include = patterns.filter((p) => !p.startsWith('!'));
  const exclude = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  const packages: WorkspacePackage[] = [];
  for (const file of files) {
    if (posix.basename(file) !== 'package.json' || file === 'package.json') continue;
    if (file.includes('node_modules/')) continue;
    const dir = posix.dirname(file);
    if (!micromatch.isMatch(dir, include) || micromatch.isMatch(dir, exclude)) continue;
    const name = readName(join(workspaceRoot, file));
    if (name) packages.push({ name, dir });
  }
  return packages;
}

/**
 * Symlinks each workspace package into the root node_modules so sovra can
 * resolve imports between packages without an install. Existing entries are
 * left alone.
 */
export function linkWorkspacePackages(workspaceRoot: string, packages: WorkspacePackage[]): LinkResult {
  const result: LinkResult = { linked: [], present: [] };
  for (const pkg of packages) {
    const linkPath = join(workspaceRoot, 'node_modules', pkg.name);
    if (pathExists(linkPath)) {
      result.present.push(pkg);
      continue;
    }
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(join(workspaceRoot, pkg.dir), linkPath, 'dir');
    result.linked.push(pkg);
  }
  return result;
}

function workspacePatterns(workspaceRoot: string): string[] {
  const pnpmFile = join(workspaceRoot, 'pnpm-workspace.yaml');
  if (existsSync(pnpmFile)) {
    const yaml = parseYaml(readFileSync(pnpmFile, 'utf8')) ?? {};
    return (yaml.packages ?? []).map(normalizePattern);
  }
  const pkg = JSON.parse(readFileSync(join(workspaceRoot, 'package.json'), 'utf8'));
  const workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? []);
  return workspaces.map(normalizePattern);
}

function normalizePattern(pattern: string): string {
  return pattern.replace(/^\.\//, '').replace(/\/$/, '');
}

function readName(file: string): string | undefined {
  try {
    const name = JSON.parse(readFileSync(file, 'utf8')).name;
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
