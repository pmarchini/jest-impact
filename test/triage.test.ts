import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSovraError, triage } from '../src/triage.ts';

const context = {
  workspacePackages: new Set(['@acme/ui']),
  npmPackages: new Set(['lodash', '@angular/core']),
  unmappedPatterns: [/\.svg$/],
};
const verdict = (raw: string) => triage(parseSovraError(raw), context).verdict;

const diagnostic = (message: string, code: string) =>
  `\n  x ${message}\n   ,-[src/a.spec.ts:6:1]\n 5 | import x from 'y';\n 6 | ${code}\n   : ^^^^^^^^^^\n   \`----\n`;

describe('triage', () => {
  it('ignores third-party packages that are not installed', () => {
    assert.equal(verdict("[src/a.ts]\nCannot find module '@angular/core/testing'"), 'ignore');
  });

  it('widens for unresolved local, workspace and unknown imports', () => {
    assert.equal(verdict("[src/a.ts]\nCannot find module './generated'"), 'uncertain');
    assert.equal(verdict("[src/a.ts]\nCannot find module '@acme/ui/button'"), 'uncertain');
    assert.equal(verdict("[src/a.ts]\nCannot find module 'left-pad'"), 'uncertain');
    assert.equal(verdict("[src/a.ts]\nCannot find module './logo.svg'"), 'uncertain');
  });

  it('accepts jest.mock with a factory but not a dynamic require', () => {
    assert.equal(verdict(diagnostic('Require call must have a single string literal argument', "jest.mock('./c', () => ({ c: 1 }));")), 'ignore');
    assert.equal(verdict(diagnostic('Require call must have a single string literal argument', 'const m = require(name);')), 'uncertain');
  });

  it('recognises a jest.mock factory that spans several lines', () => {
    const raw = `\n  x Require call must have a single string literal argument\n    ,-[src/a.spec.ts:6:1]\n  5 |     let m: jest.Mock;\n  6 | ,-> jest.mock("../flags", () => ({\n  7 | |     ...jest.requireActual("../flags"),\n  8 | \`-> }));\n    \`----\n`;
    assert.equal(verdict(raw), 'ignore');
  });

  it('keeps the file of a diagnostic', () => {
    const error = parseSovraError(diagnostic('Import call must not have dynamic template literals', 'import(`./x/${y}`);'));
    assert.equal(error.kind, 'dynamic');
    assert.equal(error.file, 'src/a.spec.ts');
  });
});
