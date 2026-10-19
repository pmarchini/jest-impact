import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { analyze, type Report } from '../src/analyze.ts';

/**
 * A two-library Nx workspace: `ui` imports `utils` through its package name,
 * and `utils` imports the npm package `left-pad`.
 */
const WORKSPACE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'acme', private: true, workspaces: ['libs/*'], devDependencies: { jest: '30.0.0' } }),
  'nx.json': JSON.stringify({ plugins: [{ plugin: '@nx/jest/plugin', options: { targetName: 'test' } }] }),
  'tsconfig.base.json': JSON.stringify({ compilerOptions: { customConditions: ['@acme/source'] } }),
  'jest.preset.js': "module.exports = { ...require('@nx/jest/preset').default };\n",
  'README.md': '# acme\n',
  'package-lock.json': lockfile('1.3.0'),
  'libs/utils/package.json': JSON.stringify({ name: '@acme/utils', exports: { '.': { '@acme/source': './src/index.ts', default: './dist/index.js' } }, dependencies: { 'left-pad': '^1.3.0' } }),
  'libs/utils/project.json': JSON.stringify({ name: 'utils' }),
  'libs/utils/jest.config.ts': "export default { displayName: 'utils', preset: '../../jest.preset.js' };\n",
  'libs/utils/src/index.ts': "export * from './pad';\nexport * from './sum';\n",
  'libs/utils/src/pad.ts': "import leftPad from 'left-pad';\nexport const pad = (s: string) => leftPad(s, 4);\n",
  'libs/utils/src/sum.ts': 'export const sum = (a: number, b: number) => a + b;\n',
  'libs/utils/src/sum.spec.ts': "import { sum } from './sum';\ntest('sum', () => expect(sum(1, 2)).toBe(3));\n",
  'libs/utils/src/pad.spec.ts': "import { pad } from './pad';\ntest('pad', () => expect(pad('1')).toBe('   1'));\n",
  'libs/ui/package.json': JSON.stringify({ name: '@acme/ui', dependencies: { '@acme/utils': '*' } }),
  'libs/ui/project.json': JSON.stringify({ name: 'ui' }),
  'libs/ui/jest.config.ts': "export default { displayName: 'ui', preset: '../../jest.preset.js', setupFilesAfterEnv: ['<rootDir>/src/test-setup.ts'] };\n",
  'libs/ui/src/test-setup.ts': "import './setup-helpers';\n",
  'libs/ui/src/setup-helpers.ts': 'export {};\n',
  'libs/ui/src/button.ts': "import { sum } from '@acme/utils';\nexport const width = () => sum(1, 1);\n",
  'libs/ui/src/button.spec.ts': "import { width } from './button';\ntest('width', () => expect(width()).toBe(2));\n",
  'libs/ui/src/label.ts': "export const label = 'x';\n",
  'libs/ui/src/label.spec.ts': "import { label } from './label';\ntest('label', () => expect(label).toBe('x'));\n",
  'libs/ui/src/button.html': '<button></button>\n',
};

function lockfile(leftPadVersion: string): string {
  return JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'acme', workspaces: ['libs/*'] },
      'libs/utils': { name: '@acme/utils', dependencies: { 'left-pad': '^1.3.0' } },
      'libs/ui': { name: '@acme/ui', dependencies: { '@acme/utils': '*' } },
      'node_modules/@acme/utils': { resolved: 'libs/utils', link: true },
      'node_modules/@acme/ui': { resolved: 'libs/ui', link: true },
      'node_modules/left-pad': { version: leftPadVersion, integrity: `sha-${leftPadVersion}` },
    },
  });
}

let root: string;

function write(files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

/** Commits `files` on top of the base commit and analyzes that commit. */
async function analyzeChange(files: Record<string, string>): Promise<Report> {
  git('checkout', '-q', '--detach', 'base');
  write(files);
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  return analyze({ workspaceRoot: root, base: 'base', head: 'HEAD' });
}

function selected(report: Report): Record<string, string[] | 'all'> {
  return Object.fromEntries(report.projects.map((p) => [p.project, p.run === 'all' ? 'all' : p.tests]));
}

describe('analyze', () => {
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'jest-impact-'));
    writeFileSync(join(root, '.gitignore'), 'node_modules\n');
    write(WORKSPACE);
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('tag', 'base');
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it('selects tests that import a changed file, across workspace packages', async () => {
    const report = await analyzeChange({ 'libs/utils/src/sum.ts': 'export const sum = (a: number, b: number) => b + a;\n' });
    assert.deepEqual(selected(report), {
      utils: ['libs/utils/src/sum.spec.ts'],
      ui: ['libs/ui/src/button.spec.ts'],
    });
  });

  it('selects nothing for an ignored file', async () => {
    const report = await analyzeChange({ 'README.md': '# acme!\n' });
    assert.deepEqual(selected(report), { utils: [], ui: [] });
    assert.deepEqual(report.changes.ignoredFiles, ['README.md']);
  });

  it('maps a lockfile change to the tests importing that package', async () => {
    const report = await analyzeChange({ 'package-lock.json': lockfile('1.3.1') });
    assert.deepEqual(report.changes.npmPackages, ['left-pad']);
    // button.ts imports the utils barrel, which re-exports pad.ts: file-level impact includes it.
    assert.deepEqual(selected(report), { utils: ['libs/utils/src/pad.spec.ts'], ui: ['libs/ui/src/button.spec.ts'] });
  });

  it('runs a whole project when its setup file depends on a change', async () => {
    const report = await analyzeChange({ 'libs/ui/src/setup-helpers.ts': 'export const x = 1;\n' });
    assert.deepEqual(selected(report), { utils: [], ui: 'all' });
  });

  it('runs a project and its importers when a non-code file in it changes', async () => {
    const report = await analyzeChange({ 'libs/utils/src/data.json': '{}\n' });
    assert.deepEqual(selected(report), { utils: 'all', ui: ['libs/ui/src/button.spec.ts'] });
  });

  it('runs a whole project when its own Jest config changes', async () => {
    const report = await analyzeChange({ 'libs/ui/jest.config.ts': "export default { displayName: 'ui!', preset: '../../jest.preset.js', setupFilesAfterEnv: ['<rootDir>/src/test-setup.ts'] };\n" });
    assert.deepEqual(selected(report), { utils: [], ui: 'all' });
  });

  it('runs everything when a workspace-wide config file changes', async () => {
    const report = await analyzeChange({ 'tsconfig.base.json': JSON.stringify({ compilerOptions: { customConditions: ['@acme/source'], strict: true } }) });
    assert.deepEqual(selected(report), { utils: 'all', ui: 'all' });
    assert.equal(report.runAll[0]?.rule, 'global-file');
  });

  it('counts a Jest config that no Nx project contains', async () => {
    await analyzeChange({
      'tools/check/jest.config.js': 'module.exports = {};\n',
      'tools/check/check.spec.ts': "import { sum } from '@acme/utils';\ntest('check', () => expect(sum(1, 1)).toBe(2));\n",
    });
    write({ 'libs/utils/src/sum.ts': 'export const sum = (a: number, b: number) => b + a;\n' });
    git('commit', '-q', '-am', 'change sum');
    const report = await analyze({ workspaceRoot: root, base: 'HEAD~1', head: 'HEAD' });
    assert.deepEqual(selected(report)['tools/check'], ['tools/check/check.spec.ts']);
    assert.equal(report.projects.find((p) => p.project === 'tools/check')?.target, '');
  });

  it('runs importers of a package.json when only its version changes', async () => {
    await analyzeChange({
      'libs/ui/src/version.ts': "export const version: string = require('../package.json').version;\n",
      'libs/ui/src/version.spec.ts': "import { version } from './version';\ntest('version', () => expect(version).toBeDefined());\n",
    });
    write({ 'libs/ui/package.json': JSON.stringify({ name: '@acme/ui', version: '1.0.1', dependencies: { '@acme/utils': '*' } }) });
    git('commit', '-q', '-am', 'bump ui');
    const report = await analyze({ workspaceRoot: root, base: 'HEAD~1', head: 'HEAD' });
    assert.deepEqual(selected(report), { utils: [], ui: ['libs/ui/src/version.spec.ts'] });
  });

  it('always runs tests that reach a dynamic require, even when nothing they import changed', async () => {
    await analyzeChange({ 'libs/ui/src/label.ts': "export const label = require(process.env.LABEL ?? './x');\n" });
    const report = await analyze({ workspaceRoot: root, base: 'HEAD', head: 'HEAD' });
    assert.deepEqual(report.uncertainFiles.map((u) => u.file), ['libs/ui/src/label.ts']);
    assert.deepEqual(selected(report), { utils: [], ui: ['libs/ui/src/label.spec.ts'] });
  });
});
