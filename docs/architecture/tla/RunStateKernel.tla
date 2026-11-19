---- MODULE RunStateKernel ----
\* Models nextRunState in src/core/task/run-state/runState.ts, as the Transitions table in task-lifecycle-target-architecture.md gives it.
\* Source: the events that Task and ClineProvider send. Sink: the run state that the getters read.
\* Failure 1: a task is abandoned or disposed without abort.
\* Failure 2: a latch or the first abort reason changes back.
\* Failure 3: an ask starts after abort.
\* Failure 4: a completed task starts a stream or keeps a pending ask.
\* Failure 5: the generation decreases.
\* Failure 6: a stale settle hides the newest ask while that ask still waits.
\* Failure 7: a late accept completes the task after a newer ask or stream.
\* Invariants: AbandonImpliesAbort, DisposeImpliesAbort, CompletedQuiet, PendingIsNewest, NewestShown, AcceptCurrent.
\* Properties: LatchesMonotone, NoAskAfterAbort, CompletedNoStream, GenerationMonotone.
\* A rejected event is a stutter, so the spec does not model it. The turn region has no guard and no reader here.
\* Expected before the run: Kernel holds. Each sabotage config fails the invariant of its failure. Reuse fails NewestShown.
\* Result: RunStateKernel.cfg holds (5160 states). Each of the 11 other configs fails, 10 of them on the expected invariant.
\* NoStreamPhaseGuard fails AcceptCurrent first. CompletedNoStream alone also fails on it, so it is not vacuous.
\* Null result: the Kernel config found no new bug in the table.
\* Review ratchet, PR 2244 (findings before this spec):
\* covered: CodeRabbit 4498864158 (a stale settle must come from a replaced ask). Settle(k) needs k open, so a stale settle is a replaced ask.
\* added: taltas 4499201597 (a reused askTs). Ts = "Reuse" shows a stale settle that hides the newest ask (issue 2365).
\* gap: taltas 4499201605 (a result with both ok and rejected). The result shape is TypeScript, and the spec has no result.
\* gap: taltas 4499201579 (cross-region effects). The spec writes each action, so it cannot see an effect that the code adds.
\* gap: CodeRabbit 4519561241 (no negative test for source pairs). TLC tries every order, so the spec needs no pair rule.
\* The TS checker got the test instead: the settle-ignored-after-dispose unsafe kernel.
\* Counts: covered 1, added 1, gap 3. Findings about the spec files: 0.
\* Code check (step 10): scripts/check-run-state-kernel.ts runs the same invariants on the real nextRunState.
\* Cost: TLC takes under 10 seconds per config. Agent time is not measured.

EXTENDS Naturals

CONSTANTS Mode, Ts, MaxAsks, MaxGen

Reasons == {"user_cancelled", "streaming_failed"}
AskIds == 1..MaxAsks
NoAsk == [id |-> 0, tag |-> "none", ts |-> 0]

\* ask.id, tsOf, open, n, fresh and done are ghost data. The kernel reads only ask.tag and ask.ts.
\* n: the asks that started. open: the asks that have not exited. fresh: the newest completion ask with no stream after it.
VARIABLES phase, gen, stream, ask, lastComp, abort, abandoned, disposed, reason, n, tsOf, open, fresh, done
vars == <<phase, gen, stream, ask, lastComp, abort, abandoned, disposed, reason, n, tsOf, open, fresh, done>>
ghosts == <<n, tsOf, open, fresh, done>>
latches == <<abort, abandoned, disposed, reason>>

Init == /\ phase = "uninitialized" /\ gen = 0 /\ stream = "none" /\ ask = NoAsk /\ lastComp = 0
        /\ abort = FALSE /\ abandoned = FALSE /\ disposed = FALSE /\ reason = ""
        /\ n = 0 /\ tsOf = [k \in AskIds |-> 0] /\ open = {} /\ fresh = 0 /\ done = 0

\* Sabotage ResumeResetsLatches: the first start clears the latches, as resumeAfterDelegation did before.
Initialized == /\ phase = "uninitialized"
               /\ phase' = "running"
               /\ IF Mode = "ResumeResetsLatches"
                  THEN abort' = FALSE /\ abandoned' = FALSE /\ disposed' = FALSE /\ UNCHANGED reason
                  ELSE UNCHANGED latches
               /\ UNCHANGED <<gen, stream, ask, lastComp, ghosts>>

StreamStarted == /\ phase = "running" \/ Mode = "NoStreamPhaseGuard"
                 /\ stream = "none" /\ gen < MaxGen
                 /\ gen' = gen + 1 /\ stream' = "live" /\ lastComp' = 0 /\ fresh' = 0
                 /\ UNCHANGED <<phase, ask, latches, n, tsOf, open, done>>

\* "clean" is a live stream with cleanupFinished true.
StreamCleanupFinished == /\ stream # "none" /\ stream' = "clean"
                         /\ UNCHANGED <<phase, gen, ask, lastComp, latches, ghosts>>

StreamEnded == /\ stream # "none" /\ stream' = "none"
               /\ gen' = IF Mode = "EndResetsGen" THEN 0 ELSE gen
               /\ UNCHANGED <<phase, ask, lastComp, latches, ghosts>>

\* Approval and other asks have the same effect, so the spec merges them.
\* Ts = "Unique": each ask gets a new askTs. Ts = "Reuse": an ask can carry the askTs of an earlier ask.
AskStarted(tag, t) ==
    /\ n < MaxAsks /\ phase = "running" /\ (~abort \/ Mode = "NoAskAbortGuard")
    /\ IF Ts = "Unique" THEN t = n + 1 ELSE TRUE
    /\ n' = n + 1 /\ tsOf' = [tsOf EXCEPT ![n + 1] = t] /\ open' = open \cup {n + 1}
    /\ ask' = [id |-> n + 1, tag |-> tag, ts |-> t]
    /\ lastComp' = IF tag = "completion" THEN t ELSE 0
    /\ fresh' = IF tag = "completion" THEN n + 1 ELSE 0
    /\ UNCHANGED <<phase, gen, stream, latches, done>>

\* Each started ask exits once: the abort throw, superseded or the return. Each exit sends askSettled.
AskSettled(k) == /\ k \in open
                 /\ open' = open \ {k}
                 /\ ask' = IF ask.tag # "none" /\ (ask.ts = tsOf[k] \/ Mode = "SettleAny") THEN NoAsk ELSE ask
                 /\ UNCHANGED <<phase, gen, stream, lastComp, latches, n, tsOf, fresh, done>>

\* The accept carries the askTs of an ask that started. The guard decides if it is current.
CompletionAccepted(k) ==
    /\ k \in 1..n /\ phase = "running" /\ ~abort
    /\ lastComp = tsOf[k] \/ Mode = "AcceptNoTs"
    /\ phase' = "completed" /\ done' = k
    /\ ask' = IF Mode = "AcceptKeepsAsk" THEN ask ELSE NoAsk
    /\ UNCHANGED <<gen, stream, lastComp, latches, n, tsOf, open, fresh>>

ReasonSet(r) == /\ reason = "" \/ Mode = "ReasonOverwrite"
                /\ reason' = r
                /\ UNCHANGED <<phase, gen, stream, ask, lastComp, abort, abandoned, disposed, ghosts>>

AbortRequested(b) == /\ abort' = TRUE /\ abandoned' = (abandoned \/ b)
                     /\ UNCHANGED <<phase, gen, stream, ask, lastComp, disposed, reason, ghosts>>

AbandonRequested == /\ abort \/ Mode = "AbandonNoGuard"
                    /\ abandoned' = TRUE
                    /\ UNCHANGED <<phase, gen, stream, ask, lastComp, abort, disposed, reason, ghosts>>

DisposeRequested == /\ abort' = (abort \/ Mode # "DisposeNoAbort") /\ disposed' = TRUE
                    /\ UNCHANGED <<phase, gen, stream, ask, lastComp, abandoned, reason, ghosts>>

Next == \/ Initialized \/ StreamStarted \/ StreamCleanupFinished \/ StreamEnded
        \/ \E tag \in {"completion", "other"}, t \in AskIds : AskStarted(tag, t)
        \/ \E k \in AskIds : AskSettled(k) \/ CompletionAccepted(k)
        \/ \E r \in Reasons : ReasonSet(r)
        \/ \E b \in BOOLEAN : AbortRequested(b)
        \/ AbandonRequested \/ DisposeRequested

Spec == Init /\ [][Next]_vars

TypeOK == /\ phase \in {"uninitialized", "running", "completed"} /\ gen \in 0..MaxGen
          /\ stream \in {"none", "live", "clean"} /\ lastComp \in 0..MaxAsks
          /\ reason \in Reasons \cup {""} /\ n \in 0..MaxAsks /\ open \subseteq 1..n

\* Design-doc invariants 1, 2, 5 and 7.
AbandonImpliesAbort == abandoned => abort
DisposeImpliesAbort == disposed => abort
CompletedQuiet == phase = "completed" => ask.tag = "none"
PendingIsNewest == ask.tag # "none" => ask.id = n
\* The newest ask still waits, so the view must show it (race R-6).
NewestShown == (n \in open /\ phase # "completed") => ask.id = n
\* PR-6: only an accept of the newest completion ask, with no stream after it, completes the task.
AcceptCurrent == phase = "completed" => (done # 0 /\ done = fresh)

\* Design-doc invariants 3, 4, 5 and 6. PR-3: the first reason wins.
LatchesMonotone == [][/\ abort => abort'
                      /\ abandoned => abandoned'
                      /\ disposed => disposed'
                      /\ reason # "" => reason' = reason]_vars
NoAskAfterAbort == [][n' > n => ~abort]_vars
CompletedNoStream == [][phase = "completed" => gen' = gen]_vars
GenerationMonotone == [][gen' >= gen]_vars

====
