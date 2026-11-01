# Webview recovery model check

Run the bounded checker and its type check with:

```sh
pnpm webview-recovery:check-types
pnpm webview-recovery:model-check
```

Code QA runs both commands in its compile job. This is an independent webview protocol check, separate from the persisted task lifecycle models. It adds no task-status transitions.

## Production connection

`src/core/webview/webviewRecoveryPolicy.ts` owns pure decisions used by both `ClineProvider` and the checker. These include attempt admission, recovery-incident preservation, resolve-failure classification, HTML commit eligibility, release of an async recovery owner, command-failure marker cleanup, failure accounting, notification deduplication and terminal-stop logging, heartbeat health, explicit retry generations, and warning actions.

The provider still performs VS Code effects. It installs subscriptions, starts timers, assigns HTML, resolves views, and retains its task stack. The policy extraction does not move those effects into the model.

The checker combines two kinds of evidence:

- finite-state exploration calls production policy functions while modeling Promise settlements and host effects;
- exhaustive finite input tables check policy contracts, including both acceptance and rejection paths and the healthy-window/stale-gap boundaries.

This is production-policy-backed bounded verification, not a refinement proof of the complete provider. A missing production call, a misplaced effect, or incorrect VS Code behavior can escape the abstract model. Focused provider tests and Electron tests remain necessary.

## State spaces and bounds

The checker explores three independent state spaces to a fixed point. Each has a 100,000-state budget and a maximum discovery depth of 100. Discovering a new state beyond either bound fails the check; reaching the depth bound does not count as success. The printed state totals are diagnostics, not ratchets.

**Async ownership** models one pending HTML operation and one possible replacement operation. Visibility can change, a heartbeat or grace reset can invalidate the pending work, the epoch can change, and the provider can be disposed or replaced before the old operation settles. The completion records which condition held at settlement, rather than inferring event order from a later state. Old completion must not release a replacement operation's owner. An explicit retry can invalidate the old epoch while retaining the same view, and old host-command completion must respect generation ownership.

**Sidebar and tab hosts** model recovery attempts, HTML generation success/failure, host replacement, captured recovery intent, initialization success/failure, notification state, watchdog availability, and host-operation ownership. Sidebar actions additionally include removal/focus failures, publication before or after the replacement wait, and a wait expiring during initialization. Repeated failures consume a three-attempt budget. One ordinary manual reopen, one ambiguous reopen while a timeout marker is pending, one explicit user retry, and one sustained-health refill are permitted, so later incidents are reachable without an unbounded counter.

The graphs are checked separately. They do not establish every possible joint interleaving between ownership, host effects, and task execution. The host graph abstracts identities as original/missing/replacement; the ownership graph checks distinct old/replacement owners. Numeric health contracts check 59,999/60,000 and 90,000/90,001 millisecond boundaries. Timer scheduling itself is an environment assumption, not a model guarantee.

## Safety contracts and required witnesses

The checker rejects:

1. HTML committed to a disposed, replaced, hidden, epoch-invalidated, or heartbeat-invalidated view;
2. an old async completion releasing a newer recovery's ownership;
3. duplicate in-flight recovery or attempts exceeding the cap;
4. a recovery replacement resetting its incident budget or being classified as normal startup;
5. a current recovery resolve failure losing the retry disposition;
6. retryable warnings consuming the remaining attempts, duplicate notifications, missing terminal-stop reasons after retry warnings, or repeated terminal-stop logs without an incident reset;
7. a failed sidebar focus leaving a marker that contaminates a later manual reopen;
8. a startup heartbeat replenishing attempts before sustained health;
9. stale Reload Window or Retry Interface Recovery actions changing state after a heartbeat, disposal, or generation renewal; and
10. a late Show Logs action being incorrectly suppressed.

Required actions and semantic witnesses prevent a vacuous pass. They include a valid HTML commit, each invalidated completion class, a replacement owner surviving old completion, a retryable initialization failure, repeated initialization failures reaching the cap, healthy budget refill, a published sidebar timing out with attempts remaining, late publication retaining an exhausted budget, a fresh manual open after focus failure, one terminal-stop log after an earlier retry warning, preservation of the capped incident during ambiguous reopen, and a fresh budget after explicit retry.

Fifteen representative faulty policies are injected without editing source. Each must fail with its expected contract violation. Exploration truncation or an unrelated exception does not count as rejecting a regression.

## Effect and integration evidence

`src/core/webview/__tests__/ClineProvider.spec.ts` checks the corresponding real provider effects with fake timers. Relevant scenarios include:

- HTML and hydration rejection from VS Code-style independent sidebar resolution;
- successful retry while retaining an interrupted task;
- repeated failed sidebar and tab replacements stopping at the cap;
- late initialization failure after the sidebar replacement wait;
- disposal/replacement before an old resolve completes;
- recovery ownership clearing and a second incident remaining recoverable;
- failed focus followed by a normal manual open;
- explicit retry from a timed-out or ambiguously reopened sidebar, without evicting an interrupted task;
- old resolve, focus, and notification completion after generation renewal; and
- warning actions, heartbeat invalidation, and healthy-window boundaries.

These are integration checks of the handwritten effect layer, not generated trace conformance tests. The host model assumes that a retryable resolve failure installs a watchdog and that a completed host operation releases its busy flag; the provider tests verify those assumptions. The model's incident-preservation decision is used by the provider's budget reset and task-cleanup guards; the task registry itself is not modeled.

The Electron heartbeat project checks Command Palette retry after renderer termination, real sidebar recreation, isolated renderer termination, task-stack preservation, resumed periodic heartbeats, and hidden-sidebar retention. It does not deliberately make a real VS Code resolver reject. No model here proves renderer memory safety, eventual Promise settlement, OS sleep/resume ordering, arbitrary overlapping operations, or recovery liveness under an unfair or permanently failing environment.

When changing recovery behavior, update the production policy, model actions/contracts and required witnesses, and the narrowest provider test that checks its effects. Rerun Electron checks when a VS Code host or transport boundary changes.

## Why explicit user intent

The [pinned VS Code view API](https://github.com/microsoft/vscode/blob/1.100.0/src/vscode-dts/vscode.d.ts#L9567-L9616) supplies persisted state and a lifetime cancellation token, but no focus-request identifier or user-open origin. A timeout cannot establish which request caused a later callback. The implementation therefore retains the incident for ambiguous callbacks and uses an explicit command to authorize a new generation and retry budget. This follows the manual-reset approach described in [Microsoft's circuit-breaker guidance](https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker#problems-and-considerations), adapted to a local UI recovery budget.

The model does not infer callback provenance. It explicitly allows a manual reopen while the old marker is pending and requires that this alone cannot refresh the budget. Explicit retry is a separate environment action. Generation guards protect extension-side continuations; they do not cancel a VS Code command already issued to the host.
