import assert from 'node:assert/strict';
import { test } from 'node:test';
import YAML from 'yaml';
import type { ProjectResult, Report } from '../src/analyze.ts';
import { formatGitlabPipeline } from '../src/output.ts';

function report(projects: Array<Partial<ProjectResult> & Pick<ProjectResult, 'project' | 'run'>>): Report {
  return {
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    runAll: [],
    projects: projects.map((p) => ({ target: 'test', configFile: `libs/${p.project}/jest.config.ts`, reasons: [], tests: [], totalTests: 3, ...p })),
    changes: { files: 1, npmPackages: [], ignoredFiles: [] },
    uncertainFiles: [],
    ignoredErrors: 0,
    warnings: [],
    timings: { totalMs: 1, sovraMs: 1 },
  };
}

test('gitlab: one job per project that runs, with test paths under CI_PROJECT_DIR', () => {
  const yaml = formatGitlabPipeline(
    report([
      { project: 'state', run: 'some', tests: ['libs/state/src/+state/products.reducer.spec.ts'] },
      { project: 'cart', run: 'all' },
      { project: 'ui', run: 'none' },
      { project: 'bit-common', target: '', configFile: 'bitwarden_license/bit-common/jest.config.js', run: 'all' },
    ]),
    { include: ['ci/jest-job.yml'], extends: '.jest' },
  );
  assert.deepEqual(YAML.parse(yaml), {
    include: [{ local: 'ci/jest-job.yml' }],
    'test:state': { extends: '.jest', script: ['npx nx run state:test --runTestsByPath "$CI_PROJECT_DIR"/libs/state/src/+state/products.reducer.spec.ts'] },
    'test:cart': { extends: '.jest', script: ['npx nx run cart:test'] },
    'jest:bitwarden_license/bit-common/jest.config.js': { extends: '.jest', script: ['npx jest --config "$CI_PROJECT_DIR"/bitwarden_license/bit-common/jest.config.js'] },
  });
});

test('gitlab: an empty selection still yields a valid pipeline', () => {
  const parsed = YAML.parse(formatGitlabPipeline(report([{ project: 'ui', run: 'none' }])));
  assert.deepEqual(Object.keys(parsed), ['jest-impact:nothing-to-run']);
});
