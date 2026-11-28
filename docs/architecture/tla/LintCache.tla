---------------------------- MODULE LintCache ----------------------------
(* Sources: package.json lint-staged and lint:ci commands. Sink: the extension check in the Code QA Lint step.
Failure: extension CI reuses a passing result after an imported type changes. *)
(* Expectation: extension CI must bypass the ESLint file cache. Removing this bypass must fail ExtensionCiChecksCurrent.
Local cached results provide feedback only. The model does not claim that they check imported type changes. *)
(* File validity, prior results, and current lint results are input oracles. No linter or dependency parser is copied.
The configuration tests check command wiring. The CI extension command runs ESLint directly, outside Turbo. *)
(* Results use 0 for failure, 1 for success, and 2 for a pending check. *)
(* Results: the fixed model passes both invariants over 32 states. Both sabotage configs fail their named policy.
Replay: removing staged caching or the fresh extension command makes the configuration tests fail. *)
(* Validation: workflow tests, the full lint:ci command, formatting, and both Knip checks pass. No suppression counts change.
The configured staged command took 9.47 seconds cold and 0.92 seconds warm during the full lint run. *)
(* A mixed boolean/string result first caused a TLC type error. The corrected result domain uses numeric status values.
ESLint also rejected appending --no-cache to a script with --cache-strategy. The dedicated extension command passes. *)
(* Cost: one agent, about seven minutes including checks. No delegates. No unexpected runtime defect was found.
The model checks cache policy. It does not prove ESLint or Turbo behavior. *)
(* PR #2757 review item 8: this model covers the extension only. Other workspaces keep their existing ESLint cache policy.
The policy is unchanged. Mode and invariant names now state extension scope. Review counts appear in LocalTestRunner. *)
(* PR #2757 incremental review finding 10: extension lint runs outside Turbo. Remove the unused Turbo cache state.
No claim is made about other workspace caches. Current review counts appear in LocalTestRunner. *)
EXTENDS Naturals
CONSTANTS FreshCI, CacheLocal
VARIABLES mode, current, previous, entryValid, outcome
vars == <<mode, current, previous, entryValid, outcome>>
Init == /\ mode \in {"local-extension", "extension-ci"} /\ current \in 0..1 /\ previous \in 0..1
        /\ entryValid \in BOOLEAN /\ outcome = 2
Lint == /\ outcome = 2
        /\ outcome' = IF mode = "local-extension" THEN
                          IF CacheLocal /\ entryValid THEN previous ELSE current
                      ELSE IF ~FreshCI /\ entryValid THEN previous ELSE current
        /\ UNCHANGED <<mode, current, previous, entryValid>>
Spec == Init /\ [][Lint]_vars
ExtensionCiChecksCurrent == mode = "extension-ci" /\ outcome # 2 => outcome = current
LocalExtensionCacheIsUsed == mode = "local-extension" /\ entryValid /\ outcome # 2 => outcome = previous
=============================================================================
