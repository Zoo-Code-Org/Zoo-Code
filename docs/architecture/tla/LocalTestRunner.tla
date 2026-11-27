-------------------------- MODULE LocalTestRunner --------------------------
(* Sources: scripts/test-local.mjs runTurbo and turbo.json. Sinks: the actual Vitest config and worker process.
Failures: tests run before bundling, Turbo drops the worker cap, spawn errors stay silent, or caller arguments are lost. *)
(* Review ratchet, PR #2757 supplied review without thread URLs: findings 1, 2, 3, 5, and 6 add boundaries or inputs.
Findings 4, 7, 8, 9, 10, and 11 are gaps checked through scope notes, command tests, or prose. Added 5, covered 0, gap 6. *)
(* Expectation: strict Turbo drops the cap without passthrough. Vitest applies its own environment override after config resolution.
A CI config limit applies when the override is absent. Number parsing and process results remain input oracles. *)
(* Tests must execute installed Turbo and Vitest in a scratch workspace. Spawn doubles alone miss the forwarding failure.
Windows launcher tests check the argument array and error output. They do not establish native Windows execution. *)
(* Simplification: derive the received cap from the runner value and Turbo policy. Do not add a second mutable cap.
The model does not estimate memory use. The previous 16-state model stopped before Turbo's environment filter. *)
(* Results: the corrected runner model passes seven invariants over 36 states. All eight sabotage configs fail as expected.
The old strict-mode integration fails both inputs. Passthrough lets installed Vitest resolve worker limits 1 and 3. *)
(* Replay: all 13 runtime and configuration mutations fail tests. They include the Turbo boundary, Windows launcher,
spawn diagnostics, one worker, caller separators, numeric validation, CI wiring, and both default log flags. *)
(* Validation: 33 workflow and runner tests plus 24 extension activation tests pass. Type checking, lint, formatting, and Knip pass.
All ten Vitest configs now match the pre-PR files. The installed SDK applies the worker environment override itself. *)
(* Limits: Windows startup uses a platform double. Native Windows and new full-suite memory benchmarks were not run.
Scope remains in PR #2757 at the author's request. Old full-run figures do not validate an effective worker cap. *)
(* Cost: one agent, about fifteen minutes including model updates, boundary tests, and mutation replays. No delegates.
No further runtime defect was found beyond the supplied review. The model checks an abstraction, not the installed SDK. *)
EXTENDS Naturals
CONSTANTS WorkerValues, TaskValues, ReaderCases, RequireBundle, PassWorkers, PassConcurrency, RespectCI, ForwardThroughTurbo, ReportSpawnError, PreserveArgs, UseNodeLauncher, Args
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
WindowsUsesExecutable == tests = "started" => UseNodeLauncher
=============================================================================
