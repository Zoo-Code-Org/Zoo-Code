# Task cleanup protocol model check

Zoo Code checks the in-memory task cleanup protocol with a bounded explicit-state explorer. It runs under the umbrella command:

```sh
pnpm lifecycle:model-check
```

For focused debugging, run:

```sh
pnpm cleanup-protocol:model-check
```

This is a separate child model from the persisted task lifecycle and shared-store concurrency models. It follows the native tool-call parser model pattern: keep an independent bounded state space for an independent protocol, require every action and semantic landmark to remain reachable, and connect the abstract claims to focused production tests.

## Bounds and environment actions

The model uses two tasks and explores every reachable interleaving through depth 20, with an explicit 50,000-state budget. Abort, disposal, final-save, provider-drain, and shutdown-cursor state are modeled directly. Cleanup and editor-reversion settlement or rejection are environment actions, so the explorer does not assume they eventually occur.

The model checks these finite safety properties:

1. repeated abort and disposal calls reuse their first logical handle and start each operation at most once;
2. final message persistence, or the history-task save skip, cannot occur before editor reversion settles or rejects;
3. abort may complete while ancillary output cleanup remains pending;
4. disposal completes only after cleanup and reversion both settle or reject;
5. provider shutdown advances through tasks only after each task's abort and disposal reach terminal states;
6. shutdown advances through tasks in registry order and is complete exactly when every modeled task is drained; and
7. abort, ancillary cleanup, or disposal-start rejection is isolated so shutdown can continue to later tasks.

Named landmarks require abort completion during pending ancillary cleanup, contained cleanup rejection, final-save attempt after rejected reversion, a history-task final-save skip, two-task shutdown completion, and shutdown continuation after rejected abort, ancillary cleanup, or disposal start.

These are bounded safety and reachability claims only. The model does not claim filesystem or editor Promise liveness, fairness, timing bounds, arbitrary task counts, or that cleanup can never remain pending. Deterministic Vitest coverage in `Task.dispose.test.ts`, `Task.spec.ts`, and `ClineProvider.spec.ts` exercises the corresponding production Promise identities, ordering, rejection handling, and multi-task shutdown behavior.
