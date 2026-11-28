-------------------------- MODULE LocalTestRunner --------------------------
(* Sources: scripts/test-local.mjs runTurbo and turbo.json. Sinks: actual Turbo parsing and the installed Vitest worker.
Failures: tests start before bundling, worker limits are lost, duplicate default flags reject the test step, or logs misreport it. *)
(* Current review: 16 summary findings and inline CodeQL thread PRRT_kwDOSK-bwM68n0NV on PR #2757.
Cumulative ratchet totals: added 6, covered 1, gap 21 across 28 findings. This round adds 1, covers 1, and records 15 gaps. *)
(* Finding 1 adds option-count and concurrency-log invariants. Finding 16 is covered by the existing no-CI reader input.
Other findings concern process launch APIs, parser oracles, test construction, CI wiring, model structure, prose, or PR scope. *)
(* Expectation: injecting a default when a caller already supplied the option makes actual Turbo reject the test step.
A caller option after -- belongs to the package. Default injection and logging inspect only the preceding Turbo arguments. *)
(* Remove WindowsUsesExecutable: it repeated a constant without representing an executable choice. Process-launch tests cover it.
Remove unused Turbo cache state from LintCache: extension lint invokes ESLint directly. These are model corrections, not runtime fixes. *)
(* The integration tests must start the real runner before real Turbo and Vitest. Fixture code is static and inputs are JSON data.
Inline alert: https://github.com/Zoo-Code-Org/Zoo-Code/security/code-scanning/49. No source-code interpolation is needed. *)
(* Parsed limits, caller option classification, and process outcomes are oracles. Do not copy the CLI parser into this model.
The model does not prove dependency code, native Windows execution, elapsed time, or a memory budget. *)
(* Results: eight invariants hold over 36 states. All ten sabotage configs fail. No new runtime defect was found by TLC.
Replay: the old runner fails three real integration cases. All 16 runtime and configuration mutations fail their tests. *)
(* Validation: all 52 workflow, runner, and integration tests pass. The fixture starts real pnpm, Turbo, and Vitest.
Cost: one agent, no delegates; two focused model runs, one pre-fix integration replay, and 16 mutation replays. *)
EXTENDS Naturals
CONSTANTS WorkerValues, TaskValues, ReaderCases, RequireBundle, PassWorkers, PassConcurrency, RespectCI, ForwardThroughTurbo, ReportSpawnError, PreserveArgs, AvoidDuplicateFlags, ReportEffectiveConcurrency, RespectBoundary, FlagCases, Args
VARIABLES bundle, tests, workers, tasks, emittedWorkers, emittedTasks, emittedArgs, spawnError, reported
vars == <<bundle, tests, workers, tasks, emittedWorkers, emittedTasks, emittedArgs, spawnError, reported>>
Init == /\ bundle = "idle" /\ tests = "idle"
        /\ workers \in WorkerValues /\ tasks \in TaskValues
        /\ emittedWorkers = 0 /\ emittedTasks = 0 /\ emittedArgs = <<>>
        /\ spawnError \in BOOLEAN /\ reported = FALSE
Bundle(result) == /\ bundle = "idle" /\ (~spawnError \/ result = "failed") /\ bundle' = result
                  /\ reported' = (result = "failed" /\ spawnError /\ ReportSpawnError)
                  /\ UNCHANGED <<tests, workers, tasks, emittedWorkers, emittedTasks, emittedArgs, spawnError>>
StartTests == /\ tests = "idle" /\ (~RequireBundle \/ bundle = "ready")
              /\ tests' = "started"
              /\ emittedWorkers' = IF PassWorkers THEN workers ELSE 0
              /\ emittedTasks' = IF PassConcurrency THEN tasks ELSE 0
              /\ emittedArgs' = IF PreserveArgs THEN Args ELSE <<>>
              /\ UNCHANGED <<bundle, workers, tasks, spawnError, reported>>
Next == Bundle("ready") \/ Bundle("failed") \/ StartTests
Spec == Init /\ [][Next]_vars
BundleBeforeTests == tests = "started" => bundle = "ready"
VitestWorkers == IF ForwardThroughTurbo THEN emittedWorkers ELSE 0
WorkerLimitReachesTests == tests = "started" => VitestWorkers = workers
ConcurrencyReachesTests == tests = "started" => emittedTasks = tasks
ReaderBound(c) == IF c.envBound > 0 THEN c.envBound ELSE IF RespectCI /\ c.fixedCI THEN c.ciBound ELSE 0
ReaderLimitsArePreserved == tests = "started" => \A c \in ReaderCases : ReaderBound(c) = c.expected
SpawnErrorsAreVisible == bundle = "failed" /\ spawnError => reported
CallerArgumentsSurvive == tests = "started" => emittedArgs = Args
OptionCount(c) == IF c.supplied THEN
    IF c.beforeBoundary THEN IF AvoidDuplicateFlags THEN 1 ELSE 2
    ELSE IF RespectBoundary THEN 1 ELSE 0
    ELSE 1
TurboOptionsAreUnique == tests = "started" => \A c \in FlagCases : OptionCount(c) = 1
SelectedLimit(c) == IF c.beforeBoundary /\ c.supplied THEN c.requested ELSE c.fallback
LoggedLimit(c) == IF ~ReportEffectiveConcurrency THEN c.fallback
    ELSE IF ~RespectBoundary /\ ~c.beforeBoundary /\ c.supplied THEN c.requested
    ELSE SelectedLimit(c)
ConcurrencyLogMatchesCommand == tests = "started" => \A c \in FlagCases : LoggedLimit(c) = SelectedLimit(c)
=============================================================================
