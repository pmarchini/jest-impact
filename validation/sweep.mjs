// Changes every file the trace saw, one at a time, and checks each selection.
//
//   node validation/sweep.mjs <fixture-dir> <workspace> <out.jsonl> [shard] [shards]
//
// For each workspace file some test loaded, the change set is just that file,
// modified, at the pinned commit. A test that loaded it and is not selected is
// a miss. Every file is a separate analyzer run, so this covers every import
// edge the suite exercises rather than a sample of them.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const { analyze } = await import(new URL('../src/analyze.ts', import.meta.url));
const [fixtureDir, workspace, outFile, shard = '0', shards = '1'] = process.argv.slice(2);
const fixture = JSON.parse(readFileSync(join(fixtureDir, 'fixture.json'), 'utf8'));
const loadedBy = new Map();
for (const line of gunzipSync(readFileSync(join(fixtureDir, fixture.trace))).toString('utf8').split('\n').filter(Boolean)) {
  const { test, files } = JSON.parse(line);
  for (const file of files) loadedBy.set(file, [...(loadedBy.get(file) ?? []), test]);
}
const files = [...loadedBy.keys()].sort().filter((_, i) => i % Number(shards) === Number(shard));
writeFileSync(outFile, '');
let done = 0;
for (const path of files) {
  const report = await analyze({
    workspaceRoot: workspace,
    base: fixture.commit,
    head: fixture.commit,
    link: false,
    changeSet: { files: [{ path, status: 'modified' }], manifests: [], npmPackages: [] },
  });
  const selected = new Set(report.projects.flatMap((p) => p.tests));
  const mustRun = loadedBy.get(path);
  const misses = mustRun.filter((t) => !selected.has(t));
  appendFileSync(outFile, JSON.stringify({ path, mustRun: mustRun.length, selected: selected.size, runAll: report.runAll.length > 0, misses }) + '\n');
  if (++done % 200 === 0) console.log(`${done}/${files.length}`);
}
console.log(`done ${files.length}`);
