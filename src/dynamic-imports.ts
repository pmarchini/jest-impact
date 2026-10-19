import { execFileSync } from 'node:child_process';

// `import(x)` used as an expression: after an operator, `return`, `await` or an
// opening bracket, so method definitions named `import` do not match.
const DYNAMIC_IMPORT = /(?:[=(,:?&|![{]|=>|\breturn|\bawait)\s*import\(\s*([^)]*)/g;
const LITERAL = /^(['"])[^'"]*\1\s*(,|$)|^`[^`$]*`\s*(,|$)/;

/**
 * Files with an `import()` whose argument is not a string literal. sovra reports
 * a non-literal `require()`, but not this, so it is found here.
 */
export function findDynamicImports(workspaceRoot: string): string[] {
  let output = '';
  try {
    output = execFileSync('git', ['grep', '-n', '-I', '--untracked', '-e', 'import(', '--', '*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.jsx', '*.mjs', '*.cjs', ':!*.d.ts', ':!**/node_modules/**'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    });
  } catch {
    return []; // git grep exits 1 when nothing matches
  }
  const files = new Set<string>();
  for (const line of output.split('\n')) {
    const match = /^(.+?):\d+:(.*)$/.exec(line);
    if (!match) continue;
    for (const call of match[2]!.matchAll(DYNAMIC_IMPORT)) {
      if (!LITERAL.test(call[1]!.trim())) files.add(match[1]!);
    }
  }
  return [...files].sort();
}
