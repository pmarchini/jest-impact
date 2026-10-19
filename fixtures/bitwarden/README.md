# bitwarden fixture

[bitwarden/clients](https://github.com/bitwarden/clients) pinned at one commit (`fixture.json`): about 1,500 Jest test files in 59 Jest projects, most of them Nx projects importing each other through `@bitwarden/*` paths. Two kinds of cases run against it.

- **History cases** (`"commit"`): a real bitwarden commit, picked by `validation/mine-cases.mjs` for one category (core lib edit, setup file, lockfile bump, snapshot, ...). Its changed paths and its lockfile and manifest diff are replayed onto the pinned commit. Paths that no longer exist there are dropped.
- **Synthetic cases** (`"patch"`): a hand-written patch for a behaviour history has no example of (a `__mocks__` file, `import(variable)`, a version-only bump). The runner commits it on the pinned commit, analyzes that commit, and resets.

## Ground truth

`trace.jsonl.gz` records, for every test file, the workspace modules Jest executed, the non-code files it read and the npm packages it loaded, from one full Jest run at the pinned commit (`validation/trace-jest.cjs`). Files ts-jest reads only to type-check are not counted.

A test must be selected when it loaded a changed file or a changed package. Any such test left out fails the case, and so does any `expect` entry that does not hold: `runAll`, `wholeProjects`, `mustSelect`, `mustSkip`, `uncertain`, `maxAboveFloor`. The floor is what an empty change selects: tests reaching a file whose imports sovra cannot follow, which run on every change.

## Running

```sh
npm run cases:bitwarden            # clones into .cache/bitwarden on first use, then runs every case
node validation/run-cases.mjs fixtures/bitwarden .cache/bitwarden out.json synthetic   # a subset, by name
```

## Changing the fixture

- **New case:** add `cases/<name>.json`, and for a synthetic one the patch, made with `git diff HEAD --binary` in a checkout of the pinned commit.
- **New pinned commit:** update `fixture.json`, run `setup.sh`, regenerate the trace with `trace.sh` (a full Jest run, about 25 minutes on 4 cores), and fix any patch that no longer applies.
