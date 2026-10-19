import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findDynamicImports } from '../src/dynamic-imports.ts';

test('finds import() calls with a non-literal argument only', () => {
  const root = mkdtempSync(join(tmpdir(), 'jest-impact-dyn-'));
  try {
    const files: Record<string, string> = {
      'variable.ts': 'export const load = (name: string) => import(name);\n',
      'template.ts': 'export const locale = (l: string) => import(`./locales/${l}`);\n',
      'literal.ts': "export const routes = [{ loadChildren: () => import('./a').then((m) => m.A) }];\n",
      'method.ts': 'export class Api {\n  async import(id: string) {\n    return id;\n  }\n}\n',
    };
    for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
    execFileSync('git', ['init', '-q'], { cwd: root });
    assert.deepEqual(findDynamicImports(root), ['template.ts', 'variable.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
