------------------------- MODULE CustomToolCache -------------------------
(* Sources: CustomToolRegistry.import/runEsbuild and RegistryOptions.cacheDir.
Sinks: import(bundle.mjs), the lstatSync test double, and clearCache. *)
(* VisibleIsReady: Readers see only complete, private, checked bundles.
FailedIsClean: Failed writers leave no pending file. *)
(* OwnershipMockReachesRoot: The ownership double matches the resolved cache root.
CleanupSelectsRoot: Cleanup selects the configured root for each input path. *)
(* ProbeSeesRoot: The existence check uses the same normalized root as cleanup. *)
(* UnsafeRootIsUntouched: Cleanup preserves roots that fail validation.
Compiler, path results, and filesystem checks are oracles. MC sets the bounds. *)
(* Expectation: Each faulty variant fails its invariant. Fixed variants pass.
The reviews preceded the new invariants. The blind step was missed. *)
(* Findings: Replays confirm the reported bugs. No new bug or false alarm found.
The model does not prove the code. A stopped process can leave a pending file. *)
(* TLC: Fixed passes all eight invariants (49 states, depth 11).
Direct fails VisibleIsReady after Start (2 states). RawPath fails at the start. *)
(* MixedPath fails CleanupSelectsRoot. NoCleanupGuard fails UnsafeRootIsUntouched.
Latest runs took under 1s each. Round 3 runs took 27 to 42s. *)
(* Replay: Old publication fails 3 of 4 cases. Raw ownership matching fails aliases.
Old cleanup fails 4 of 7 cases. Guard sabotage deletes all 3 unsafe sentinels. *)
(* Round 6 validation: Fixed code passes 41 integration and 25 unit tests.
Both type checks and focused lint pass. Suppression counts do not increase. *)
(* Review ratchet, PR #2485: Added 13, covered 1, gap 12 across eight rounds.
Gaps cover test routing, defaults, module placement, and PR metadata. *)
(* Round 1: Threads PRRT_kwDOSK-bwM64vzgN, PRRT_kwDOSK-bwM64vzgR, PRRT_kwDOSK-bwM64vzgV. Added 1, gap 2.
Publication became an invariant. Test routing and defaults use direct tests. *)
(* Round 2: Thread PRRT_kwDOSK-bwM64vzgN, reply 4622881580. Added 1.
Canonical ownership matching became an invariant. *)
(* Round 3: Thread PRRT_kwDOSK-bwM65T3Dd, comment 4623919335. Gap 1.
Writer bounds moved to MC. A state invariant cannot check module placement. *)
(* Round 4: Review 5968844313. Added 2, gap 1.
Cleanup gained two invariants. PR metadata is outside the model. *)
(* Round 5: CodeRabbit review of 2026-11-21, outside-diff finding on clearCache. Added 1.
ProbeSeesRoot: the existsSync probe uses the normalized root. RawProbe fails it. *)
(* Round 6: Thread PRRT_kwDOSK-bwM66ZGcG. Added 1: ExplicitWindowsRootIsRejected.
SupportedRootsAreAccepted checks the accept path. ExplicitWindows fails the reject invariant. *)
(* Thread PRRT_kwDOSK-bwM66ZGcC. Gap 1: State invariants cannot check the shell runner's module choice.
Replay: The old documented command reports six unknown results. The fixed command checks all seven configs. *)
(* Expectation for round 6: Reject explicit Windows roots before import or cleanup. Keep supported roots usable.
Replay: Without the constructor guard, three reject tests fail and five accept tests pass. No new bug found. *)
(* The runner also handles TLC's constant-invariant FALSE result. This is an invariant failure, not a parse failure.
The fixed config passes. All six sabotage configs fail their intended invariants. *)
(* Shared runner validation: check.sh all reports the expected result for all 60 configs.
The model checks the constructor policy. It does not check Windows ACLs or prove the implementation. *)
(* Cost: One agent, no delegates. Rounds 1/2/3/4 took about 6/3/4/6 minutes.
Header cleanup took about 2 minutes. These are work estimates. *)
(* Round 6 cost: One agent, about 10 minutes including checks. No delegates.
The first invariants preceded this round. The new invariants follow the review ratchet. *)
(* Round 7: Retry, env publication, deletion, format upgrades, directory checks, and cleanup add recovery actions. Added 6.
The split keeps publication interleavings separate from directory loading, format upgrades, and cleanup recovery. *)
(* Round 7 gaps: Test completeness, test isolation, metadata, and comments use direct checks. Gap 4.
The tests cover isolated mode bits, types, bundle swaps, ancestor checks, and temporary cache roots. *)
(* Round 7 simplification: Remove the memory path map. Source path and mtime already determine the path.
Use one validated disk lookup. Prepare env files before the bundle commit marker. *)
(* Round 8: Repeated compilation of an unchanged broken source adds a recovery invariant. Added 1.
The directory check already covers a loose directory after concurrent cleanup. Covered 1. *)
(* Round 8 gaps: Spec prose, PR behavior text, and unverified Windows rename behavior need direct evidence. Gap 3.
Headers now name behaviors. The PR body states that unreadable environment files fail a build. *)
(* Gate: Run check.sh CustomToolCache and the property tables. The runner selects CustomToolCacheMC.
Use -metadir outside the repo. TLC needs a local socket. Run file tests on the host. *)
EXTENDS Naturals, TLC
CONSTANTS AtomicPublish, CanonicalMatch, Writers, NormalizeCache, GuardCleanup, ProbeNormalized, CleanupCases
CONSTANT RejectExplicitWindows
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
(* Source: clearCache existsSync probe. A raw path with a missing dir hides the root. *)
ProbeSeesRoot == \A c \in CleanupCases : IF ProbeNormalized THEN TRUE ELSE c.rawProbe
MayClear(safe) == IF GuardCleanup THEN safe ELSE TRUE
UnsafeRootIsUntouched == \A safe \in BOOLEAN : ~safe => ~MayClear(safe)
(* PR #2485, thread PRRT_kwDOSK-bwM66ZGcG: Reject unverified explicit Windows roots before construction.
Source: RegistryOptions.cacheDir. Sinks: import and clearCache require a constructed registry. *)
CanConstruct(windows, explicit) == ~(RejectExplicitWindows /\ windows /\ explicit)
ExplicitWindowsRootIsRejected == ~CanConstruct(TRUE, TRUE)
SupportedRootsAreAccepted == \A windows, explicit \in BOOLEAN :
    ~(windows /\ explicit) => CanConstruct(windows, explicit)
=============================================================================
