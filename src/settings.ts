import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Settings = {
  /** Files that change every test run when they change, as globs from the workspace root. */
  globalFiles: string[];
  /** Files that never affect a test, such as docs and lint config. */
  ignoredFiles: string[];
  /** Packages that run or compile tests; any change to one runs everything. */
  runnerPackages: string[];
  /** Resolvers that behave like Jest's default for the imports sovra sees. */
  safeResolvers: string[];
  /** Export conditions to resolve with before the defaults, for repos whose custom resolver adds them. */
  conditionNames: string[];
  /** Files whose dynamic or unresolved imports a maintainer has checked and accepts, as globs. */
  trustedFiles: string[];
};

export const DEFAULT_SETTINGS: Settings = {
  globalFiles: [
    'nx.json',
    'pnpm-workspace.yaml',
    'tsconfig.json',
    'tsconfig.base.json',
    'jest.preset.{js,cjs,mjs,ts}',
    'jest.config.{js,cjs,mjs,ts,mts,cts,json}',
    'babel.config.{js,cjs,mjs,json}',
    '.babelrc{,.js,.json}',
    '.swcrc',
    'jest-impact.config.json',
  ],
  ignoredFiles: [
    '**/*.md',
    '**/LICENSE*',
    '**/.eslintrc*',
    '**/eslint.config.*',
    '**/.eslintignore',
    '**/.prettierrc*',
    '**/.prettierignore',
    '**/.gitignore',
    '**/.editorconfig',
    '.github/**',
    '.circleci/**',
    '.vscode/**',
    '.nx/**',
  ],
  runnerPackages: [
    'jest',
    'jest-*',
    '@jest/*',
    'ts-jest',
    'babel-jest',
    '@swc/jest',
    '@swc/core',
    '@babel/core',
    'typescript',
    'jest-preset-angular',
    '@nx/jest',
  ],
  safeResolvers: ['@nx/jest/plugins/resolver', '@nrwl/jest/plugins/resolver'],
  conditionNames: [],
  trustedFiles: [],
};

/** Reads `jest-impact.config.json` at the workspace root; each list given there replaces the default. */
export function loadSettings(workspaceRoot: string): Settings {
  const file = join(workspaceRoot, 'jest-impact.config.json');
  if (!existsSync(file)) return DEFAULT_SETTINGS;
  const overrides = JSON.parse(readFileSync(file, 'utf8')) as Partial<Settings>;
  return { ...DEFAULT_SETTINGS, ...overrides };
}
