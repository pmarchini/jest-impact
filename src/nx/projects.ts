import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

export type NxProject = {
  name: string;
  /** Project root relative to the workspace root, '.' for the root project. */
  root: string;
  /** Not an Nx project: a Jest config no Nx project contains, run with plain `jest --config`. */
  jestOnly?: boolean;
};

export type JestTarget = {
  project: NxProject;
  /** The Nx target that runs Jest for this config, such as `test`; empty for a Jest-only project. */
  target: string;
  /** Jest config path relative to the workspace root. */
  configFile: string;
};

const JEST_CONFIG = /(^|\/)jest\.config\.(ts|mts|cts|js|mjs|cjs|json)$/;

/**
 * Finds Nx projects from project.json and package.json files, or from a
 * project graph file written by `nx graph --file`, which is exact.
 */
export function discoverProjects(workspaceRoot: string, files: string[], graphFile?: string): NxProject[] {
  if (graphFile) return projectsFromGraph(graphFile);
  const byRoot = new Map<string, NxProject>();
  for (const file of files) {
    const base = posix.basename(file);
    if (base !== 'project.json' && base !== 'package.json') continue;
    if (file.includes('node_modules/')) continue;
    const root = posix.dirname(file);
    // The root package.json describes the workspace, not a project, unless a project.json says otherwise.
    if (file === 'package.json') continue;
    const json = readJson(join(workspaceRoot, file));
    if (!json) continue;
    const name = base === 'project.json' ? json.name : (json.nx?.name ?? json.name);
    if (typeof name !== 'string') continue;
    // project.json wins over package.json in the same directory, as in Nx.
    if (base === 'project.json' || !byRoot.has(root)) byRoot.set(root, { name, root });
  }
  return [...byRoot.values()];
}

function projectsFromGraph(graphFile: string): NxProject[] {
  const json = JSON.parse(readFileSync(graphFile, 'utf8'));
  const nodes = json.graph?.nodes ?? json.nodes ?? {};
  return Object.values(nodes).map((node: any) => ({ name: node.name, root: node.data.root || '.' }));
}

/** Jest configs in the workspace, each tied to the Nx project and target that runs it. */
export function findJestTargets(workspaceRoot: string, files: string[], projects: NxProject[]): JestTarget[] {
  const configs = files.filter((f) => JEST_CONFIG.test(f) && !f.includes('node_modules/'));
  const projectConfigs = configs.filter((f) => posix.dirname(f) !== '.');
  // A root config next to project configs is the multi-project aggregator Nx generates.
  const candidates = projectConfigs.length > 0 ? projectConfigs : configs;
  const pluginTarget = jestPluginTargetName(workspaceRoot);
  const targets: JestTarget[] = [];
  for (const configFile of candidates) {
    const project = owningProject(configFile, projects);
    const target = project && (explicitJestTarget(workspaceRoot, project, configFile) ?? pluginTarget);
    if (project && target) {
      targets.push({ project, target, configFile });
    } else {
      // Still a Jest project (a root `jest` run picks it up through `projects`), so its tests count.
      const root = posix.dirname(configFile);
      targets.push({ project: { name: root, root, jestOnly: true }, target: '', configFile });
    }
  }
  return targets;
}

/** The deepest project whose root contains `file`. */
export function owningProject(file: string, projects: NxProject[]): NxProject | undefined {
  let best: NxProject | undefined;
  let bestDepth = -1;
  for (const project of projects) {
    const depth = project.root === '.' ? 0 : project.root.length;
    const inside = project.root === '.' || file === project.root || file.startsWith(project.root + '/');
    if (inside && depth > bestDepth) {
      best = project;
      bestDepth = depth;
    }
  }
  return best;
}

function jestPluginTargetName(workspaceRoot: string): string | undefined {
  const nxJson = readJson(join(workspaceRoot, 'nx.json'));
  for (const plugin of nxJson?.plugins ?? []) {
    const name = typeof plugin === 'string' ? plugin : plugin.plugin;
    if (name === '@nx/jest/plugin') {
      return (typeof plugin === 'object' && plugin.options?.targetName) || 'test';
    }
  }
  return undefined;
}

function explicitJestTarget(workspaceRoot: string, project: NxProject, configFile: string): string | undefined {
  const projectJson = readJson(join(workspaceRoot, project.root, 'project.json'));
  const targets = projectJson?.targets ?? {};
  for (const [name, target] of Object.entries<any>(targets)) {
    if (!/^@(nx|nrwl)\/jest:jest$/.test(target?.executor ?? '')) continue;
    const jestConfig: string | undefined = target.options?.jestConfig;
    if (!jestConfig || posix.normalize(jestConfig.replace('{projectRoot}', project.root)) === configFile) {
      return name;
    }
  }
  return undefined;
}

function readJson(path: string): any {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

