# jest-impact (PoC)

Lists the Jest test files in each Nx project that the changes between two commits can affect, so CI can run only those. [sovra](https://github.com/oblador/sovra) walks the import graph; this package prepares its inputs and decides when to widen the run.

Anything the analyzer cannot reason about runs. A false negative (a skipped test that should have run) is the one failure it is designed to avoid.

## Usage

Run it in a checkout of the head commit, with git history back to the base.

```sh
npx jest-impact --base origin/main --head HEAD            # summary
npx jest-impact --base "$NX_BASE" --head "$NX_HEAD" --format nx   # one command per project
npx jest-impact --json report.json --out-dir test-lists   # full report and per-project lists
```

`--format nx` prints, for each project that needs to run:

```sh
npx nx run shared-product-state:test --runTestsByPath /repo/libs/shared/product/state/src/lib/+state/products.reducer.spec.ts
npx nx run cart:test        # the whole target, when the run had to widen
```

`--runTestsByPath` is required: Jest treats plain paths as regexes, and paths such as `+state/` silently match nothing.

`--format gitlab` prints a child pipeline with one job per project that needs to run (or a single no-op job when none does), for GitLab's dynamic child pipelines:

```yaml
plan-tests:
  stage: plan
  variables:
    GIT_DEPTH: 0
  script:
    - npx jest-impact --base "$CI_MERGE_REQUEST_DIFF_BASE_SHA" --head "$CI_COMMIT_SHA" --format gitlab --gitlab-include ci/jest-job.yml --gitlab-extends .jest > tests.yml
  artifacts:
    paths: [tests.yml]

run-tests:
  stage: test
  needs: [plan-tests]
  trigger:
    include:
      - artifact: tests.yml
        job: plan-tests
    strategy: depend
```

`--gitlab-include` adds `include: local` entries to the child pipeline, and `--gitlab-extends` makes every job extend a hidden job from them, for image, cache and tags.

The Node API is `analyze({ workspaceRoot, base, head })`, which returns the same report as `--json`.

## What happens in one run

1. **Config loader.** Finds Nx projects (`project.json`, workspace `package.json`, or `--nx-graph` output) and each project's `jest.config.*`. Configs are evaluated in-process: local files are transpiled with sucrase, installed packages are required for real, and missing ones are stubbed. Nx's own Jest preset has a built-in stand-in, so Nx repos load without an install. Test files are picked like Jest does (roots, testMatch/testRegex, ignore patterns, extensions).
2. **Workspace linker.** Symlinks every workspace package into the root `node_modules` (existing entries are left alone), so sovra resolves imports between packages.
3. **Resolver options.** One option set for the workspace: `tsconfig.base.json`, its `customConditions`, Jest's `customExportConditions`, `.js` to `.ts` extension aliases, built-in modules, and prefix-shaped `moduleNameMapper` entries as aliases.
4. **Change collector.** `git diff base head`, plus a base/head lockfile diff (npm 7+, yarn 1, yarn 2+, pnpm 6+). Every changed package, and every direct dependency with a changed package anywhere below it, becomes an `npm:` entry. Dependency-only edits to `package.json` files count the same way.
5. **Safety net and sovra.** Changed files are classified (below). Code changes, `npm:` entries and widened projects go to one `getAffected` call over all test files plus each project's setup files and other runtime inputs. sovra's errors are triaged; files with imports it cannot follow are added as changes in a second call, so every test reaching them runs.
6. **Output.** Tests grouped by Nx project and target, with the reason for every widening.

## When the run widens

| Situation | Result |
| --- | --- |
| `nx.json`, root tsconfig, root Jest config or preset, babel/swc config, `pnpm-workspace.yaml`, nx.json `sharedGlobals` files | Run everything |
| Root `package.json` changed beyond dependency ranges and metadata | Run everything |
| Lockfile changed and cannot be parsed | Run everything |
| A test-tooling package changed (`jest`, `ts-jest`, `@nx/jest`, `typescript`, ...) | Run everything |
| A project's Jest config, preset, config helper, `tsconfig*.json`, `project.json` or `.babelrc` changed | Run that project |
| A setup file, transform, environment or other runtime input imports a change | Run that project |
| A package the Jest config loads changed (transform, environment, preset) | Run that project |
| The config needs a package that is not installed, or uses a custom resolver not in `safeResolvers` | Run that project, on every run |
| A `__mocks__` file changed | Run that project |
| A non-code file changed inside a project (template, JSON, fixture) | Run that project, and treat its code as changed for importers elsewhere |
| A workspace `package.json` changed beyond dependencies | Same as a non-code file |
| Any `package.json` changed | Code that imports it runs (`require('../package.json').version`) |
| A Jest config that no Nx project contains | Reported as its own project, run with `jest --config` |
| A snapshot changed | Run the test it belongs to |
| sovra reports a non-literal `require`, an unresolved local or workspace import, or a non-prefix `moduleNameMapper` match; or a file has an `import()` with a non-literal argument | Every test that reaches that file runs, on every run |
| Unresolved third-party import (not installed) | Ignored: matched by name through `npm:` entries |
| `jest.mock('./x', factory)` | Ignored: the factory replaces the module |
| Docs, lint config, CI config (`ignoredFiles`) | Ignored |

## Settings

Optional `jest-impact.config.json` at the workspace root. Each list given replaces the default.

```json
{
  "safeResolvers": ["@nx/jest/plugins/resolver", "scripts/patched-jest-resolver.js"],
  "conditionNames": ["@nx/nx-source"],
  "trustedFiles": ["packages/nx/src/utils/handle-import.ts"],
  "globalFiles": ["nx.json", "tsconfig.base.json"],
  "ignoredFiles": ["**/*.md"],
  "runnerPackages": ["jest", "jest-*", "@jest/*", "ts-jest"]
}
```

`conditionNames` is for repos whose custom resolver adds export conditions that tsconfig does not declare. `trustedFiles` lists files whose dynamic imports a maintainer has checked; without it, every test reaching them always runs.

## Validation so far

- **nx-examples, test lists:** identical to `jest --listTests` for all 9 Jest projects, with and without `node_modules` installed.
- **nx-examples, impact:** each of the 15 test files was run alone under a file-read tracer to record what Jest actually loads. For 172 single-file changes, no test that loaded the changed file was missed. With codegen output present, 96 changes matched the runtime set exactly; the rest over-selected (type-only imports that ts-jest elides, and project-wide widenings for config files). Without codegen output, the unresolved `./generated` import in `shared-product-types` widens every run to the 10 tests that reach it, which is the safety net working as intended.
- **Replays:** 60 nx-examples commits and 40 nrwl/nx commits. Almost all of them run everything, correctly: they are Nx/Jest upgrades, or (in nrwl/nx) the remaining Jest suites are e2e tests whose global setup imports the Nx packages themselves. nrwl/nx also shows the cost of dynamic requires in tooling code. Analysis took 0.3 to 0.6 s per commit, or about 5 s when the pnpm lockfile changed.
- **bitwarden/clients fixture** (`fixtures/bitwarden`): 1,481 test files traced in one full Jest run, and 55 cases (37 real commits by category, 18 synthetic patches). All 55 pass with no missed test. Outside the 8 that correctly run everything, the analyzer selects 27.5% of tests on average where 16.4% loaded a changed file; 31 tests reach files sovra cannot follow and run on every change. About 0.9 s per case.
- **Nx output:** `nx run <project>:test --runTestsByPath <file>` ran exactly the listed suite through the inferred `@nx/jest/plugin` target.

## Known gaps

- File-level only: a barrel re-export means every importer of the barrel is affected.
- No explain path per test yet; reasons are reported per project and per widening.
- Lockfile parsing is not cached and dominates run time when the lockfile changes.
- No `moduleNameMapper` hook in sovra, so regex mappings fall back to widening.
- Not yet run on the private pilot repo.

## Development

```sh
npm install
npm test          # node:test, runs the TypeScript sources directly (Node 22.18+)
npm run typecheck
npm run build     # emits dist/ for the bin
```
