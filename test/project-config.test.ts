import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ConfigEvaluator } from '../src/jest/evaluate.ts';
import { loadJestProjectConfig } from '../src/jest/project-config.ts';
import { selectTestFiles } from '../src/jest/test-files.ts';

/**
 * Two packages whose configs spread a shared base config from a workspace
 * package. The base derives rootDir from process.cwd(), which holds when Jest
 * runs per package from a workspace script.
 */
const WORKSPACE: Record<string, string> = {
  'packages/jest-config/package.json': JSON.stringify({ name: '@acme/jest-config' }),
  'packages/jest-config/base.js':
    "module.exports = { rootDir: process.cwd(), testMatch: ['**/*.test.ts', '!**/fixtures/**'] };\n",
  'apps/web/jest.config.cjs': "module.exports = { ...require('@acme/jest-config/base'), modulePaths: ['<rootDir>/src'] };\n",
  'apps/web/src/page.ts': 'export {};\n',
  'apps/web/src/page.test.ts': 'test("page", () => {});\n',
  'apps/web/src/fixtures/data.test.ts': 'export {};\n',
  'apps/admin/jest.config.cjs': "module.exports = { ...require('@acme/jest-config/base') };\n",
  'apps/admin/src/user.test.ts': 'test("user", () => {});\n',
};

let root: string;
const at = (path: string) => join(root, path);

describe('loadJestProjectConfig', () => {
  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'jest-impact-config-')));
    for (const [path, content] of Object.entries(WORKSPACE)) {
      mkdirSync(dirname(at(path)), { recursive: true });
      writeFileSync(at(path), content);
    }
    // What the workspace linker or an install leaves behind.
    mkdirSync(at('node_modules/@acme'), { recursive: true });
    symlinkSync(at('packages/jest-config'), at('node_modules/@acme/jest-config'));
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it('evaluates each config from its own directory when the base config uses process.cwd()', async () => {
    const evaluator = new ConfigEvaluator();
    const web = await loadJestProjectConfig(at('apps/web/jest.config.cjs'), evaluator);
    const admin = await loadJestProjectConfig(at('apps/admin/jest.config.cjs'), evaluator);
    assert.equal(web.rootDir, at('apps/web'));
    assert.deepEqual(web.roots, [at('apps/web')]);
    assert.deepEqual(web.modulePaths, [at('apps/web/src')]);
    assert.equal(admin.rootDir, at('apps/admin'));
    assert.notEqual(process.cwd(), at('apps/admin'));
  });

  it('counts a shared config from a workspace package as a config module', async () => {
    const web = await loadJestProjectConfig(at('apps/web/jest.config.cjs'), new ConfigEvaluator());
    assert.ok(web.configModules.includes(at('packages/jest-config/base.js')));
  });

  it('applies negated testMatch globs as exclusions, not as matches', async () => {
    const web = await loadJestProjectConfig(at('apps/web/jest.config.cjs'), new ConfigEvaluator());
    const files = Object.keys(WORKSPACE).map(at);
    assert.deepEqual(selectTestFiles(web, files), [at('apps/web/src/page.test.ts')]);
  });
});
