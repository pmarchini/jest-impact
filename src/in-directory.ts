/** Runs `run` with `dir` as the process cwd, restoring the previous cwd afterwards. Not safe to overlap. */
export async function inDirectory<T>(dir: string, run: () => T | Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await run();
  } finally {
    process.chdir(previous);
  }
}
