# Native tool-call parser request-scope model check

Zoo Code checks native tool-call parser request isolation with a bounded, exhaustive replay model. It is a child submodel in the umbrella task lifecycle verification suite, which runs in CI and locally with:

```sh
pnpm lifecycle:model-check
```

For focused debugging, run this submodel directly with:

```sh
pnpm parser-scope:model-check
```

The command is composed into the same verification suite, but this remains a separate protocol and state space from the persisted task lifecycle model and shared-store concurrency model. It owns its parser-scoping invariants and adds no parser state to `HistoryItem` or `taskLifecycle.ts`; instead, it replays the public production `NativeToolCallParser` APIs using two independent scope objects.

## Bounds and replay

The source of truth is `scripts/check-native-tool-call-parser-scoping.ts`. The model has two request scopes, A and B. Both receive provider raw tool index zero, but each has a distinct tool-call ID and two distinct JSON argument fragments. Each scope follows this local order:

1. open the request scope;
2. start raw call index zero and its streaming accumulator;
3. add two distinct argument fragments through both production accumulation APIs;
4. finalize the raw call and reject duplicate raw finalization;
5. finalize the streaming call and reject duplicate streaming finalization; and
6. deliver late raw and streaming fragments.

The checker exhausts all 924 order-preserving interleavings of those two six-action sequences. Opening, raw start, fragment delivery, raw finalization, streaming finalization/cleanup, and late fragment delivery are independently schedulable protocol phases. Fragment delivery remains one bounded action per scope and replays both argument fragments through both production accumulation APIs; streaming cleanup remains attached to streaming finalization because late delivery is the only valid following local phase. This preserves each request's local order while keeping CI runtime bounded. The expected schedule count, maximum schedule budget, scope count, raw index, and actions per scope are explicit. It fails if schedule enumeration differs from the binomial bound or exceeds the budget, so truncated exploration cannot pass.

Each schedule uses fresh production scope objects and calls `processRawChunk`, `startStreamingToolCall`, `processStreamingChunk`, `finalizeRawChunks`, `finalizeStreamingToolCall`, `clearRawChunkState`, `clearAllStreamingToolCalls`, and `hasActiveStreamingToolCalls`. It neither inspects private parser maps nor duplicates their transition logic.

## Invariants and landmarks

Every replay checks:

1. emitted start, delta, and end events retain the owning scope's call ID;
2. finalized arguments contain only the owning scope's fragments;
3. cleanup in one scope cannot change the other scope's active streaming state;
4. each scope emits exactly one raw end and one streaming final result;
5. repeated finalization is empty/null rather than duplicate;
6. modeled late argument fragments — raw chunks carrying only arguments without an ID or name, and streaming chunks for already-finalized IDs — are ignored after finalization. A late raw chunk carrying a new ID and name can recreate scope state and emit a new start event; production safety relies on Task making finalization the last parser interaction for that request;
7. every modeled action is reachable.

Named landmarks require simultaneous active scopes, B opening while A has received its fragments, either scope raw-finalizing while the other remains active, either scope streaming-finalizing and cleaning up while the other remains active, and symmetric late-fragment schedules in which the other scope is still active.

These are finite safety claims only. The model does not claim provider transport ordering, retry liveness, fairness, persistence, or arbitrary call counts. Provider suites separately test their public stream contracts with two overlapping streams, while focused parser and Task tests cover production integration.
