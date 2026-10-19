import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diffLockGraphs } from '../src/lockfile/graph.ts';
import { parseLockfile } from '../src/lockfile/parsers.ts';

const berry = (zoneVersion: string) => `__metadata:
  version: 8

"app@workspace:.":
  version: 0.0.0-use.local
  resolution: "app@workspace:."
  dependencies:
    react: "npm:18.3.1"
  languageName: unknown
  linkType: soft

"react@npm:18.3.1":
  version: 18.3.1
  resolution: "react@npm:18.3.1"
  dependencies:
    loose-envify: "npm:^1.1.0"
  checksum: abc
  languageName: node
  linkType: hard

"loose-envify@npm:^1.1.0":
  version: ${zoneVersion}
  resolution: "loose-envify@npm:${zoneVersion}"
  checksum: ${zoneVersion}
  languageName: node
  linkType: hard
`;

describe('lockfile diff', () => {
  it('maps a transitive change in a yarn berry lockfile to the direct dependency above it', () => {
    const base = parseLockfile('yarn.lock', berry('1.4.0'), []).graph;
    const head = parseLockfile('yarn.lock', berry('1.4.1'), []).graph;
    const diff = diffLockGraphs(base, head);
    // react's entry now points at a different loose-envify, so it counts as changed too.
    assert.deepEqual(diff.changedPackages, ['loose-envify', 'react']);
    assert.deepEqual(diff.affectedDirectDependencies, ['react']);
  });

  it('reports nothing when the lockfile is unchanged', () => {
    const graph = parseLockfile('yarn.lock', berry('1.4.0'), []).graph;
    assert.deepEqual(diffLockGraphs(graph, graph), { changedPackages: [], affectedDirectDependencies: [] });
  });

  it('resolves nested npm lockfile locations the way Node does', () => {
    const lock = (version: string) =>
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { a: '^1.0.0' } },
          'node_modules/a': { version: '1.0.0', integrity: 'a', dependencies: { b: '^2.0.0' } },
          'node_modules/b': { version: '1.0.0', integrity: 'b1' },
          'node_modules/a/node_modules/b': { version, integrity: `b${version}` },
        },
      });
    const diff = diffLockGraphs(parseLockfile('package-lock.json', lock('2.0.0'), []).graph, parseLockfile('package-lock.json', lock('2.0.1'), []).graph);
    assert.deepEqual(diff.affectedDirectDependencies, ['a']);
  });

  it('reads the dependency document of a multi-document pnpm 10 lockfile', () => {
    const lock = (version: string) => `---
lockfileVersion: '9.0'
importers:
  .:
    packageManagerDependencies:
      pnpm: {specifier: 10.0.0, version: 10.0.0}
---
lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      chalk: {specifier: ^5.0.0, version: 5.0.0}
packages:
  chalk@5.0.0:
    resolution: {integrity: c}
  ansi@${version}:
    resolution: {integrity: ansi${version}}
snapshots:
  chalk@5.0.0:
    dependencies:
      ansi: ${version}
  ansi@${version}: {}
`;
    const diff = diffLockGraphs(parseLockfile('pnpm-lock.yaml', lock('1.0.0'), []).graph, parseLockfile('pnpm-lock.yaml', lock('1.0.1'), []).graph);
    assert.deepEqual(diff.changedPackages, ['ansi', 'chalk']);
    assert.deepEqual(diff.affectedDirectDependencies, ['chalk']);
  });
});
