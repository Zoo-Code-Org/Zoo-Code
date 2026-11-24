---------------------- MODULE CustomToolCacheRecovery ----------------------
(* Sources: loadFromDirectoryIfStale, import, copyEnvFiles, and clearCache in CustomToolRegistry.
Sinks: lastLoaded, import(bundle.mjs), and the next cleanup entry. *)
(* PR #2485, recovery review: Failed loads stay retryable. Published entries have complete env files.
Deleted entries rebuild. Publication checks the directory. Cleanup continues after an entry error. *)
(* Expectation: Each old-path config breaks its named invariant. The fixed model passes.
This round follows the review ratchet. The findings were supplied before these invariants. *)
(* Simplification: A bundle path follows from the source key. The runtime needs no memory mirror.
The mirror choice is a constant. Compiler and filesystem results are oracles. *)
(* Findings: The fixed model passes seven invariants over 144 states. All seven old-path configs fail as expected.
The bounds use one writer, one reload, and two cleanup entries. No process fairness claim is made. *)
(* Replay: The first old-code run has ten assertion failures and one timeout. The timeout is not a counterexample.
Round 7 code passes 75 integration tests and 34 unit tests. No new runtime defect was found by the model. *)
(* Mutation replay: All eight targeted mutations are caught. The ancestor fixture needed an existing safe parent.
The redundant memory-hit check no longer exists. The single disk-hit check is covered by bundle-swap tests. *)
(* Cost: One agent, about 15 minutes including cold compiler runs. No delegates.
The model checks the policy. It does not prove the runtime implementation or power-loss durability. *)
(* PR #2485, repeated-build review: An unchanged source syntax failure must not rerun the compiler.
A changed file version allows another build. Four old-code assertion cases confirm the repeated calls. *)
(* The new repeated-build variant fails after a second request. Cache failures still use FailedLoadIsRetryable.
Source-error classification is an oracle. Unit cases and real compiler calls check the runtime classification. *)
(* Round 8 validation: 90 integration tests and 51 unit tests pass. The final classifier passes six focused retry cases.
Both type checks and focused lint pass. No suppression count increases. *)
(* Round 8 cost: One agent, about 10 minutes including checks. No delegates.
Dependency and unknown compiler errors remain retryable. Changed diagnostics fall back to retry. *)
EXTENDS Naturals
CONSTANTS CommitSuccessOnly, EnvBeforeBundle, UseMemoryMirror, RecheckDirectory, ContinueCleanup, CurrentFormatOnly, RememberSourceFailure
VARIABLES stage, bundle, env, safeDirectory, marked, cleanup, retryState, sourceVersion, failedVersion, compilerCalls
recoveryVars == <<stage, bundle, env, safeDirectory, marked, cleanup, retryState, sourceVersion, failedVersion, compilerCalls>>
RecoveryInit == /\ stage = "idle" /\ bundle = "absent" /\ env = FALSE /\ safeDirectory = TRUE
                /\ marked = FALSE /\ cleanup = "idle"
                /\ retryState = "untried" /\ sourceVersion = 0 /\ failedVersion = 2 /\ compilerCalls = 0
Begin == /\ stage = "idle" /\ stage' = "building"
         /\ marked' = ~CommitSuccessOnly
         /\ UNCHANGED <<bundle, env, safeDirectory, cleanup, retryState, sourceVersion, failedVersion, compilerCalls>>
CopyEnv == /\ stage = "building" /\ env' = TRUE
           /\ UNCHANGED <<stage, bundle, safeDirectory, marked, cleanup, retryState, sourceVersion, failedVersion, compilerCalls>>
ClearDuringBuild == /\ stage = "building" /\ safeDirectory' = FALSE
                    /\ UNCHANGED <<stage, bundle, env, marked, cleanup, retryState, sourceVersion, failedVersion, compilerCalls>>
Commit == /\ stage = "building" /\ (~EnvBeforeBundle \/ env)
          /\ (~RecheckDirectory \/ safeDirectory)
          /\ stage' = "loaded" /\ bundle' = "ready" /\ marked' = TRUE
          /\ UNCHANGED <<env, safeDirectory, cleanup, retryState, sourceVersion, failedVersion, compilerCalls>>
LoadFails == /\ stage = "building" /\ stage' = "failed"
             /\ marked' = IF CommitSuccessOnly THEN FALSE ELSE marked
             /\ UNCHANGED <<bundle, env, safeDirectory, cleanup, retryState, sourceVersion, failedVersion, compilerCalls>>
DeleteEntry == /\ stage = "loaded" /\ stage' = "deleted" /\ bundle' = "absent" /\ env' = FALSE
               /\ UNCHANGED <<safeDirectory, marked, cleanup, retryState, sourceVersion, failedVersion, compilerCalls>>
Reload == /\ stage = "deleted" /\ stage' = "reloaded"
          /\ UNCHANGED <<bundle, env, safeDirectory, marked, cleanup, retryState, sourceVersion, failedVersion, compilerCalls>>
CleanupFails == /\ cleanup = "idle" /\ cleanup' = IF ContinueCleanup THEN "next" ELSE "stopped"
                /\ UNCHANGED <<stage, bundle, env, safeDirectory, marked, retryState, sourceVersion, failedVersion, compilerCalls>>
(* Old entries can contain a bundle without env files. The versioned key excludes them. *)
OldDiskHit == /\ stage = "idle" /\ ~CurrentFormatOnly
              /\ stage' = "loaded" /\ bundle' = "ready"
              /\ UNCHANGED <<env, safeDirectory, marked, cleanup, retryState, sourceVersion, failedVersion, compilerCalls>>
(* A recognized entry-source syntax diagnostic is an oracle result from runEsbuild. Cache and unknown failures stay retryable. *)
SourceBuildFails == /\ retryState \in {"untried", "edited"}
                    /\ retryState' = "failed" /\ failedVersion' = sourceVersion /\ compilerCalls' = 1
                    /\ UNCHANGED <<stage, bundle, env, safeDirectory, marked, cleanup, sourceVersion>>
RequestAgain == /\ retryState = "failed" /\ retryState' = "requested"
                /\ compilerCalls' = IF RememberSourceFailure THEN compilerCalls ELSE compilerCalls + 1
                /\ UNCHANGED <<stage, bundle, env, safeDirectory, marked, cleanup, sourceVersion, failedVersion>>
EditSource == /\ retryState = "requested" /\ sourceVersion = 0
              /\ sourceVersion' = 1 /\ retryState' = "edited"
              /\ UNCHANGED <<stage, bundle, env, safeDirectory, marked, cleanup, failedVersion, compilerCalls>>
UnchangedSourceDoesNotRebuild == compilerCalls <= 1
ChangedSourceCanRetry == retryState = "edited" => sourceVersion # failedVersion
RecoveryNext == Begin \/ CopyEnv \/ ClearDuringBuild \/ Commit \/ LoadFails \/ DeleteEntry \/ Reload \/ CleanupFails \/ OldDiskHit \/ SourceBuildFails \/ RequestAgain \/ EditSource
RecoverySpec == RecoveryInit /\ [][RecoveryNext]_recoveryVars
FailedLoadIsRetryable == stage = "failed" => ~marked
PublishedEntryIsComplete == bundle = "ready" => env
PublishedDirectoryIsSafe == bundle = "ready" => safeDirectory
DeletedEntryCanRebuild == stage = "reloaded" => ~UseMemoryMirror
CleanupDoesNotStop == cleanup # "stopped"
=============================================================================
