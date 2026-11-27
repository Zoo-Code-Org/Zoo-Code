-------------------------- MODULE LocalTestRunner --------------------------
(* Source: scripts/test-local.mjs runTurbo. Sinks: bundle and test child processes, plus Vitest maxWorkers readers.
Failures: tests run before a successful bundle, worker limits are lost, or fixed CI limits change. *)
(* Expectation: the current runner passes. Each removed gate must fail its matching invariant.
Number parsing, process results, and reader inputs are oracles. This model does not estimate memory use. *)
(* Property tests execute the real runner with a child-process double and evaluate the real Vitest configurations.
The model uses only the source and sinks. Model bounds live in LocalTestRunnerMC. *)
(* Results: the fixed model passes all four invariants over 16 states. All four sabotage configurations fail as expected.
Replay: removing the bundle gate, worker argument, task limit, or fixed CI branch makes the real-code tests fail. *)
(* Validation: all 25 workflow and runner tests pass. Ten config readers cover local, Linux CI, and Windows CI inputs.
Tests also check bundle failure, child-process failure, invalid limits, argument forwarding, and enabled test isolation. *)
(* An existing workflow assertion expected the old maxWorkers expression. Actual config-reader tests replace that stale assertion.
No new runner defect was found. The model cannot establish a memory budget or benchmark elapsed time. *)
(* Cost: one agent, about six minutes for the initial model and two minutes for helper extraction. No delegates.
Reader inputs and parsed limits stay oracles. Child-process doubles do not execute bundles or the full workspace suite. *)
(* Refactor expectation: a shared runTurbo helper preserves the bundle gate, limits, and trailing caller arguments.
The current invariants cover process ordering and limits. Runtime tests check argument precedence. *)
(* Refactor result: all 25 tests pass. All four model sabotages and five runtime mutations fail as expected.
No new runtime defect was found. The helper shares command construction without adding state. *)
EXTENDS Naturals
CONSTANTS WorkerValues, TaskValues, ReaderCases, RequireBundle, PassWorkers, PassConcurrency, RespectCI
VARIABLES bundle, tests, workers, tasks, emittedWorkers, emittedTasks
vars == <<bundle, tests, workers, tasks, emittedWorkers, emittedTasks>>
Init == /\ bundle = "idle" /\ tests = "idle"
        /\ workers \in WorkerValues /\ tasks \in TaskValues
        /\ emittedWorkers = 0 /\ emittedTasks = 0
Bundle(result) == /\ bundle = "idle" /\ bundle' = result
                  /\ UNCHANGED <<tests, workers, tasks, emittedWorkers, emittedTasks>>
StartTests == /\ tests = "idle" /\ (~RequireBundle \/ bundle = "ready")
              /\ tests' = "started"
              /\ emittedWorkers' = IF PassWorkers THEN workers ELSE 0
              /\ emittedTasks' = IF PassConcurrency THEN tasks ELSE 0
              /\ UNCHANGED <<bundle, workers, tasks>>
Next == Bundle("ready") \/ Bundle("failed") \/ StartTests
Spec == Init /\ [][Next]_vars
BundleBeforeTests == tests = "started" => bundle = "ready"
WorkerLimitReachesTests == tests = "started" => emittedWorkers = workers
ConcurrencyReachesTests == tests = "started" => emittedTasks = tasks
ReaderBound(c) == IF RespectCI /\ c.fixedCI THEN c.ciBound ELSE c.localBound
ReaderLimitsArePreserved == tests = "started" => \A c \in ReaderCases : ReaderBound(c) = c.expected
=============================================================================
