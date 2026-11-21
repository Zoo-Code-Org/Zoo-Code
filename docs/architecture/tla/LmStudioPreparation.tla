---- MODULE LmStudioPreparation ----
\* Source: forceFullModelDetailsLoad calls flushModels after a load in fetchers/lmstudio.ts.
\* Sink: flushModels in modelCache.ts must fetch a catalog from after the load.
\* Sources: getLMStudioModels preview failures and performPreparationTasks in ClineProvider.ts.
\* Sinks: committed metadata, the owned controller signal and the task controller slot.
\* Failure: a post-load refresh joins a pre-load flight and returns stale context.
\* Failure: a failed preview clears metadata, or cleanup clears another operation's controller.
\* Expect: Code holds. JoinOld, PreviewClear, NoAbort and ClearReplacement must fail.
\* Review: PR 2170 summary supplied in chat. 0 covered, 3 added, 6 gap.
\* Added: findings 4, 5 and 6. One invariant covers both parts of controller cleanup.
\* Gaps: 1 needs file-path data absent from REST. 2 needs discovery before and after a load.
\* Gaps: 3 retry timing, 7 log levels, 8 warning frequency and 9 prose need tests or review.
\* Not modeled: shared-flight cancellation and refresh tickets. LmStudioLoad models those rules.
\* The old request's result is an oracle. Both loaded and stale context are valid responses.
\* Replay tests: modelCache.spec.ts, lmstudio.test.ts and ClineProvider.spec.ts.
\* Result: Code holds in 16 states. All four sabotage configs fail their target invariants.
\* Replay: all four mutations fail the focused runtime tests. No new failure or false alarm was found.
\* Cost: each TLC run takes less than 1 second. Agent work takes about 10 minutes.
\* Simplification: one phase orders the boundaries. Input oracles replace HTTP and task setup.
EXTENDS Naturals
CONSTANT Mode
VARIABLES phase, oldVersion, returned, metadata, replaced, slot, aborted
vars == <<phase, oldVersion, returned, metadata, replaced, slot, aborted>>

Init == /\ phase = "load" /\ oldVersion \in {0, 1}
        /\ returned = 0 /\ metadata = TRUE /\ replaced \in BOOLEAN
        /\ slot = IF replaced THEN "replacement" ELSE "owned"
        /\ aborted = FALSE

\* The server load has finished. A new request sees version 1.
Refresh == /\ phase = "load"
           /\ returned' = IF Mode = "JoinOld" THEN oldVersion ELSE 1
           /\ phase' = "preview"
           /\ UNCHANGED <<oldVersion, metadata, replaced, slot, aborted>>

\* A failed settings preview cannot change committed runtime metadata.
Preview == /\ phase = "preview"
           /\ metadata' = (Mode # "PreviewClear")
           /\ phase' = "cleanup"
           /\ UNCHANGED <<oldVersion, returned, replaced, slot, aborted>>

Cleanup == /\ phase = "cleanup"
           /\ aborted' = (Mode # "NoAbort")
           /\ slot' = IF replaced /\ Mode # "ClearReplacement" THEN "replacement" ELSE "empty"
           /\ phase' = "done"
           /\ UNCHANGED <<oldVersion, returned, metadata, replaced>>
Next == Refresh \/ Preview \/ Cleanup
Spec == Init /\ [][Next]_vars
PostLoadFresh == phase # "load" => returned = 1
PreviewPreserves == metadata
OwnedCleanup == phase = "done" => aborted /\ slot = (IF replaced THEN "replacement" ELSE "empty")
====
