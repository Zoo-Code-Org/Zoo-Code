---------------------------- MODULE LintCache ----------------------------
(* Sources: package.json lint-staged and lint:ci commands. Sink: the Code QA Lint step.
Failure: CI reuses a passing result after an imported type changes. *)
(* Expectation: both cache layers must be bypassed in CI. Removing either bypass must fail CiChecksCurrent.
Local cached results provide feedback only. The model does not claim that they check imported type changes. *)
(* File validity, prior results, and current lint results are input oracles. No linter or dependency parser is copied.
The configuration tests check command wiring. The CI extension command runs ESLint directly, outside Turbo. *)
(* Results use 0 for failure, 1 for success, and 2 for a pending check. *)
(* Results: the fixed model passes both invariants over 64 states. All three sabotage configs fail their named policy.
Replay: removing staged caching, Turbo force, or the fresh extension command makes the configuration tests fail. *)
(* Validation: workflow tests, the full lint:ci command, formatting, and both Knip checks pass. No suppression counts change.
The configured staged command took 9.47 seconds cold and 0.92 seconds warm during the full lint run. *)
(* A mixed boolean/string result first caused a TLC type error. The corrected result domain uses numeric status values.
ESLint also rejected appending --no-cache to a script with --cache-strategy. The dedicated extension command passes. *)
(* Cost: one agent, about seven minutes including checks. No delegates. No unexpected runtime defect was found.
The model checks cache policy. It does not prove ESLint or Turbo behavior. *)
EXTENDS Naturals
CONSTANTS ForceCI, FreshCI, CacheLocal
VARIABLES mode, current, previous, entryValid, turboHit, outcome
vars == <<mode, current, previous, entryValid, turboHit, outcome>>
Init == /\ mode \in {"local", "ci"} /\ current \in 0..1 /\ previous \in 0..1
        /\ entryValid \in BOOLEAN /\ turboHit \in BOOLEAN /\ outcome = 2
Lint == /\ outcome = 2
        /\ outcome' = IF mode = "local" THEN
                          IF CacheLocal /\ entryValid THEN previous ELSE current
                      ELSE IF (~ForceCI /\ turboHit) \/ (~FreshCI /\ entryValid) THEN previous ELSE current
        /\ UNCHANGED <<mode, current, previous, entryValid, turboHit>>
Spec == Init /\ [][Lint]_vars
CiChecksCurrent == mode = "ci" /\ outcome # 2 => outcome = current
LocalCacheIsUsed == mode = "local" /\ entryValid /\ outcome # 2 => outcome = previous
=============================================================================
