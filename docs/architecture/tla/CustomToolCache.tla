------------------------- MODULE CustomToolCache -------------------------
(* Sources: CustomToolRegistry.import/runEsbuild and RegistryOptions.cacheDir.
Sinks: import(bundle.mjs), the lstatSync test double, and clearCache. *)
(* VisibleIsReady: Readers see only complete, private, checked bundles.
FailedIsClean: Failed writers leave no pending file. *)
(* OwnershipMockReachesRoot: The ownership double matches the resolved cache root.
CleanupSelectsRoot: Cleanup selects the configured root for each input path. *)
(* UnsafeRootIsUntouched: Cleanup preserves roots that fail validation.
Compiler, path results, and filesystem checks are oracles. MC sets the bounds. *)
(* Expectation: Each faulty variant fails its invariant. Fixed variants pass.
The reviews preceded the new invariants. The blind step was missed. *)
(* Findings: Replays confirm the reported bugs. No new bug or false alarm found.
The model does not prove the code. A stopped process can leave a pending file. *)
(* TLC: Fixed passes all five invariants (49 states, depth 11).
Direct fails VisibleIsReady after Start (2 states). RawPath fails at the start. *)
(* MixedPath fails CleanupSelectsRoot. NoCleanupGuard fails UnsafeRootIsUntouched.
Latest runs took under 1s each. Round 3 runs took 27 to 42s. *)
(* Replay: Old publication fails 3 of 4 cases. Raw ownership matching fails aliases.
Old cleanup fails 4 of 7 cases. Guard sabotage deletes all 3 unsafe sentinels. *)
(* Validation: Fixed code passes 40 integration and 21 unit tests.
Both type checks and focused lint pass. Suppression counts do not increase. *)
(* Review ratchet, PR #2485: Added 4, covered 0, gap 4 across four rounds.
Gaps cover test routing, defaults, module placement, and PR metadata. *)
(* Round 1: Threads PRRT_kwDOSK-bwM64vzgN, PRRT_kwDOSK-bwM64vzgR, PRRT_kwDOSK-bwM64vzgV. Added 1, gap 2.
Publication became an invariant. Test routing and defaults use direct tests. *)
(* Round 2: Thread PRRT_kwDOSK-bwM64vzgN, reply 4622881580. Added 1.
Canonical ownership matching became an invariant. *)
(* Round 3: Thread PRRT_kwDOSK-bwM65T3Dd, comment 4623919335. Gap 1.
Writer bounds moved to MC. A state invariant cannot check module placement. *)
(* Round 4: Review 5968844313. Added 2, gap 1.
Cleanup gained two invariants. PR metadata is outside the model. *)
(* Cost: One agent, no delegates. Rounds 1/2/3/4 took about 6/3/4/6 minutes.
Header cleanup took about 2 minutes. These are work estimates. *)
(* Gate: Run all five configs against CustomToolCacheMC and the property tables.
Use -metadir outside the repo. TLC needs a local socket. Run file tests on the host. *)
EXTENDS Naturals, TLC
CONSTANTS AtomicPublish, CanonicalMatch, Writers, NormalizeCache, GuardCleanup, CleanupCases
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
(* Path results are input oracles. The model does not copy Node path parsing. *)
CleanupTarget(c) == IF NormalizeCache THEN c.normalizedTarget ELSE c.mixedTarget
CleanupSelectsRoot == \A c \in CleanupCases : CleanupTarget(c) = c.root
MayClear(safe) == IF GuardCleanup THEN safe ELSE TRUE
UnsafeRootIsUntouched == \A safe \in BOOLEAN : ~safe => ~MayClear(safe)
=============================================================================
