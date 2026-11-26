# Local test runs

Local Vitest runs start one fork worker per CPU. Local `pnpm test` also lets
Turbo run up to ten package test tasks at the same time. A small development
container runs out of memory under that load. The kernel kills a worker
process, the test run fails, and Zoo disconnects. Issue #2720 tracks this
problem. CI does not have this problem because CI already caps workers and
Turbo lanes.

Use the commands in this document for local and Docker test runs. CI worker
limits, test lanes, coverage behavior, and cache validation stay unchanged.

## Full local suite

```sh
pnpm test:local
```

`test:local` bundles the extension assets first and then runs the workspace
test tasks with a memory-safe limit: four Vitest workers per package and two
concurrent Turbo tasks. The bundle step is not optional. The extension dist
smoke test reads `src/dist`, and a concurrent bundle can wipe that directory
while the suite reads it.

Pass extra arguments through to Turbo when needed:

```sh
pnpm test:local -- --force
```

On a container with less than 8 GB of memory, or when you keep heavy tools
open during test runs, lower the limits:

```sh
pnpm test:local -- --vitest-workers=2 --turbo-concurrency=1
```

The default is four Vitest workers per package and two concurrent Turbo
tasks. The measured full run shows that Turbo concurrency saves more memory
than the worker count. Raise the worker count only when a single package
suite is your bottleneck.

The same limits work as plain environment variables when you call Vitest or
Turbo directly:

```sh
VITEST_MAX_WORKERS=4 pnpm --dir src exec vitest run
VITEST_MAX_WORKERS=4 pnpm exec turbo run test --concurrency=2
```

CI ignores `VITEST_MAX_WORKERS`. CI keeps its own worker limits: four webview
workers, two extension workers per lane on Windows, and two Turbo lanes.

## Focused tests

Run Vitest from the package directory that declares it.

Extension suite, one file:

```sh
cd src
pnpm exec vitest run core/webview/extension-message-handler.spec.ts
```

Extension suite, one lane:

```sh
pnpm --dir src run test:api
pnpm --dir src run test:core
pnpm --dir src run test:services
pnpm --dir src run test:misc
pnpm --dir src run test:tree-sitter
pnpm --dir src run test:workflow
```

Webview suite:

```sh
cd webview-ui
pnpm exec vitest run src/components/__tests__/some-component.spec.tsx
```

Core package:

```sh
pnpm --dir packages/core run test:unit
pnpm --dir packages/core run test:integration
```

Other packages:

```sh
pnpm --dir packages/types test
pnpm --dir packages/cloud test
pnpm --dir packages/telemetry test
pnpm --dir packages/vscode-shim test
pnpm --dir apps/cli test
```

## Benchmarks

The limits above come from benchmarks on the same test inventory. Numbers
come from issue #2720 work on a Linux container with 18 vCPUs. Ratios matter
more than absolute seconds. Your machine will differ.

Extension suite, 621 files and 20,189 tests, fork pool:

| Configuration              | Elapsed | Peak memory | Result     |
| -------------------------- | ------- | ----------- | ---------- |
| Default workers (17 forks) | 135 s   | 5.2 GB      | Pass       |
| 2 workers                  | 301 s   | 1.9 GB      | Pass       |
| 4 workers                  | 195 s   | 2.3 GB      | Pass       |
| 4 workers, threads pool    | 216 s   | 2.1 GB      | 5 failures |

Four workers keep the extension suite under 2.4 GB and finish about 35
percent faster than two workers. The threads pool failed five glob and
gitignore tests and was slower, so the fork pool stays.

Full workspace run, `test:local` bundles first and then runs `turbo run test`:

| Configuration                        | Elapsed | Peak memory | Result          |
| ------------------------------------ | ------- | ----------- | --------------- |
| `turbo run test`, default tasks (10) | 241 s   | 15.2 GB     | 2 load failures |
| `test:local` defaults, forced rerun  | 266 s   | 10.3 GB     | Pass            |
| 2 workers, 2 tasks, forced rerun     | 277 s   | 9.2 GB      | Pass            |

Turbo concurrency 2 costs almost no time and removes the load failures. The
remaining peak comes from the bundle and build steps, so lowering the worker
count saves little on a full run. Use the lower limits only on small
containers. The default concurrency changed test behavior under load, so the
bounded setting is the documented local configuration.

One pre-existing flake surfaced under full-suite load: the first tests in
`src/__tests__/extension.spec.ts` re-evaluate the extension module graph and
could cross the 20 second test timeout before `activate()` started. The tests
now carry a larger per-test budget for that module evaluation and scope their
call assertions to their own activation contexts.

## CI behavior

The local limit rides on the `VITEST_MAX_WORKERS` environment variable. CI
never sets it, and CI worker limits stay in place:

- `src/vitest.config.ts`: two workers on Windows CI, unchanged otherwise.
- `webview-ui/vitest.config.ts`: four workers in CI, unchanged otherwise.
- CI extension lanes run with `--concurrency=2`, coverage lanes and cache
  validation unchanged.
- Test isolation stays enabled. No config sets `isolate: false` and
  `test:local` never disables it.
