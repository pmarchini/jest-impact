import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

const CODE_FILES = ['*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.jsx', '*.mjs', '*.cjs', ':!*.d.ts', ':!**/node_modules/**'];
const STRING_LITERAL = /'([^'\n]*)'|"([^"\n]*)"|`([^`$\n]*)`/g;

/**
 * Code files that name `file` in a string literal relative to themselves, such
 * as `templateUrl: './card.component.html'` or `require('../fixtures/user.json')`.
 * Those files are what reads a non-code file, so their importers are what it affects.
 */
export function findReferences(workspaceRoot: string, file: string): string[] {
  const name = posix.basename(file);
  let candidates: string[];
  try {
    candidates = execFileSync('git', ['grep', '-l', '-F', '-e', name, '--', ...CODE_FILES], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return []; // git grep exits 1 when nothing matches
  }
  return candidates.filter((candidate) => {
    const dir = posix.dirname(candidate);
    const content = readFileSync(join(workspaceRoot, candidate), 'utf8');
    for (const match of content.matchAll(STRING_LITERAL)) {
      const literal = match[1] ?? match[2] ?? match[3] ?? '';
      if (!literal.endsWith(name)) continue;
      const relativeToFile = literal.startsWith('.') || !literal.includes('/');
      if (relativeToFile && posix.normalize(posix.join(dir, literal)) === file) return true;
    }
    return false;
  });
}
