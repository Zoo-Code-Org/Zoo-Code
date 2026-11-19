------------------------- MODULE CustomToolCache -------------------------
(*
Source: CustomToolRegistry.import calls runEsbuild. Sink: import(bundle.mjs).
Failure: A reader sees a bundle before the write and mode checks finish.
Invariant: Each visible bundle is complete, private, and checked.
Failure: A failed writer leaves a pending file. Invariant: Failed writers clean up.
Expectation: Direct publication fails. Private staging passes. No new bug expected.
The review was read before this spec. The first-invariant blind step was missed.
Cost: One agent, about 6 minutes for the model and checks; no delegate.
TLC: Direct config fails VisibleIsReady at Start (2 states). Fixed config
passes both invariants (49 distinct states, depth 11). Each run took under 1s.
Replay: The four-case publication property fails 3 cases on the old code.
The fixed code passes all 53 focused tests. Type and lint checks pass.
Property: No bundle is visible before its mode check. Failed builds leave
no pending file. Tests cover success, compiler, validation, and rename errors.
Findings: The known review bug is present. No new bug or false alarm found.
The model does not prove the code. Stop can leave an unpublished temp file.
Gate: Run both configs and the publication table test by hand on each fix.
Sandbox note: TLC needs a local RMI socket. Host tests avoid mapped root uid.
Review ratchet: PR #2485 threads PRRT_kwDOSK-bwM64vzgN (ownership test),
PRRT_kwDOSK-bwM64vzgR (defaults), PRRT_kwDOSK-bwM64vzgV (publication).
Added: 1 (publication). Gap: 2 (test routing and path defaults). Covered: 0.
The gaps use direct table tests. This model checks write order only.
The compiler and file checks are oracles. Two writers use distinct pending names.
A reader can run after each step. Stop leaves the last file state on disk.
*)
EXTENDS Naturals, TLC
CONSTANT AtomicPublish
VARIABLES phase, published, pending
vars == <<phase, published, pending>>
Writers == {1, 2}
Init == /\ phase = [w \in Writers |-> "idle"]
        /\ published = "absent"
        /\ pending = {}
Start(w) == /\ phase[w] = "idle"
            /\ phase' = [phase EXCEPT ![w] = "writing"]
            /\ pending' = pending \cup {w}
            /\ published' = IF AtomicPublish THEN published ELSE "partial"
Finish(w) == /\ phase[w] = "writing"
             /\ phase' = [phase EXCEPT ![w] = "complete"]
             /\ published' = IF AtomicPublish THEN published ELSE "readable"
             /\ UNCHANGED pending
Restrict(w) == /\ phase[w] = "complete"
               /\ phase' = [phase EXCEPT ![w] = "private"]
               /\ UNCHANGED <<published, pending>>
Check(w) == /\ phase[w] = "private"
            /\ phase' = [phase EXCEPT ![w] = "checked"]
            /\ UNCHANGED <<published, pending>>
Publish(w) == /\ phase[w] = "checked"
              /\ phase' = [phase EXCEPT ![w] = "done"]
              /\ published' = "ready"
              /\ pending' = pending \ {w}
Fail(w) == /\ phase[w] \in {"writing", "complete", "private", "checked"}
           /\ phase' = [phase EXCEPT ![w] = "failed"]
           /\ pending' = pending \ {w}
           /\ UNCHANGED published
Next == \E w \in Writers : Start(w) \/ Finish(w) \/ Restrict(w) \/ Check(w) \/ Publish(w) \/ Fail(w)
Spec == Init /\ [][Next]_vars
VisibleIsReady == published \in {"absent", "ready"}
FailedIsClean == \A w \in Writers : phase[w] = "failed" => w \notin pending
=============================================================================
