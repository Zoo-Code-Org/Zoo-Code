---- MODULE McpSelectionEpoch ----
\* Sources: McpToolSelection.reset and Task.saveClineMessages. Sink: mergeHistoryDelta and restart.
\* Failure: a reset is lost, or an old snapshot restores names from before the reset.
\* Invariant: EpochOwned. Only snapshots from the current generation contribute names.
\* Failure: identical text in distinct messages skips a rank. Invariant: MessageRanked.
\* First invariants for topic, window, and cap preceded review. These two are review additions.
\* Review: PR 2323 discussion_r4725029375 and discussion_r4725029365. 0 covered, 2 added, 0 gap.
\* Expect: LostReset and StaleSave violate EpochOwned. TextOnly violates MessageRanked.
\* Oracles: ranks return one new name; snapshots contain one name or an absent selection.
\* Scope: one reset, two messages with identical text, and an old save in either order.
\* Replay: unfixed tests fail on repeated text and on a fresh store that restores old names after reset.
\* Result: fixed holds in 12 states. All three fault configs fail their named invariants.
\* False alarm: the TypeScript model let an old save read the new generation. The scenario now fixes its generation.
\* Findings: both review defects reproduced. No additional defect was found.
\* Tests: mcpAttachments.property.spec.ts and mcpToolSelection.spec.ts pass on the fixed code.
\* Cost: initial gate 2.8 seconds. Agent time was not measured.
\* Validation: 20,329 extension tests and 18 history schema tests pass. TypeScript and lint pass.
\* The lifecycle suite passes. The root test command stops at the missing eslint-plugin-i18next dependency.
\* Refactor expectation: null result. The merge keeps the same older, equal, and newer generation rules.
\* Failure to prevent: an equal-generation absent snapshot removes names committed by another save.
\* EpochOwned and the production snapshot-order property test remain the checks. No transition changes.
\* Refactor result: null result. Fixed holds in 12 states. All three fault configs still fail.
\* The production merge passes the snapshot-order property test and all 15 shared-store model scenarios.
\* Cost: 17 focused persistence tests run in 1 second. Agent time was not measured.
\* Refactor validation: 20,332 extension tests, lifecycle checks, TypeScript, and lint pass. Suppression counts are unchanged.
EXTENDS Naturals
CONSTANT Variant
VARIABLES epoch, names, phase, oldSaved, turn, ranked
vars == <<epoch, names, phase, oldSaved, turn, ranked>>
Init == /\ epoch = 0 /\ names = {"old"} /\ phase = "before"
        /\ oldSaved = FALSE /\ turn = 1 /\ ranked = 1
Reset == /\ phase = "before" /\ phase' = "reset"
         /\ IF Variant = "LostReset" THEN UNCHANGED <<epoch, names>>
            ELSE /\ epoch' = 1 /\ names' = {}
         /\ UNCHANGED <<oldSaved, turn, ranked>>
FreshSave == /\ phase = "reset" /\ phase' = "fresh"
             /\ names' = names \cup {"new"}
             /\ UNCHANGED <<epoch, oldSaved, turn, ranked>>
OldSave == /\ ~oldSaved /\ oldSaved' = TRUE
           /\ names' = IF epoch = 0 \/ Variant = "StaleSave" THEN names \cup {"old"} ELSE names
           /\ UNCHANGED <<epoch, phase, turn, ranked>>
Message == /\ turn = 1 /\ turn' = 2
           /\ ranked' = IF Variant = "TextOnly" THEN ranked ELSE 2
           /\ UNCHANGED <<epoch, names, phase, oldSaved>>
Next == Reset \/ FreshSave \/ OldSave \/ Message
Spec == Init /\ [][Next]_vars
EpochOwned == phase # "before" => /\ epoch = 1 /\ "old" \notin names
MessageRanked == ranked = turn
====
