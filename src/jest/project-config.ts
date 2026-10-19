import { createRequire } from 'node:module';
import { dirname, isAbsolute, normalize, resolve } from 'node:path';
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
  configFile: string,
  evaluator: ConfigEvaluator,
): Promise<JestProjectConfig> {
  const missingBefore = new Set(evaluator.missingPackages);
  const raw = await evaluator.loadConfig(configFile);
  const rootDir = resolve(dirname(configFile), typeof raw.rootDir === 'string' ? raw.rootDir : '.');
  const configModules = new Set<string>(evaluator.dependenciesOf(configFile).files);
  const runtimeInputs = new Set<string>();
  const configPackages = new Set<string>(['jest', ...evaluator.dependenciesOf(configFile).packages]);

  let merged = raw;
  if (typeof raw.preset === 'string') {
    const preset = loadPreset(raw.preset, rootDir, evaluator);
    if (preset.file) {
      const deps = evaluator.dependenciesOf(preset.file);
      for (const file of deps.files) configModules.add(file);
      for (const name of deps.packages) configPackages.add(name);
    }
    if (preset.packageName) configPackages.add(preset.packageName);
    merged = mergePreset(preset.config, raw);
  }

  const ref = (value: string) => trackReference(value, rootDir, runtimeInputs, configPackages);

  for (const key of ['setupFiles', 'setupFilesAfterEnv', 'snapshotSerializers']) {
    for (const value of stringArray(merged[key])) ref(value);
  }
  for (const key of ['globalSetup', 'globalTeardown', 'testEnvironment', 'resolver', 'snapshotResolver', 'testRunner', 'testSequencer']) {
    const value = merged[key];
    if (typeof value === 'string') ref(environmentName(key, value));
  }
  for (const [, transformer] of Object.entries(objectOf(merged.transform))) {
    const name = Array.isArray(transformer) ? transformer[0] : transformer;
    if (typeof name === 'string') ref(name);
  }

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
    runtimeInputs: [...runtimeInputs],
    configPackages: [...configPackages],
    exportConditions: stringArray(objectOf(merged.testEnvironmentOptions).customExportConditions),
    missingPackages: [...evaluator.missingPackages].filter((p) => !missingBefore.has(p)),
  };
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
  const value = evaluator.requirePackage(request, resolve(rootDir, 'jest.config.js'));
  return { config: asConfig(interopDefault(value)), packageName: name };
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

/**
 * Records a module the config points at. Local files become config inputs;
 * anything else is a package whose upgrade changes every test of the project.
 */
function trackReference(value: string, rootDir: string, inputs: Set<string>, packages: Set<string>): void {
  const spec = replaceRootDir(value, rootDir);
  if (spec.startsWith('.') || isAbsolute(spec)) {
    const file = resolveLocal(resolve(rootDir, spec));
    if (file) inputs.add(file);
    return;
  }
  packages.add(packageName(spec));
  try {
    const file = createRequire(resolve(rootDir, 'jest.config.js')).resolve(spec);
    if (!file.includes('/node_modules/')) inputs.add(file);
  } catch {
    // Not installed; the package name alone is enough to match lockfile changes.
  }
}

function environmentName(key: string, value: string): string {
  if (key !== 'testEnvironment') return value;
  if (value === 'node' || value === 'jsdom') return `jest-environment-${value}`;
  return value;
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
