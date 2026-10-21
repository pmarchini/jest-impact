import { dirname, isAbsolute, normalize, resolve } from 'node:path';
import { inDirectory } from '../in-directory.ts';
import { ConfigEvaluator, interopDefault, packageName, resolveLocal } from './evaluate.ts';

/** The parts of a Jest project config the analyzer needs, with paths made absolute. */
export type JestProjectConfig = {
  configFile: string;
  rootDir: string;
  roots: string[];
  testMatch: string[];
  testRegex: string[];
  testPathIgnorePatterns: string[];
  modulePathIgnorePatterns: string[];
  moduleFileExtensions: string[];
  moduleNameMapper: Array<[pattern: string, targets: string[]]>;
  resolver: string | undefined;
  modulePaths: string[];
  moduleDirectories: string[];
  /** Local files evaluated to build the config: the config itself, its preset and helpers. */
  configModules: string[];
  /** Local files Jest loads around every test, such as setup files and transforms. */
  runtimeInputs: string[];
  /** Local files that moduleNameMapper entries point at, by pattern. */
  mapperTargets: Array<{ pattern: string; file: string }>;
  /** Packages the config loads: transforms, environments, presets, serializers. */
  configPackages: string[];
  /** testEnvironmentOptions.customExportConditions, which Jest adds when resolving exports. */
  exportConditions: string[];
  /** Parts of the config the evaluator had to stub because packages were not installed. */
  missingPackages: string[];
};

const DEFAULT_TEST_MATCH = ['**/__tests__/**/*.?([mc])[jt]s?(x)', '**/?(*.)+(spec|test).?([mc])[jt]s?(x)'];
const DEFAULT_EXTENSIONS = ['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'json', 'node'];

type RawConfig = Record<string, unknown>;

export async function loadJestProjectConfig(
  file: string,
  evaluator: ConfigEvaluator,
): Promise<JestProjectConfig> {
  // Absolute before the config's directory becomes the cwd below.
  const configFile = resolve(file);

  // Jest usually runs per package from a workspace script, so shared configs
  // may read the package directory from process.cwd(). Mirror that here.
  const { rootDir, merged, configModules, configPackages } = await inDirectory(dirname(configFile), () => evaluateConfig(configFile, evaluator));
  const references = runtimeReferences(merged, rootDir, evaluator);

  const moduleNameMapper = Object.entries(objectOf(merged.moduleNameMapper)).map(
    ([pattern, target]): [string, string[]] => [
      pattern,
      (Array.isArray(target) ? target : [target]).map((t) => normalizeTarget(replaceRootDir(String(t), rootDir))),
    ],
  );
  const mapperTargets = moduleNameMapper.flatMap(([pattern, targets]) =>
    targets.flatMap((target) => {
      const file = !target.includes('$') && isAbsolute(target) ? resolveLocal(target) : undefined;
      return file ? [{ pattern, file }] : [];
    }),
  );

  const testRegex = merged.testRegex;
  return {
    configFile,
    rootDir,
    roots: stringArray(merged.roots ?? ['<rootDir>']).map((r) => resolve(rootDir, replaceRootDir(r, rootDir))),
    testMatch: testRegex ? [] : stringArray(merged.testMatch ?? DEFAULT_TEST_MATCH).map((g) => replaceRootDir(g, rootDir)),
    testRegex: stringArray(testRegex),
    testPathIgnorePatterns: stringArray(merged.testPathIgnorePatterns ?? ['/node_modules/']).map((p) => replaceRootDir(p, rootDir)),
    modulePathIgnorePatterns: stringArray(merged.modulePathIgnorePatterns).map((p) => replaceRootDir(p, rootDir)),
    moduleFileExtensions: stringArray(merged.moduleFileExtensions ?? DEFAULT_EXTENSIONS),
    moduleNameMapper,
    resolver: typeof merged.resolver === 'string' ? replaceRootDir(merged.resolver, rootDir) : undefined,
    modulePaths: stringArray(merged.modulePaths).map((p) => resolve(rootDir, replaceRootDir(p, rootDir))),
    moduleDirectories: stringArray(merged.moduleDirectories ?? ['node_modules']),
    configModules: [...configModules],
    mapperTargets,
    runtimeInputs: [...references.files],
    configPackages: [...new Set([...configPackages, ...references.packages])],
    exportConditions: stringArray(objectOf(merged.testEnvironmentOptions).customExportConditions),
    missingPackages: [...evaluator.missingPackages],
  };
}

type EvaluatedConfig = {
  rootDir: string;
  /** The config with its preset merged in. */
  merged: RawConfig;
  /** Local files evaluated on the way: the config, its preset and their helpers. */
  configModules: Set<string>;
  /** Packages evaluated on the way, the preset included. */
  configPackages: Set<string>;
};

/** Evaluates a config file and its preset. Runs from the config's directory, see the caller. */
async function evaluateConfig(configFile: string, evaluator: ConfigEvaluator): Promise<EvaluatedConfig> {
  const raw = await evaluator.loadConfig(configFile);
  const rootDir = resolve(dirname(configFile), typeof raw.rootDir === 'string' ? raw.rootDir : '.');
  const deps = evaluator.dependenciesOf(configFile);
  const configModules = new Set(deps.files);
  const configPackages = new Set(['jest', ...deps.packages]);
  if (typeof raw.preset !== 'string') return { rootDir, merged: raw, configModules, configPackages };

  const preset = loadPreset(raw.preset, rootDir, evaluator);
  if (preset.file) {
    const presetDeps = evaluator.dependenciesOf(preset.file);
    for (const depFile of presetDeps.files) configModules.add(depFile);
    for (const name of presetDeps.packages) configPackages.add(name);
  }
  if (preset.packageName) configPackages.add(preset.packageName);
  return { rootDir, merged: mergePreset(preset.config, raw), configModules, configPackages };
}

function loadPreset(
  preset: string,
  rootDir: string,
  evaluator: ConfigEvaluator,
): { config: RawConfig; file?: string; packageName?: string } {
  const presetPath = replaceRootDir(preset, rootDir);
  const isPath = presetPath.startsWith('.') || isAbsolute(presetPath);
  if (isPath) {
    const file = resolveLocal(resolve(rootDir, presetPath)) ?? resolveLocal(resolve(rootDir, presetPath, 'jest-preset'));
    if (!file) throw new Error(`Jest preset ${preset} not found from ${rootDir}`);
    return { config: asConfig(interopDefault(evaluator.loadModule(file))), file };
  }
  const name = packageName(presetPath);
  const request = /\.(json|[mc]?js)$/.test(presetPath) ? presetPath : `${presetPath}/jest-preset`;
  const workspaceFile = evaluator.workspaceModule(request, resolutionAnchor(rootDir));
  if (workspaceFile) {
    return { config: asConfig(interopDefault(evaluator.loadModule(workspaceFile))), file: workspaceFile, packageName: name };
  }
  const value = evaluator.requirePackage(request, resolutionAnchor(rootDir));
  return { config: asConfig(interopDefault(value)), packageName: name };
}

/**
 * Where to resolve a package specifier from so that it lands where a config in
 * rootDir would find it. createRequire wants a file path; this one need not exist.
 */
function resolutionAnchor(rootDir: string): string {
  return resolve(rootDir, 'jest.config.js');
}

/** Jest's preset merge: arrays of setup files concatenate, maps let the config win. */
function mergePreset(preset: RawConfig, config: RawConfig): RawConfig {
  const merged: RawConfig = { ...preset, ...config };
  for (const key of ['setupFiles', 'setupFilesAfterEnv']) {
    if (preset[key] || config[key]) {
      merged[key] = [...stringArray(preset[key]), ...stringArray(config[key])];
    }
  }
  for (const key of ['moduleNameMapper', 'transform']) {
    if (preset[key] || config[key]) {
      merged[key] = { ...objectOf(config[key]), ...withoutKeys(objectOf(preset[key]), objectOf(config[key])) };
    }
  }
  return merged;
}

type RuntimeReferences = {
  /** Local files Jest loads around every test. */
  files: Set<string>;
  /** Packages Jest loads around every test. */
  packages: Set<string>;
};

/**
 * The modules a config points at for the test runtime: setup files,
 * serializers, the environment, resolver, runner, sequencer and transforms.
 * Local files become runtime inputs; anything else is a package whose upgrade
 * changes every test of the project, and a workspace package counts as both.
 */
function runtimeReferences(merged: RawConfig, rootDir: string, evaluator: ConfigEvaluator): RuntimeReferences {
  const references: RuntimeReferences = { files: new Set(), packages: new Set() };
  const record = (specifier: string) => {
    const spec = replaceRootDir(specifier, rootDir);
    if (spec.startsWith('.') || isAbsolute(spec)) {
      const file = resolveLocal(resolve(rootDir, spec));
      if (file) references.files.add(file);
      return;
    }
    references.packages.add(packageName(spec));
    const workspaceFile = evaluator.workspaceModule(spec, resolutionAnchor(rootDir));
    if (workspaceFile) references.files.add(workspaceFile);
  };

  for (const key of ['setupFiles', 'setupFilesAfterEnv', 'snapshotSerializers']) {
    for (const specifier of stringArray(merged[key])) record(specifier);
  }
  for (const key of ['globalSetup', 'globalTeardown', 'resolver', 'snapshotResolver', 'testRunner', 'testSequencer']) {
    if (typeof merged[key] === 'string') record(merged[key]);
  }
  if (typeof merged.testEnvironment === 'string') record(environmentPackage(merged.testEnvironment));
  for (const [, transformer] of Object.entries(objectOf(merged.transform))) {
    const specifier = Array.isArray(transformer) ? transformer[0] : transformer;
    if (typeof specifier === 'string') record(specifier);
  }
  return references;
}

/** Jest accepts `node` and `jsdom` as short names for the packages that implement them. */
function environmentPackage(testEnvironment: string): string {
  return testEnvironment === 'node' || testEnvironment === 'jsdom' ? `jest-environment-${testEnvironment}` : testEnvironment;
}

/** Absolute mapper targets are normalised so configs in different directories compare equal. */
function normalizeTarget(target: string): string {
  return isAbsolute(target) ? normalize(target) : target;
}

export function replaceRootDir(value: string, rootDir: string): string {
  return value.replaceAll('<rootDir>', rootDir);
}

function stringArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string');
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function withoutKeys(source: Record<string, unknown>, remove: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !(key in remove)));
}

function asConfig(value: unknown): RawConfig {
  return value && typeof value === 'object' ? (value as RawConfig) : {};
}
