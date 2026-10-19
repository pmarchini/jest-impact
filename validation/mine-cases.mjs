// Sorts a repo's recent first-parent commits into the case categories, so a
// real commit can be picked for each one.
//
//   node validation/mine-cases.mjs <workspace> <commit-count> <out.json>
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [workspace, count, outFile] = process.argv.slice(2);
const log = execFileSync(
  'git',
  ['log', '--first-parent', '--diff-merges=first-parent', '--no-renames', '--name-status', '--format=@%H%x09%s', `-${count}`],
  { cwd: workspace, encoding: 'utf8', maxBuffer: 1 << 30 },
);

const commits = [];
for (const block of log.split('\n@').map((b) => b.replace(/^@/, ''))) {
  const [header, ...lines] = block.split('\n').filter(Boolean);
  const [sha, subject] = header.split('\t');
  const files = lines.map((l) => { const [status, path] = l.split('\t'); return { status, path }; });
  commits.push({ sha, subject, files });
}

const isTest = (p) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(p);
const isCode = (p) => /\.[cm]?[jt]sx?$/.test(p) && !p.endsWith('.d.ts');
const isDoc = (p) => /\.(md|mdx)$/.test(p) || p.startsWith('.github/');
const CORE = /^libs\/(common|state|storage-core|logging|guid|platform|key-management)\//;

const categories = {
  'docs-only': (f) => f.every((x) => isDoc(x.path)),
  'test-only': (f) => f.every((x) => isTest(x.path)),
  'new-test-file': (f) => f.some((x) => x.status === 'A' && isTest(x.path)),
  'single-source-file': (f) => f.length === 1 && isCode(f[0].path) && !isTest(f[0].path),
  'source-and-spec': (f) => f.length <= 4 && f.some((x) => isTest(x.path)) && f.some((x) => isCode(x.path) && !isTest(x.path)),
  'core-lib-source': (f) => f.length <= 5 && f.every((x) => CORE.test(x.path) && isCode(x.path)) && f.some((x) => !isTest(x.path)),
  'app-only-source': (f) => f.length <= 5 && f.every((x) => /^apps\//.test(x.path) && isCode(x.path)),
  'license-only-source': (f) => f.length <= 5 && f.every((x) => /^bitwarden_license\//.test(x.path) && isCode(x.path)),
  'deleted-source': (f) => f.length <= 10 && f.some((x) => x.status === 'D' && isCode(x.path) && !isTest(x.path)),
  'snapshot': (f) => f.some((x) => x.path.endsWith('.snap')),
  'mocks-dir': (f) => f.some((x) => x.path.includes('/__mocks__/')),
  'project-jest-config': (f) => f.some((x) => /\/jest\.config\.[cm]?[jt]s$/.test(x.path)),
  'setup-file': (f) => f.some((x) => /test\.setup\.[cm]?[jt]s$/.test(x.path)),
  'project-tsconfig': (f) => f.some((x) => /\/tsconfig[^/]*\.json$/.test(x.path)),
  'global-config': (f) => f.some((x) => /^(tsconfig\.base\.json|nx\.json|jest\.config\.js|babel\.config\.json)$/.test(x.path)),
  'non-code-in-project': (f) => f.length <= 5 && f.some((x) => /^(libs|apps)\//.test(x.path) && /\.(html|json|scss|css)$/.test(x.path) && !/(tsconfig|package|project)[^/]*\.json$/.test(x.path) && !x.path.includes('/locales/')),
  'locales': (f) => f.every((x) => x.path.includes('/locales/')),
  'workspace-manifest': (f) => f.some((x) => /^(libs|apps)\/.+\/package\.json$/.test(x.path)),
  'lockfile-small': (f) => f.length <= 3 && f.some((x) => x.path === 'package-lock.json'),
  'lockfile-large': (f) => f.length > 3 && f.some((x) => x.path === 'package-lock.json'),
  'large-refactor': (f) => f.length >= 40 && f.every((x) => !['package-lock.json', 'tsconfig.base.json'].includes(x.path)),
};

const byCategory = Object.fromEntries(Object.keys(categories).map((k) => [k, []]));
for (const c of commits) {
  for (const [name, test] of Object.entries(categories)) {
    if (c.files.length && test(c.files)) byCategory[name].push({ sha: c.sha, subject: c.subject, files: c.files.length });
  }
}
writeFileSync(outFile, JSON.stringify(byCategory, null, 2) + '\n');
for (const [name, list] of Object.entries(byCategory)) console.log(name.padEnd(22), String(list.length).padStart(5), list[0] ? `${list[0].sha.slice(0, 9)} ${list[0].subject.slice(0, 60)}` : '');
