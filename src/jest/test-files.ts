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
  const globs = config.testMatch.map((g) => micromatch.matcher(g, { dot: true }));
  const roots = config.roots.map((r) => (r.endsWith(sep) ? r : r + sep));

  return absoluteFiles.filter((file) => {
    if (!roots.some((root) => file.startsWith(root))) return false;
    if (!extensions.has(extname(file))) return false;
    if (ignore.some((re) => re.test(file))) return false;
    if (globs.length > 0) return globs.some((matches) => matches(file));
    return regexes.some((re) => re.test(file));
  });
}
