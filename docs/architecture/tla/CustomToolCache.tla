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
Gate: Run all configs against CustomToolCacheMC and both property tables on each fix.
Sandbox note: TLC needs a local RMI socket. Host tests avoid mapped root uid.
Review ratchet: PR #2485 threads PRRT_kwDOSK-bwM64vzgN (ownership test),
PRRT_kwDOSK-bwM64vzgR (defaults), PRRT_kwDOSK-bwM64vzgV (publication).
Added: 1 (publication). Gap: 2 (test routing and path defaults). Covered: 0.
The original gaps use direct table tests.
Round 2: PR #2485, thread PRRT_kwDOSK-bwM64vzgN, reply 4622881580.
Failure: A raw path match misses the cache root after parent alias resolution.
Invariant: The ownership double matches the resolved root for each path.
Expectation: Raw matching fails for an alias. Canonical matching passes.
Added: 1. Covered: 0. Gap: 0. The compiler and path lookup remain oracles.
Round 2 cost: One agent, about 3 minutes; no delegate.
TLC: RawPath fails OwnershipMockReachesRoot. Direct fails VisibleIsReady.
Fixed passes all three invariants (49 states). Each run took under 1s.
Replay: The raw comparison passes the direct case and fails the alias case.
Findings: The known path mismatch is real. No new bug or false alarm found.
The path property checks both routes with the real filesystem and registry.
Round 2 validation: All 54 registry tests, type checking, and package lint pass.
The compiler and file checks are oracles. Two writers use distinct pending names.
A reader can run after each step. Stop leaves the last file state on disk.
Round 3: PR #2485, thread PRRT_kwDOSK-bwM65T3Dd, comment 4623919335.
Failure: The protocol fixes the writer count. The MC module must set the bound.
Expectation: Move the bound without changing the states or counterexamples.
Gap: 1. Added: 0. Covered: 0. A state invariant cannot check module placement.
The MC module supplies Writers. The protocol has no fixed writer count.
Round 3 cost: One agent, about 4 minutes; no delegate.
TLC: Fixed passes (49 states, depth 11). Direct fails VisibleIsReady (2 states).
RawPath fails OwnershipMockReachesRoot. Final runs took 27 to 42s.
Replay: Both existing property tables pass on the host (6 cases).
Findings: No new bug or false alarm. The model checks the same states.
Run: java -cp <jar> tlc2.TLC -metadir <tmp> -config <cfg> CustomToolCacheMC
*)
EXTENDS Naturals, TLC
CONSTANTS AtomicPublish, CanonicalMatch, Writers
VARIABLES phase, published, pending
vars == <<phase, published, pending>>
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
(* Source: configured cache path. Sink: lstatSync ownership test double. *)
CachePaths == {"cache", "alias/cache"}
Canonical(p) == IF p = "alias/cache" THEN "cache" ELSE p
MockTarget(p) == IF CanonicalMatch THEN Canonical(p) ELSE p
OwnershipMockReachesRoot == \A p \in CachePaths : MockTarget(p) = Canonical(p)
=============================================================================
