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
\* Result: RunStateKernelMC.cfg holds (5160 states). Each of the 11 other configs fails, 10 of them on the expected invariant.
\* NoStreamPhaseGuard fails AcceptCurrent first. CompletedNoStream alone also fails on it, so it is not vacuous.
\* Null result: the Kernel config found no new bug in the table.
\* Run each config on RunStateKernelMC.tla. The MC module holds the sabotage overrides of the named guards and effects.
\* Review ratchet, PR 2244, round 1 (findings before this spec):
\* covered: CodeRabbit 4498864158 (a stale settle must come from a replaced ask). Settle(k) needs k open, so a stale settle is a replaced ask.
\* added: taltas 4499201597 (a reused askTs). The Reuse config shows a stale settle that hides the newest ask (issue 2365).
\* gap: taltas 4499201605 (a result with both ok and rejected). The result shape is TypeScript, and the spec has no result.
\* gap: taltas 4499201579 (cross-region effects). The spec writes each action, so it cannot see an effect that the code adds.
\* gap: CodeRabbit 4519561241 (no negative test for source pairs). TLC tries every order, so the spec needs no pair rule.
\* The TS checker got the test instead: the settle-ignored-after-dispose unsafe kernel.
\* Round 1 counts: covered 1, added 1, gap 3. Findings about the spec files: 0.
\* Round 2 (CodeRabbit on 0c808b53a): 7 findings. 1 is about the spec files: 4633780176 (move the sabotage to an MC module). Done.
\* gap: 4633780180, 4633780186, 4633780209 and 4633780232 are about the coverage and the traces of the TS explorer.
\* gap: 4633780197 (an own property with an undefined value). The spec has no JavaScript objects.
\* gap: 4633780165 (a stale count in task-lifecycle-model.md). It is prose.
\* Round 2 counts: covered 0, added 0, gap 6. Findings about the spec files: 1.
\* Round 3, PR 2244: https://github.com/Zoo-Code-Org/Zoo-Code/pull/2244#discussion_r4498864158
\* covered: NewestShown still requires an open replaced ask. The TS checker now derives replacement from its BFS trace.
\* Replay: the old TS classification fails the settle-before-replacement property. The fixed classifier passes all 32 cases.
\* https://github.com/Zoo-Code-Org/Zoo-Code/pull/2244#discussion_r4633780176
\* gap: exploration limits were still in this module. This is a file-layout rule, not a state invariant.
\* MaxAsks, MaxGen, the timestamp domain and the bounded next action now live in RunStateKernelMC.
\* gap: the round 2 review summary loses source pairs on edges to visited states. The spec does not model the TS explorer.
\* The TS property replays ask/cancel in both orders, then starts a stream. It requires both incoming source pairs.
\* A sabotage that keeps one incoming source fails this property. The fixed code passes in both edge insertion orders.
\* Replay: the Reuse counterexample still clears the replacement in nextRunState. Issue 2365 owns that runtime fix.
\* Round 3 counts: covered 1, added 0, gap 2. Findings about the spec files: 1.
\* Expected before round 3: the same invariants and sabotage failures. No new runtime bug is expected.
\* Result: MCSpec holds (5160 states). All 11 variants fail with the same state counts as before. Null result: no new model bug.
\* The 32-case code property checks NewestShown with distinct timestamps. It also checks the coverage source and label.
\* Cost for round 3: TLC takes about 20 seconds for all 12 configs. Agent time is not measured.
\* Code check (step 10): scripts/check-run-state-kernel.ts runs the same invariants on the real nextRunState.
\* Cost: TLC takes under 10 seconds per config. Agent time is not measured.

EXTENDS Naturals

Reasons == {"user_cancelled", "streaming_failed"}
NoAsk == [id |-> 0, tag |-> "none", ts |-> 0]

\* ask.id, tsOf, open, n, fresh and done are ghost data. The kernel reads only ask.tag and ask.ts.
\* n: the asks that started. open: the asks that have not exited. fresh: the newest completion ask with no stream after it.
VARIABLES phase, gen, stream, ask, lastComp, abort, abandoned, disposed, reason, n, tsOf, open, fresh, done
vars == <<phase, gen, stream, ask, lastComp, abort, abandoned, disposed, reason, n, tsOf, open, fresh, done>>
ghosts == <<n, tsOf, open, fresh, done>>
AskTimestamps == {n + 1}
latches == <<abort, abandoned, disposed, reason>>

\* The guards and effects of the Transitions table. RunStateKernelMC.tla overrides one of them in each sabotage config.
\* Input rule: Task gives each ask a new askTs. Issue 2365 tracks that Task does not make sure of this.
AskTsFresh(t) == t = n + 1
InitializedLatches == UNCHANGED <<abort, abandoned, disposed>>
StreamStartGuard == phase = "running"
StreamEndGen == gen
AskStartGuard == phase = "running" /\ ~abort
SettleMatches(k) == ask.ts = tsOf[k]
AcceptGuard(k) == phase = "running" /\ ~abort /\ lastComp = tsOf[k]
AcceptAsk == NoAsk
ReasonGuard == reason = ""
AbandonGuard == abort
DisposeAbort == TRUE

Init == /\ phase = "uninitialized" /\ gen = 0 /\ stream = "none" /\ ask = NoAsk /\ lastComp = 0
        /\ abort = FALSE /\ abandoned = FALSE /\ disposed = FALSE /\ reason = ""
        /\ n = 0 /\ tsOf = [k \in {} |-> 0] /\ open = {} /\ fresh = 0 /\ done = 0

Initialized == /\ phase = "uninitialized" /\ phase' = "running"
               /\ InitializedLatches
               /\ UNCHANGED <<gen, stream, ask, lastComp, reason, ghosts>>

StreamStarted == /\ StreamStartGuard /\ stream = "none"
                 /\ gen' = gen + 1 /\ stream' = "live" /\ lastComp' = 0 /\ fresh' = 0
                 /\ UNCHANGED <<phase, ask, latches, n, tsOf, open, done>>

\* "clean" is a live stream with cleanupFinished true.
StreamCleanupFinished == /\ stream # "none" /\ stream' = "clean"
                         /\ UNCHANGED <<phase, gen, ask, lastComp, latches, ghosts>>

StreamEnded == /\ stream # "none" /\ stream' = "none" /\ gen' = StreamEndGen
               /\ UNCHANGED <<phase, ask, lastComp, latches, ghosts>>

\* Approval and other asks have the same effect, so the spec merges them.
AskStarted(tag, t) ==
    /\ AskStartGuard /\ AskTsFresh(t)
    /\ n' = n + 1 /\ tsOf' = [k \in 1..(n + 1) |-> IF k = n + 1 THEN t ELSE tsOf[k]] /\ open' = open \cup {n + 1}
    /\ ask' = [id |-> n + 1, tag |-> tag, ts |-> t]
    /\ lastComp' = IF tag = "completion" THEN t ELSE 0
    /\ fresh' = IF tag = "completion" THEN n + 1 ELSE 0
    /\ UNCHANGED <<phase, gen, stream, latches, done>>

\* Each started ask exits once: the abort throw, superseded or the return. Each exit sends askSettled.
AskSettled(k) == /\ k \in open
                 /\ open' = open \ {k}
                 /\ ask' = IF ask.tag # "none" /\ SettleMatches(k) THEN NoAsk ELSE ask
                 /\ UNCHANGED <<phase, gen, stream, lastComp, latches, n, tsOf, fresh, done>>

\* The accept carries the askTs of an ask that started. The guard decides if it is current.
CompletionAccepted(k) == /\ k \in 1..n /\ AcceptGuard(k)
                         /\ phase' = "completed" /\ done' = k /\ ask' = AcceptAsk
                         /\ UNCHANGED <<gen, stream, lastComp, latches, n, tsOf, open, fresh>>

ReasonSet(r) == /\ ReasonGuard /\ reason' = r
                /\ UNCHANGED <<phase, gen, stream, ask, lastComp, abort, abandoned, disposed, ghosts>>

AbortRequested(b) == /\ abort' = TRUE /\ abandoned' = (abandoned \/ b)
                     /\ UNCHANGED <<phase, gen, stream, ask, lastComp, disposed, reason, ghosts>>

AbandonRequested == /\ AbandonGuard /\ abandoned' = TRUE
                    /\ UNCHANGED <<phase, gen, stream, ask, lastComp, abort, disposed, reason, ghosts>>

DisposeRequested == /\ abort' = DisposeAbort /\ disposed' = TRUE
                    /\ UNCHANGED <<phase, gen, stream, ask, lastComp, abandoned, reason, ghosts>>

Next == \/ Initialized \/ StreamStarted \/ StreamCleanupFinished \/ StreamEnded
        \/ \E tag \in {"completion", "other"}, t \in AskTimestamps : AskStarted(tag, t)
        \/ \E k \in 1..n : AskSettled(k) \/ CompletionAccepted(k)
        \/ \E r \in Reasons : ReasonSet(r)
        \/ \E b \in BOOLEAN : AbortRequested(b)
        \/ AbandonRequested \/ DisposeRequested

Spec == Init /\ [][Next]_vars

TypeOK == /\ phase \in {"uninitialized", "running", "completed"} /\ gen \in Nat
          /\ stream \in {"none", "live", "clean"} /\ lastComp \in Nat
          /\ reason \in Reasons \cup {""} /\ n \in Nat /\ open \subseteq 1..n

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
