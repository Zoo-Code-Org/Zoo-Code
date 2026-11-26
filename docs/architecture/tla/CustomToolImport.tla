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
EXTENDS Naturals
CONSTANTS EncodePath, RejectUnsafe
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
=============================================================================
