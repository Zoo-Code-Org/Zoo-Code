# Completion persistence model

`CompletionPersistence.als` models the narrow lifecycle behind the restart-persistence E2E failure:

- the streamed assistant history write starts;
- completion is accepted and `TaskCompleted` is emitted;
- the history write becomes durable;
- the extension host stops after observing completion.

The model compares two event contracts:

- `CurrentPolicy` permits `TaskCompleted` once completion is accepted and a history write has started;
- `DurableFirstPolicy` additionally requires the history write to be durable before completion is emitted.

The current-policy assertions search for a hypothesized, contract-permitted bad shape: the host sees completion and stops while API history is still not durable. Here, durable means that the required history version is visible to a fresh extension host; the model does not claim power-loss durability or filesystem `fsync` semantics. The durability-gated assertions check that completion and shutdown cannot expose that state.

The model is intentionally small. It establishes the missing ordering invariant but does not prove that the CI failure followed this exact trace or that every concrete runtime path maps to the abstract current-policy transition. Unrestricted stuttering also means this is a bounded safety model: it does not guarantee write completion, retries, or eventual task completion when persistence keeps failing.

## Code mapping

- `startHistoryWrite` and `finishHistoryWrite` represent `Task.saveApiConversationHistory()` entering and completing its durable file write.
- `acceptCompletion` and `emitCompletion` represent completion approval followed by `AttemptCompletionTool.emitPublicTaskCompleted()`.
- `stopHost` represents the restart E2E (or a real extension shutdown) acting on the public completion event.
- `DurableFirstPolicy` represents an implementation contract where the public completion boundary is not crossed until the required API history write succeeds.

## Run Alloy 6

Download the pinned Alloy release, verify it, and execute all commands:

```bash
cd .github/alloy
curl -fsSL https://github.com/AlloyTools/org.alloytools.alloy/releases/download/v6.2.0/org.alloytools.alloy.dist.jar -o alloy.jar
printf '%s  %s\n' '6b8c1cb5bc93bedfc7c61435c4e1ab6e688a242dc702a394628d9a9801edb78d' alloy.jar | sha256sum --check
java -jar alloy.jar exec -c '*' -t text -o - CompletionPersistence.als
```

Expected results:

- both `Current...` checks produce counterexamples where completion precedes durable history, including a trace that stops the host in that state;
- `DurableFirstHappyPath` is satisfiable, so the stronger guard does not prevent completion;
- both `DurableFirst...` assertions have no counterexample within the configured bounds.

The JAR is a local analysis tool and must not be committed.
