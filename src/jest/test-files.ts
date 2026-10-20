import { extname, sep } from 'node:path';
import micromatch from 'micromatch';
import type { JestProjectConfig } from './project-config.ts';

/**
 * Picks the test files of one Jest project out of the workspace's files, the
 * way Jest's own test search does: under a root, with a known extension,
 * matching testMatch or testRegex, and not ignored.
 */
export function selectTestFiles(config: JestProjectConfig, absoluteFiles: string[]): string[] {
  const extensions = new Set(config.moduleFileExtensions.map((e) => '.' + e));
  const ignore = [...config.testPathIgnorePatterns, ...config.modulePathIgnorePatterns].map((p) => new RegExp(p));
  const regexes = config.testRegex.map((p) => new RegExp(p));
  const matchesGlobs = globsMatcher(config.testMatch);
  const roots = config.roots.map((r) => (r.endsWith(sep) ? r : r + sep));

  return absoluteFiles.filter((file) => {
    if (!roots.some((root) => file.startsWith(root))) return false;
    if (!extensions.has(extname(file))) return false;
    if (ignore.some((re) => re.test(file))) return false;
    if (config.testMatch.length > 0) return matchesGlobs(file);
    return regexes.some((re) => re.test(file));
  });
}

/**
 * Jest's testMatch semantics (jest-util globsToMatcher): each glob in order
 * keeps the file when a positive glob matches it and drops it when a negated
 * glob does, and the last word wins. A negated glob only filters; it keeps
 * files on its own only when every glob is negated.
 */
function globsMatcher(globs: string[]): (file: string) => boolean {
  const matchers = globs.map((glob) => {
    const scan = micromatch.scan(glob);
    return { matches: micromatch.matcher(glob, { dot: true }), negated: scan.negated || Boolean(scan.negatedExtglob) };
  });
  const allNegated = matchers.every((m) => m.negated);
  return (file) => {
    let kept: boolean | undefined;
    for (const { matches, negated } of matchers) {
      const matched = matches(file);
      if (negated && !matched) kept = false;
      else if (!negated && matched) kept = true;
    }
    return allNegated ? kept !== false : kept === true;
  };
}
