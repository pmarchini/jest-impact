import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, posix, relative, resolve } from 'node:path';
import micromatch from 'micromatch';
import { getAffected } from 'sovra';
import { collectChanges, type ChangeSet } from './changes.ts';
import { resolveCommit, trackedFiles } from './git.ts';
import { inDirectory } from './in-directory.ts';
import { ConfigEvaluator } from './jest/evaluate.ts';
import { CONFIG_FALLBACKS } from './jest/nx-preset.ts';
import { loadJestProjectConfig, type JestProjectConfig } from './jest/project-config.ts';
import { selectTestFiles } from './jest/test-files.ts';
import { findDynamicImports } from './dynamic-imports.ts';
import { findReferences } from './references.ts';
import { discoverProjects, findJestTargets, owningProject, type JestTarget, type NxProject } from './nx/projects.ts';
import { buildResolverOptions, parseJsonc, type ResolverSetup } from './resolver-options.ts';
import { loadSettings, type Settings } from './settings.ts';
import { parseSovraError, triage, type TriagedError } from './triage.ts';
import { linkWorkspacePackages, workspacePackages, type LinkResult, type WorkspacePackage } from './workspace-linker.ts';

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

/** A Jest target with its loaded config and, as the rules run, what they decided for it. */
type LoadedTarget = JestTarget & {
  config?: JestProjectConfig;
  configError?: string;
  tests: string[];
  /** Why the whole target must run; empty when only `selected` runs. */
  widenReasons: Reason[];
  selected: Set<string>;
};

/** Everything about the checkout at head that the change rules consult. */
type Workspace = {
  workspaceRoot: string;
  settings: Settings;
  /** Tracked files, relative to the workspace root. */
  files: string[];
  projects: NxProject[];
  packages: WorkspacePackage[];
  targets: LoadedTarget[];
  resolver: ResolverSetup;
  link?: LinkResult;
  warnings: string[];
};

/**
 * Lists the tests each Jest target must run for the changes between base and head.
 *
 * Two effects a caller should know about: unless `link` is false, workspace
 * packages are symlinked into the workspace's node_modules so sovra can resolve
 * them, and sovra runs with the workspace root as the process cwd, so two
 * analyses must not overlap in one process.
 */
export async function analyze(options: AnalyzeOptions): Promise<Report> {
  const started = performance.now();
  const base = resolveCommit(options.workspaceRoot, options.base);
  const head = resolveCommit(options.workspaceRoot, options.head);
  const workspace = await loadWorkspace(options);
  const { workspaceRoot, settings, targets } = workspace;

  const manifestPaths = ['package.json', ...workspace.packages.map((p) => `${p.root}/package.json`)];
  const changes = options.changeSet ?? collectChanges(workspaceRoot, base, head, manifestPaths);

  // The root manifest is often in sharedGlobals, but globalTriggers reads its diff field by field instead.
  const sharedGlobals = nxSharedGlobals(workspaceRoot).filter((f) => f !== 'package.json');
  const runAll = globalTriggers(changes, { ...settings, globalFiles: [...settings.globalFiles, ...sharedGlobals] });

  let ignoredFiles: string[] = [];
  let sovra: SovraOutcome = { affected: [], uncertainFiles: [], ignoredErrors: 0, sovraMs: 0 };
  if (runAll.length === 0) {
    const classified = classifyChanges(workspace, changes);
    ignoredFiles = classified.ignoredFiles;
    applyPackageRules(changes, targets);

    const entries = targetsByEntryFile(targets);
    sovra = await askSovra(workspace, changes, classified.sovraChanges, [...entries.keys()], manifestPaths);
    if (sovra.globalError) runAll.push({ rule: 'sovra-error', detail: sovra.globalError });
    markAffected(workspaceRoot, entries, sovra.affected);
  }

  return {
    base,
    head,
    runAll,
    projects: targets.map((target) => targetResult(target, runAll, workspaceRoot)),
    changes: { files: changes.files.length, npmPackages: changes.npmPackages, lockfile: changes.lockfile, ignoredFiles },
    uncertainFiles: sovra.uncertainFiles,
    ignoredErrors: sovra.ignoredErrors,
    link: workspace.link && { linked: workspace.link.linked.length, present: workspace.link.present.length },
    warnings: workspace.warnings,
    timings: { totalMs: Math.round(performance.now() - started), sovraMs: sovra.sovraMs },
  };
}

async function loadWorkspace(options: AnalyzeOptions): Promise<Workspace> {
  const workspaceRoot = resolve(options.workspaceRoot);
  const settings = options.settings ?? loadSettings(workspaceRoot);
  const files = trackedFiles(workspaceRoot);
  const projects = discoverProjects(workspaceRoot, files, options.nxGraph);
  const packages = workspacePackages(workspaceRoot, files);
  const link = options.link === false ? undefined : linkWorkspacePackages(workspaceRoot, packages);

  const targets = await loadTargets(workspaceRoot, files, projects, settings);
  for (const target of targets) if (target.project.jestOnly) projects.push(target.project);
  const warnings: string[] = [];
  const jestOnly = targets.filter((t) => t.project.jestOnly).map((t) => t.configFile);
  if (jestOnly.length > 0) warnings.push(`${jestOnly.length} Jest configs belong to no Nx project and are reported as plain Jest runs: ${jestOnly.join(', ')}`);

  const configs = targets.flatMap((t) => (t.config ? [t.config] : []));
  const resolver = buildResolverOptions(workspaceRoot, configs, settings.conditionNames);
  warnings.push(...resolver.warnings);

  // sovra cannot apply these mappings, so it follows the import to the real module. The
  // mapped file is loaded in that project instead: it widens the project like a setup file.
  for (const config of configs) {
    const unmapped = new Set((resolver.unmappedPatterns.get(config.configFile) ?? []).map((re) => re.source));
    for (const { pattern, file } of config.mapperTargets) {
      if (unmapped.has(new RegExp(pattern).source) && !config.runtimeInputs.includes(file)) config.runtimeInputs.push(file);
    }
  }

  return { workspaceRoot, settings, files, projects, packages, targets, resolver, link, warnings };
}

async function loadTargets(
  workspaceRoot: string,
  files: string[],
  projects: NxProject[],
  settings: Settings,
): Promise<LoadedTarget[]> {
  const absoluteFiles = files.map((f) => join(workspaceRoot, f));
  const evaluator = new ConfigEvaluator(CONFIG_FALLBACKS);
  const targets: LoadedTarget[] = [];
  for (const target of findJestTargets(workspaceRoot, files, projects)) {
    const loaded: LoadedTarget = { ...target, tests: [], widenReasons: [], selected: new Set() };
    try {
      const config = await loadJestProjectConfig(join(workspaceRoot, target.configFile), evaluator);
      loaded.config = config;
      loaded.tests = selectTestFiles(config, absoluteFiles);
      if (config.missingPackages.length > 0) {
        loaded.widenReasons.push({ rule: 'config-incomplete', detail: `config loads packages that are not installed: ${config.missingPackages.join(', ')}` });
      }
      const resolverId = config.resolver && (/^[./]/.test(config.resolver) ? relative(workspaceRoot, resolve(config.rootDir, config.resolver)) : config.resolver);
      if (resolverId && !settings.safeResolvers.includes(resolverId)) {
        loaded.widenReasons.push({ rule: 'custom-resolver', detail: `custom Jest resolver ${resolverId}; add it to safeResolvers once its behaviour is covered` });
      }
    } catch (error) {
      loaded.configError = (error as Error).message;
      loaded.widenReasons.push({ rule: 'config-error', detail: `Jest config could not be loaded: ${loaded.configError}` });
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

type ClassifiedChanges = {
  /** Paths sovra starts from: changed code, and the code a non-code change stands for. */
  sovraChanges: Set<string>;
  /** Changed files that can affect no test. */
  ignoredFiles: string[];
};

/**
 * Decides what each changed file means before the import graph is asked:
 * code goes to sovra, config and non-code files widen their project. Widening
 * is recorded on the targets, as is the test a changed snapshot belongs to.
 */
function classifyChanges(workspace: Workspace, changes: ChangeSet): ClassifiedChanges {
  const { workspaceRoot, files, projects, settings, targets } = workspace;
  const configInputOwners = new Map<string, LoadedTarget[]>();
  for (const target of targets) {
    for (const input of [...(target.config?.configModules ?? []), ...(target.config?.runtimeInputs ?? [])]) {
      const rel = relative(workspaceRoot, input);
      configInputOwners.set(rel, [...(configInputOwners.get(rel) ?? []), target]);
    }
  }
  const targetsOf = (project: NxProject | undefined) => targets.filter((t) => t.project === project);

  const sovraChanges = new Set<string>();
  const ignoredFiles: string[] = [];
  const widen = (project: NxProject | undefined, file: string, detail: string) => {
    for (const target of targetsOf(project)) target.widenReasons.push({ rule: 'non-code-change', detail, file });
    for (const code of projectCode(project, files)) sovraChanges.add(code);
  };

  const classify = (path: string): void => {
    const project = owningProject(path, projects);
    const base = posix.basename(path);

    const owners = configInputOwners.get(path);
    if (owners) {
      for (const target of owners) target.widenReasons.push({ rule: 'config-input', detail: 'Jest config or setup file changed', file: path });
      // The same file can also be imported by tests, in this project or another.
      if (CODE_EXTENSIONS.has(extname(path))) sovraChanges.add(path);
      return;
    }

    if (micromatch.isMatch(path, settings.ignoredFiles, { dot: true })) {
      ignoredFiles.push(path);
      return;
    }

    if (base === 'package.json') {
      // Code can import a manifest (`require('../package.json').version`), so its importers run on any edit.
      sovraChanges.add(path);
      const manifest = changes.manifests.find((m) => m.path === path);
      if (manifest && !manifest.otherFields) return;
      widen(project, path, 'package.json changed beyond dependency ranges');
      return;
    }

    if (project && PROJECT_CONFIG_FILES.some((glob) => micromatch.isMatch(base, glob, { dot: true }))) {
      for (const target of targetsOf(project)) target.widenReasons.push({ rule: 'project-config', detail: 'project config file changed', file: path });
      for (const [target, extender] of extendingTargets(workspace, path, project)) {
        target.widenReasons.push({ rule: 'project-config', detail: `extends a tsconfig that changed (${extender})`, file: path });
      }
      return;
    }

    if (path.split('/').includes('__mocks__')) {
      sovraChanges.add(path);
      const mocked = mockedModule(workspaceRoot, path, targets);
      if (mocked?.startsWith('npm:')) {
        // A package mock in a root replaces the package for every test that imports it.
        sovraChanges.add(mocked);
      } else if (mocked) {
        // A user module mock is used only where a test calls jest.mock() on that module without a factory.
        for (const caller of mockCallers(workspaceRoot, mocked)) sovraChanges.add(caller);
      } else {
        for (const target of targetsOf(project)) target.widenReasons.push({ rule: 'manual-mock', detail: 'a __mocks__ file changed; Jest loads these implicitly', file: path });
      }
      return;
    }

    // A snapshot selects its test. One whose test is gone is an ordinary non-code file.
    if (path.endsWith('.snap') && posix.basename(posix.dirname(path)) === '__snapshots__') {
      const testFile = join(workspaceRoot, posix.dirname(posix.dirname(path)), base.slice(0, -'.snap'.length));
      const owners = targets.filter((t) => t.tests.includes(testFile));
      for (const target of owners) target.selected.add(testFile);
      if (owners.length > 0) return;
    }

    if (CODE_EXTENSIONS.has(extname(path))) {
      sovraChanges.add(path);
      return;
    }

    if (!project) {
      ignoredFiles.push(path);
      return;
    }

    // A file named by the code that loads it (a template, an imported JSON) affects
    // that code's importers. One nothing names may be read by any code in its project.
    const references = findReferences(workspaceRoot, path);
    if (references.length > 0) {
      for (const reference of references) sovraChanges.add(reference);
      return;
    }
    widen(project, path, 'non-code file changed; it may be read at runtime');
  };

  for (const { path } of changes.files) classify(path);
  return { sovraChanges, ignoredFiles };
}

/**
 * A project's code counts as changed when sovra cannot see the change itself,
 * so tests in other projects that import the project run too.
 */
function projectCode(project: NxProject | undefined, files: string[]): string[] {
  if (!project) return [];
  const prefix = project.root === '.' ? '' : project.root + '/';
  return files.filter((f) => f.startsWith(prefix) && CODE_EXTENSIONS.has(extname(f)));
}

/** Targets of other projects whose tsconfig extends `changed`, each with the extending tsconfig. */
function extendingTargets(workspace: Workspace, changed: string, project: NxProject): Array<[LoadedTarget, string]> {
  if (!posix.basename(changed).startsWith('tsconfig')) return [];
  const pairs: Array<[LoadedTarget, string]> = [];
  for (const extender of tsconfigExtenders(workspace.workspaceRoot, workspace.files, changed)) {
    const owner = owningProject(extender, workspace.projects);
    if (owner === project) continue;
    for (const target of workspace.targets) if (target.project === owner) pairs.push([target, extender]);
  }
  return pairs;
}

type SovraOutcome = {
  /** Entry files that reach a change: tests to select, runtime inputs that widen their target. */
  affected: string[];
  uncertainFiles: Report['uncertainFiles'];
  ignoredErrors: number;
  /** An error after which the graph cannot be trusted at all. */
  globalError?: string;
  sovraMs: number;
};

/** sovra rejects an empty change list; a file that does not exist changes nothing. */
const NO_CHANGE = 'file:.jest-impact-no-change';

/**
 * Asks sovra which entry files reach a change. Runs with the workspace root as cwd, which sovra's
 * resolver needs.
 */
async function askSovra(
  workspace: Workspace,
  changes: ChangeSet,
  sovraChanges: Set<string>,
  entryFiles: string[],
  manifestPaths: string[],
): Promise<SovraOutcome> {
  const { workspaceRoot, settings, resolver, packages } = workspace;
  const changeList = [...sovraChanges, ...changes.npmPackages.map((n) => `npm:${n}`)];
  const started = performance.now();

  return inDirectory(workspaceRoot, () => {
    const run = (list: string[]) => getAffected(entryFiles, list, resolver.options, false, REQUIRE_ALIASES);
    const first = run(changeList.length > 0 ? changeList : [NO_CHANGE]);

    const triaged = first.errors.map((e) =>
      triage(parseSovraError(e), {
        workspacePackages: new Set(packages.map((p) => p.name)),
        npmPackages: knownNpmPackages(workspaceRoot, manifestPaths, changes),
        unmappedPatterns: [...resolver.unmappedPatterns.values()].flat(),
      }),
    );
    const uncertainFiles = groupUncertain([...triaged, ...dynamicImportErrors(workspaceRoot)]).filter((u) => !micromatch.isMatch(u.file, settings.trustedFiles));

    // Files whose imports sovra could not follow count as changed, so every test reaching them runs.
    let affected = changeList.length > 0 ? first.files : [];
    if (uncertainFiles.length > 0) affected = run([...changeList, ...uncertainFiles.map((u) => u.file)]).files;

    return {
      affected,
      uncertainFiles,
      ignoredErrors: triaged.filter((t) => t.verdict === 'ignore').length,
      globalError: triaged.find((t) => t.verdict === 'global')?.reason,
      sovraMs: Math.round(performance.now() - started),
    };
  });
}

/** Every file sovra starts from, with the targets it belongs to. */
function targetsByEntryFile(targets: LoadedTarget[]): Map<string, LoadedTarget[]> {
  const byFile = new Map<string, LoadedTarget[]>();
  const add = (file: string, target: LoadedTarget) => byFile.set(file, [...(byFile.get(file) ?? []), target]);
  for (const target of targets) {
    for (const test of target.tests) add(test, target);
    for (const input of target.config?.runtimeInputs ?? []) if (CODE_EXTENSIONS.has(extname(input))) add(input, target);
  }
  return byFile;
}

/** An affected test is selected; an affected runtime input widens its target. */
function markAffected(workspaceRoot: string, byFile: Map<string, LoadedTarget[]>, affected: string[]): void {
  for (const file of affected) {
    for (const target of byFile.get(file) ?? []) {
      if (target.tests.includes(file)) target.selected.add(file);
      else target.widenReasons.push({ rule: 'config-input-affected', detail: 'a setup file or config module imports a change', file: relative(workspaceRoot, file) });
    }
  }
}

function dynamicImportErrors(workspaceRoot: string): TriagedError[] {
  return findDynamicImports(workspaceRoot).map((file) => ({
    kind: 'dynamic',
    file,
    line: 0,
    message: 'import() with a non-literal argument',
    code: '',
    verdict: 'uncertain',
    reason: 'import() with a non-literal argument',
  }));
}

function targetResult(target: LoadedTarget, runAll: Reason[], workspaceRoot: string): ProjectResult {
  const all = runAll.length > 0 || target.widenReasons.length > 0;
  const tests = all ? target.tests : [...target.selected].sort();
  return {
    project: target.project.name,
    target: target.target,
    configFile: target.configFile,
    run: all ? 'all' : tests.length > 0 ? 'some' : 'none',
    reasons: runAll.length > 0 ? runAll : dedupeReasons(target.widenReasons),
    tests: tests.map((t) => relative(workspaceRoot, t)),
    totalTests: target.tests.length,
  };
}

/**
 * What a `__mocks__` file stands in for: `npm:<name>` for a package mock in a
 * Jest root, or the sibling module for a user module mock. Undefined when
 * neither exists, so the caller widens instead.
 */
function mockedModule(workspaceRoot: string, path: string, targets: LoadedTarget[]): string | undefined {
  const parts = path.split('/');
  const at = parts.lastIndexOf('__mocks__');
  const dir = parts.slice(0, at).join('/');
  const inside = parts.slice(at + 1).join('/');
  const name = inside.replace(/\.[cm]?[jt]sx?$/, '');
  if (name === inside || name.endsWith('/index')) return undefined;
  const roots = new Set(targets.flatMap((t) => t.config?.roots ?? []));
  if (roots.has(join(workspaceRoot, dir))) return `npm:${name}`;
  for (const ext of CODE_EXTENSIONS) {
    const sibling = posix.join(dir, name + ext);
    if (existsSync(join(workspaceRoot, sibling))) return sibling;
  }
  return undefined;
}

const MOCK_CALL = /jest\.(?:mock|doMock|unstable_mockModule)\(\s*(['"`])([^'"`]+)\1\s*\)/g;

/**
 * Files that call `jest.mock('<module>')` without a factory, which is when Jest
 * loads a user module's `__mocks__` file. A relative specifier must resolve to
 * the module; any other specifier whose last segment names it counts too,
 * since aliases are not resolved here.
 */
function mockCallers(workspaceRoot: string, module: string): string[] {
  const name = posix.basename(module).replace(/\.[^.]+$/, '');
  const stem = module.replace(/\.[^.]+$/, '');
  let candidates: string[];
  try {
    candidates = execFileSync('git', ['grep', '-l', '-E', '-e', 'jest\\.(mock|doMock|unstable_mockModule)\\(', '--', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mts', '*.cts', '*.mjs', '*.cjs', ':!**/node_modules/**'], { cwd: workspaceRoot, encoding: 'utf8', maxBuffer: 1 << 26 })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
  return candidates.filter((file) => {
    for (const [, , spec] of readFileSync(join(workspaceRoot, file), 'utf8').matchAll(MOCK_CALL)) {
      if (spec!.startsWith('.')) {
        const mockedPath = posix.normalize(posix.join(posix.dirname(file), spec!)).replace(/\.[cm]?[jt]sx?$/, '');
        if (mockedPath === stem || (name === 'index' && mockedPath === posix.dirname(module))) return true;
      } else if (posix.basename(spec!) === name || (name === 'index' && spec!.length > 0)) {
        return true;
      }
    }
    return false;
  });
}

/** Every tracked tsconfig that extends `changed`, directly or through other tsconfigs. */
function tsconfigExtenders(workspaceRoot: string, files: string[], changed: string): string[] {
  const extendedBy = new Map<string, string[]>();
  for (const file of files) {
    if (!/(^|\/)tsconfig[^/]*\.json$/.test(file) || file.includes('node_modules/')) continue;
    let json: any;
    try {
      json = parseJsonc(readFileSync(join(workspaceRoot, file), 'utf8'));
    } catch {
      continue;
    }
    for (const spec of [json?.extends ?? []].flat()) {
      if (typeof spec !== 'string' || !spec.startsWith('.')) continue;
      const extended = posix.normalize(posix.join(posix.dirname(file), spec.endsWith('.json') ? spec : `${spec}.json`));
      extendedBy.set(extended, [...(extendedBy.get(extended) ?? []), file]);
    }
  }
  const found = new Set<string>();
  const queue = [changed];
  while (queue.length > 0) {
    for (const extender of extendedBy.get(queue.pop()!) ?? []) {
      if (!found.has(extender)) {
        found.add(extender);
        queue.push(extender);
      }
    }
  }
  return [...found];
}

/** Files listed in nx.json's sharedGlobals input, which Nx itself treats as affecting every project. */
function nxSharedGlobals(workspaceRoot: string): string[] {
  try {
    const nxJson = createRequire(join(workspaceRoot, 'package.json'))(join(workspaceRoot, 'nx.json'));
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
    if (hit.length > 0) target.widenReasons.push({ rule: 'config-package', detail: `a package the Jest config loads changed: ${hit.join(', ')}` });
  }
}

function knownNpmPackages(workspaceRoot: string, manifestPaths: string[], changes: ChangeSet): Set<string> {
  const names = new Set(changes.npmPackages);
  const require = createRequire(join(workspaceRoot, 'package.json'));
  for (const path of manifestPaths) {
    try {
      const json = require(join(workspaceRoot, path));
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
