import { createRequire } from 'node:module';
import { extname, join, posix, relative, resolve } from 'node:path';
import micromatch from 'micromatch';
import { getAffected } from 'sovra';
import { collectChanges, type ChangeSet } from './changes.ts';
import { resolveCommit, trackedFiles } from './git.ts';
import { ConfigEvaluator } from './jest/evaluate.ts';
import { CONFIG_FALLBACKS } from './jest/nx-preset.ts';
import { loadJestProjectConfig, type JestProjectConfig } from './jest/project-config.ts';
import { selectTestFiles } from './jest/test-files.ts';
import { discoverProjects, findJestTargets, owningProject, type JestTarget, type NxProject } from './nx/projects.ts';
import { buildResolverOptions } from './resolver-options.ts';
import { loadSettings, type Settings } from './settings.ts';
import { parseSovraError, triage, type TriagedError } from './triage.ts';
import { linkWorkspacePackages, workspacePackages, type LinkResult } from './workspace-linker.ts';

export type AnalyzeOptions = {
  workspaceRoot: string;
  base: string;
  head: string;
  /** A graph written by `nx graph --file`, for exact project names and roots. */
  nxGraph?: string;
  /** Symlink workspace packages into node_modules. On by default. */
  link?: boolean;
  settings?: Settings;
  /** Use these changes instead of diffing base and head; for tests and validation. */
  changeSet?: ChangeSet;
};

export type Reason = { rule: string; detail: string; file?: string };

export type ProjectResult = {
  project: string;
  target: string;
  configFile: string;
  /** `all`: run the whole target. `some`: run only `tests`. `none`: skip the target. */
  run: 'all' | 'some' | 'none';
  reasons: Reason[];
  tests: string[];
  totalTests: number;
};

export type Report = {
  base: string;
  head: string;
  runAll: Reason[];
  projects: ProjectResult[];
  changes: {
    files: number;
    npmPackages: string[];
    lockfile?: ChangeSet['lockfile'];
    ignoredFiles: string[];
  };
  /** Files whose imports sovra could not follow; tests reaching them always run. */
  uncertainFiles: Array<{ file: string; reasons: string[] }>;
  ignoredErrors: number;
  link?: { linked: number; present: number };
  warnings: string[];
  timings: { totalMs: number; sovraMs: number };
};

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const PROJECT_CONFIG_FILES = ['tsconfig*.json', '.babelrc*', 'babel.config.*', '.swcrc', 'project.json', 'jest.config.*'];
const REQUIRE_ALIASES = ['jest.mock', 'jest.doMock', 'jest.requireActual', 'jest.requireMock', 'jest.unstable_mockModule', 'jest.createMockFromModule', 'jest.setMock'];

type LoadedTarget = JestTarget & {
  config?: JestProjectConfig;
  configError?: string;
  tests: string[];
  forced: Reason[];
  selected: Set<string>;
};

export async function analyze(options: AnalyzeOptions): Promise<Report> {
  const started = performance.now();
  const root = options.workspaceRoot;
  const settings = options.settings ?? loadSettings(root);
  const base = resolveCommit(root, options.base);
  const head = resolveCommit(root, options.head);
  const warnings: string[] = [];

  const files = trackedFiles(root);
  const absoluteFiles = files.map((f) => join(root, f));
  const projects = discoverProjects(root, files, options.nxGraph);
  const packages = workspacePackages(root, files);
  let link: LinkResult | undefined;
  if (options.link !== false) link = linkWorkspacePackages(root, packages);
  const targets = await loadTargets(root, files, absoluteFiles, projects, settings);
  for (const target of targets) if (target.project.jestOnly) projects.push(target.project);
  const jestOnly = targets.filter((t) => t.project.jestOnly).map((t) => t.configFile);
  if (jestOnly.length > 0) warnings.push(`${jestOnly.length} Jest configs belong to no Nx project and are reported as plain Jest runs: ${jestOnly.join(', ')}`);

  const configs = targets.flatMap((t) => (t.config ? [t.config] : []));
  const resolver = buildResolverOptions(root, configs, settings.conditionNames);
  warnings.push(...resolver.warnings);

  const manifestPaths = ['package.json', ...packages.map((p) => `${p.dir}/package.json`)];
  const changes = options.changeSet ?? collectChanges(root, base, head, manifestPaths);
  const report: Report = {
    base,
    head,
    runAll: [],
    projects: [],
    changes: { files: changes.files.length, npmPackages: changes.npmPackages, lockfile: changes.lockfile, ignoredFiles: [] },
    uncertainFiles: [],
    ignoredErrors: 0,
    link: link && { linked: link.linked.length, present: link.present.length },
    warnings,
    timings: { totalMs: 0, sovraMs: 0 },
  };

  // The root manifest is often in sharedGlobals, but its diff is already read field by field below.
  const sharedGlobals = nxSharedGlobals(root).filter((f) => f !== 'package.json');
  report.runAll = globalTriggers(changes, { ...settings, globalFiles: [...settings.globalFiles, ...sharedGlobals] });
  const sovraChanges = new Set<string>();
  if (report.runAll.length === 0) {
    applyFileRules(root, files, changes, targets, projects, settings, sovraChanges, report);
    applyPackageRules(changes, targets);

    const entries = new Map<string, LoadedTarget[]>();
    const add = (file: string, target: LoadedTarget) => entries.set(file, [...(entries.get(file) ?? []), target]);
    for (const target of targets) {
      for (const test of target.tests) add(test, target);
      for (const input of target.config?.runtimeInputs ?? []) if (CODE_EXTENSIONS.has(extname(input))) add(input, target);
    }
    const changeList = [...sovraChanges, ...changes.npmPackages.map((n) => `npm:${n}`)];

    const sovraStart = performance.now();
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const run = (list: string[]) => getAffected([...entries.keys()], list, resolver.options, false, REQUIRE_ALIASES);
      const first = run(changeList.length > 0 ? changeList : ['file:.jest-impact-no-change']);
      const triaged = first.errors.map((e) =>
        triage(parseSovraError(e), {
          workspacePackages: new Set(packages.map((p) => p.name)),
          npmPackages: knownNpmPackages(root, manifestPaths, changes),
          unmappedPatterns: [...resolver.unmappedPatterns.values()].flat(),
        }),
      );
      report.ignoredErrors = triaged.filter((t) => t.verdict === 'ignore').length;
      const global = triaged.find((t) => t.verdict === 'global');
      if (global) report.runAll.push({ rule: 'sovra-error', detail: global.reason });
      report.uncertainFiles = groupUncertain(triaged).filter((u) => !micromatch.isMatch(u.file, settings.trustedFiles));

      let affected = changeList.length > 0 ? first.files : [];
      if (report.uncertainFiles.length > 0) {
        affected = run([...changeList, ...report.uncertainFiles.map((u) => u.file)]).files;
      }
      for (const file of affected) {
        for (const target of entries.get(file) ?? []) {
          if (target.tests.includes(file)) target.selected.add(file);
          else target.forced.push({ rule: 'config-input-affected', detail: 'a setup file or config module imports a change', file: relative(root, file) });
        }
      }
    } finally {
      process.chdir(previousCwd);
      report.timings.sovraMs = Math.round(performance.now() - sovraStart);
    }
  }

  for (const target of targets) {
    const all = report.runAll.length > 0 || target.forced.length > 0;
    const tests = all ? target.tests : [...target.selected].sort();
    report.projects.push({
      project: target.project.name,
      target: target.target,
      configFile: target.configFile,
      run: all ? 'all' : tests.length > 0 ? 'some' : 'none',
      reasons: report.runAll.length > 0 ? report.runAll : dedupeReasons(target.forced),
      tests: tests.map((t) => relative(root, t)),
      totalTests: target.tests.length,
    });
  }
  report.timings.totalMs = Math.round(performance.now() - started);
  return report;
}

async function loadTargets(
  root: string,
  files: string[],
  absoluteFiles: string[],
  projects: NxProject[],
  settings: Settings,
): Promise<LoadedTarget[]> {
  const evaluator = new ConfigEvaluator(CONFIG_FALLBACKS);
  const targets: LoadedTarget[] = [];
  for (const target of findJestTargets(root, files, projects)) {
    const loaded: LoadedTarget = { ...target, tests: [], forced: [], selected: new Set() };
    try {
      const config = await loadJestProjectConfig(join(root, target.configFile), evaluator);
      loaded.config = config;
      loaded.tests = selectTestFiles(config, absoluteFiles);
      if (config.missingPackages.length > 0) {
        loaded.forced.push({ rule: 'config-incomplete', detail: `config loads packages that are not installed: ${config.missingPackages.join(', ')}` });
      }
      const resolverId = config.resolver && (/^[./]/.test(config.resolver) ? relative(root, resolve(config.rootDir, config.resolver)) : config.resolver);
      if (resolverId && !settings.safeResolvers.includes(resolverId)) {
        loaded.forced.push({ rule: 'custom-resolver', detail: `custom Jest resolver ${resolverId}; add it to safeResolvers once its behaviour is covered` });
      }
    } catch (error) {
      loaded.configError = (error as Error).message;
      loaded.forced.push({ rule: 'config-error', detail: `Jest config could not be loaded: ${loaded.configError}` });
    }
    targets.push(loaded);
  }
  return targets;
}

function globalTriggers(changes: ChangeSet, settings: Settings): Reason[] {
  const reasons: Reason[] = [];
  if (changes.lockfileError) reasons.push({ rule: 'lockfile-unreadable', detail: changes.lockfileError });
  for (const file of changes.files) {
    if (micromatch.isMatch(file.path, settings.globalFiles, { dot: true })) {
      reasons.push({ rule: 'global-file', detail: 'a workspace-wide config file changed', file: file.path });
    }
  }
  const rootManifest = changes.manifests.find((m) => m.path === 'package.json');
  if (rootManifest?.otherFields) {
    reasons.push({ rule: 'root-manifest', detail: 'root package.json changed beyond dependency ranges', file: 'package.json' });
  }
  const runners = changes.npmPackages.filter((name) => micromatch.isMatch(name, settings.runnerPackages));
  if (runners.length > 0) reasons.push({ rule: 'runner-package', detail: `test tooling changed: ${runners.join(', ')}` });
  return reasons;
}

/**
 * Decides what each changed file means before the import graph is asked:
 * code goes to sovra, config and non-code files widen their project.
 */
function applyFileRules(
  root: string,
  files: string[],
  changes: ChangeSet,
  targets: LoadedTarget[],
  projects: NxProject[],
  settings: Settings,
  sovraChanges: Set<string>,
  report: Report,
): void {
  const configInputOwners = new Map<string, LoadedTarget[]>();
  for (const target of targets) {
    for (const input of [...(target.config?.configModules ?? []), ...(target.config?.runtimeInputs ?? [])]) {
      const rel = relative(root, input);
      configInputOwners.set(rel, [...(configInputOwners.get(rel) ?? []), target]);
    }
  }
  const targetsOf = (project: NxProject | undefined) => targets.filter((t) => t.project === project);

  for (const { path } of changes.files) {
    const project = owningProject(path, projects);
    const owners = configInputOwners.get(path);
    if (owners) {
      for (const target of owners) target.forced.push({ rule: 'config-input', detail: 'Jest config or setup file changed', file: path });
      continue;
    }
    if (micromatch.isMatch(path, settings.ignoredFiles, { dot: true })) {
      report.changes.ignoredFiles.push(path);
      continue;
    }
    const base = posix.basename(path);
    if (base === 'package.json') {
      // Code can import a manifest (`require('../package.json').version`), so its importers run on any edit.
      sovraChanges.add(path);
      const manifest = changes.manifests.find((m) => m.path === path);
      if (manifest && !manifest.otherFields) continue;
      widenProject(project, targetsOf(project), path, 'package.json changed beyond dependency ranges', files, sovraChanges);
      continue;
    }
    if (project && PROJECT_CONFIG_FILES.some((glob) => micromatch.isMatch(base, glob, { dot: true }))) {
      for (const target of targetsOf(project)) target.forced.push({ rule: 'project-config', detail: 'project config file changed', file: path });
      continue;
    }
    if (path.split('/').includes('__mocks__')) {
      for (const target of targetsOf(project)) target.forced.push({ rule: 'manual-mock', detail: 'a __mocks__ file changed; Jest loads these implicitly', file: path });
      sovraChanges.add(path);
      continue;
    }
    if (path.endsWith('.snap') && posix.basename(posix.dirname(path)) === '__snapshots__') {
      const testFile = join(root, posix.dirname(posix.dirname(path)), base.slice(0, -'.snap'.length));
      const owners = targets.filter((t) => t.tests.includes(testFile));
      for (const target of owners) target.selected.add(testFile);
      if (owners.length > 0) continue;
    }
    if (CODE_EXTENSIONS.has(extname(path))) {
      sovraChanges.add(path);
      continue;
    }
    if (!project) {
      report.changes.ignoredFiles.push(path);
      continue;
    }
    widenProject(project, targetsOf(project), path, 'non-code file changed; it may be read at runtime', files, sovraChanges);
  }
}

/**
 * A change sovra cannot see inside a project: run the project's own tests and
 * treat its code as changed, so tests in other projects that import it run too.
 */
function widenProject(
  project: NxProject | undefined,
  targets: LoadedTarget[],
  file: string,
  detail: string,
  files: string[],
  sovraChanges: Set<string>,
): void {
  for (const target of targets) target.forced.push({ rule: 'non-code-change', detail, file });
  if (!project) return;
  const prefix = project.root === '.' ? '' : project.root + '/';
  for (const f of files) {
    if (f.startsWith(prefix) && CODE_EXTENSIONS.has(extname(f))) sovraChanges.add(f);
  }
}

/** Files listed in nx.json's sharedGlobals input, which Nx itself treats as affecting every project. */
function nxSharedGlobals(root: string): string[] {
  try {
    const nxJson = createRequire(join(root, 'package.json'))(join(root, 'nx.json'));
    const inputs: unknown[] = nxJson.namedInputs?.sharedGlobals ?? [];
    return inputs
      .filter((i): i is string => typeof i === 'string' && i.startsWith('{workspaceRoot}/'))
      .map((i) => i.slice('{workspaceRoot}/'.length));
  } catch {
    return [];
  }
}

function applyPackageRules(changes: ChangeSet, targets: LoadedTarget[]): void {
  const changed = new Set(changes.npmPackages);
  for (const target of targets) {
    const hit = (target.config?.configPackages ?? []).filter((p) => changed.has(p));
    if (hit.length > 0) target.forced.push({ rule: 'config-package', detail: `a package the Jest config loads changed: ${hit.join(', ')}` });
  }
}

function knownNpmPackages(root: string, manifestPaths: string[], changes: ChangeSet): Set<string> {
  const names = new Set(changes.npmPackages);
  const require = createRequire(join(root, 'package.json'));
  for (const path of manifestPaths) {
    try {
      const json = require(join(root, path));
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const name of Object.keys(json[field] ?? {})) names.add(name);
      }
    } catch {
      // A workspace without a readable manifest declares nothing.
    }
  }
  return names;
}

function groupUncertain(triaged: TriagedError[]): Report['uncertainFiles'] {
  const byFile = new Map<string, Set<string>>();
  for (const t of triaged) {
    if (t.verdict !== 'uncertain' || !t.file) continue;
    byFile.set(t.file, (byFile.get(t.file) ?? new Set()).add(t.reason));
  }
  return [...byFile].map(([file, reasons]) => ({ file, reasons: [...reasons] })).sort((a, b) => a.file.localeCompare(b.file));
}

function dedupeReasons(reasons: Reason[]): Reason[] {
  const seen = new Set<string>();
  return reasons.filter((r) => {
    const key = `${r.rule}|${r.detail}|${r.file ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
