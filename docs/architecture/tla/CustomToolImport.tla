------------------------ MODULE CustomToolImport ------------------------
(* Sources: CustomToolRegistry.import and validateCachePath. Sinks: dynamic import and the cache-miss branch.
Failure: URL syntax changes the selected path, or a failed cache check permits a build. *)
(* Invariants: ImportKeepsPath preserves the path. OnlyMissingBuilds permits builds only for absent entries.
Expectation: Raw URLs fail for reserved characters. Treating unsafe entries as missing fails the lookup rule. *)
(* Path conversion and filesystem results are oracles. This model does not implement URL parsing or filesystem checks.
Runtime tables check JS imports, TS publication, cache hits, and missing versus rejected cache entries. *)
(* Findings: Fixed passes both invariants over four states. RawUrl fails ImportKeepsPath. UnsafeMiss fails OnlyMissingBuilds.
Replay: Raw imports fail four reserved-path cases. Returning false for unsafe entries fails six permission cases. *)
(* False alarm: Vitest cannot resolve encoded hash paths. The same registry cases pass in native Node subprocesses.
The existing compiler helper builds the registry for those subprocesses. No production import hook is needed. *)
(* Validation: All 90 integration tests, nine final focused cases, and 34 unit tests pass. Both type checks, lint, formatting, and both Knip checks pass.
The one-lstat property uses a runtime call-count assertion. This model does not check filesystem call counts. *)
(* Cost: One agent, about five minutes including checks. No delegates. No unexpected runtime defect was found.
The model checks the source-to-sink policy. It does not prove URL conversion or filesystem race safety. *)
(* CI timing expectation: A cold run can exceed five seconds. A 30-second limit covers the bounded oracle.
Failure: A correct native import exceeds the test limit. Invariant: Each bounded run fits the limit. *)
(* Source: The reserved-path it.each callback. Sink: The Vitest timeout, after runEsbuild and execFileSync.
CompilerSeconds is an oracle for total callback time. It does not bound real machine speed. *)
(* Timing findings: Fixed passes three invariants over four states. All three sabotage configs fail as expected.
A six-second injected delay fails the old test limit and passes the new limit in 7.57 seconds. *)
(* Replay: The unmodified six-case path table passes under coverage locally. CI job 139698715435 timed out twice.
Null result: The timing model found no new runtime defect. The delay was removed after the replay. *)
(* Timing validation: All 108 core integration tests pass with coverage. Core and extension type checks pass.
Focused lint and formatting pass. No suppression count increases. *)
(* Cost: One agent, about six minutes including CI log checks and replay. No delegates.
The oracle uses 1, 6, and 18 seconds. The model makes no claim about unbounded machine delays. *)
EXTENDS Naturals
CONSTANTS EncodePath, RejectUnsafe, CompilerSeconds, TimeoutSeconds
VARIABLE result
vars == <<result>>
Init == result = "idle"
Inputs == {"missing", "safe", "unsafe", "error"}
Lookup(input) == /\ result = "idle"
                 /\ result' = IF input = "missing" THEN "build"
                              ELSE IF input = "safe" THEN "reuse"
                              ELSE IF RejectUnsafe THEN "reject" ELSE "unsafe-build"
Next == \E input \in Inputs : Lookup(input)
Spec == Init /\ [][Next]_vars
(* Ordinary paths and reserved characters are separate oracle classes. *)
ImportKeepsPath == \A reserved \in BOOLEAN : EncodePath \/ ~reserved
OnlyMissingBuilds == result # "unsafe-build"
ColdCompilerFitsBudget == \A seconds \in CompilerSeconds : seconds <= TimeoutSeconds
=============================================================================
