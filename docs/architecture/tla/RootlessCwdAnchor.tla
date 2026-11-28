---- MODULE RootlessCwdAnchor ----
\* Models the task working-directory anchor and the editor-tab mention value
\* for a VS Code session with no workspace folder open (issue 1271).
\* Source: getTaskCwdPath (src/utils/path.ts). Sinks: Task workspacePath,
\* WorkspaceTracker getOpenedTabsInfo and publishOpenedTabs,
\* getEnvironmentDetails file listing and getRulesSection Desktop example
\* text. path.resolve and path.relative are oracles; only the anchor choice,
\* the value base and the wording are modeled.
\* Failure: with no workspace root the task anchors to a constructed
\* <home>/Desktop path that may not exist (a lowercase "desktop" home),
\* prompt text steers the model into it, a tab mention value built against
\* an empty root never resolves back to the open file, an editor change
\* after task start moves the tracker value base off the stored task anchor,
\* and a task activation after a pre-task publish leaves the offered values
\* on the old anchor.
\* Invariants: AnchorExists, NoDesktopSteer, MentionRoundTrip.
\* Expect: Fixed holds in every state, including through an editor change
\* between two distinct file directories and through a task activation.
\* Expect: Unfixed fails AnchorExists (home "desktop", Desktop missing),
\* NoDesktopSteer and MentionRoundTrip.
\* Expect: NoAnchorGuard, the sabotage that removes the last-resort
\* fallback, fails AnchorExists only.
\* Expect: EditorDrift, the sabotage that recomputes the tracker value base
\* from the live editor on every update, fails MentionRoundTrip only - a
\* file-to-file change between two distinct directories is enough.
\* Expect: NoActivationRefresh, the sabotage that keeps the offered values
\* on the old anchor when a task activates, fails MentionRoundTrip only.
\* Result: Fixed holds in 42 distinct states (Init plus EditorChange and
\* TaskActivates moves). Unfixed fails AnchorExists in the initial state,
\* with a missing Desktop, Desktop-worded steer text and an empty-root
\* mention value - the reporter's case. NoAnchorGuard fails AnchorExists
\* only. EditorDrift fails MentionRoundTrip: after an editor change the
\* tracker value base sits on the new editor directory while the task anchor
\* stays stored - the offered value resolves to a different file; a
\* fileA-to-fileB change alone is enough. NoActivationRefresh fails
\* MentionRoundTrip: the first published value base survives a task
\* activation whose stored anchor differs. Found: the counterexamples
\* above; no unknown failure mode.
\* Replay: Task.ts anchored the workspace path to <home>/Desktop, env
\* details steered to it, and getOpenedTabsInfo cut tab paths against an
\* empty root. All three leak; a unit test pins each. Round 3 replay: the
\* tracker called getTaskCwdPath() on every tab update while the task kept
\* its construction anchor, so an editor change offered mention values that
\* resolve to a different file; WorkspaceTracker.spec.ts pins it. Round 4
\* replay: the tracker published only on tab and file events, so values cut
\* against the pre-task live anchor stayed in the webview after a task with
\* a different stored anchor activated; ClineProvider now republishes at
\* both activation points and WorkspaceTracker.spec.ts pins the values.
\* Not modeled: real path algebra (resolve and relative are oracles), the
\* webview suggestion UI, multi-root workspaces.
\* Cost: TLC runs in under 5 seconds per config. Agent time is not measured.
\* Review: 1 covered, 2 added, 0 gap (round 2: widened the TypeOK valueBase
\* domain to admit the NoAnchorGuard sabotage value, isolating the
\* AnchorExists failure. Round 3, CR 4714268585: added the EditorChange
\* action and the EditorDrift variant - with Next == UNCHANGED vars the
\* anchor drift was unrepresentable. Round 4, CR 6082416304: split the
\* single editorDir identity into dirA and dirB so a file-to-file editor
\* change is representable (inline 4714883169), and added the TaskActivates
\* action with the NoActivationRefresh variant for the activation republish
\* (inline 4714883173)).
\* Property test: src/core/mentions/__tests__/index.spec.ts (parseMentions
\* resolves an anchor-relative tab value to the open file, the tab file wins
\* over a cwd-relative shadow) and src/utils/__tests__/path.spec.ts (anchor
\* and value algebra round-trip, it.each). Caller tests:
\* WorkspaceTracker.spec.ts, getEnvironmentDetails.spec.ts, sections.spec.ts.
CONSTANT Variant \* "Fixed", "Unfixed", "NoAnchorGuard", "EditorDrift" or "NoActivationRefresh"

VARIABLES root, editor, desktopExists, anchor, valueBase, steer

vars == <<root, editor, desktopExists, anchor, valueBase, steer>>

\* root = "open": a workspace folder exists. editor names the active
\* editor: "fileA" and "fileB" are text editors in two DIFFERENT
\* directories, so a file-to-file change is representable; "none" is no
\* editor. desktopExists says whether <home>/Desktop exists on this system;
\* both answers are real user systems. ed is the editor state a choice
\* reads: the task reads it once at construction, a drifting tracker reads
\* it again on every update.
AnchorChoice(ed) ==
  IF Variant = "NoAnchorGuard"
    THEN IF root = "open" THEN "root"
         ELSE IF ed = "fileA" THEN "dirA"
         ELSE IF ed = "fileB" THEN "dirB"
         ELSE "nowhere" \* sabotage: the last-resort fallback is gone
  ELSE IF Variant = "Unfixed"
    THEN IF root = "open" THEN "root"
         ELSE "desktop" \* unfixed: a constructed path, existing or not
  ELSE IF root = "open" THEN "root" \* the real formula
    ELSE IF ed = "fileA" THEN "dirA"
    ELSE IF ed = "fileB" THEN "dirB"
    ELSE "home"

ValueChoice ==
  IF Variant = "Unfixed"
    THEN IF root = "open" THEN "root" ELSE "emptyRoot" \* relative to no root
  ELSE AnchorChoice(editor) \* the tracker cuts tab paths against the task anchor

\* The value base a tracker recomputes when the editor changes after task
\* start. Fixed and NoAnchorGuard derive it from the stored task anchor.
\* EditorDrift re-reads the live editor state instead: the pre-fix tracker
\* called getTaskCwdPath() on every update.
RebaseChoice ==
  IF Variant = "EditorDrift"
    THEN AnchorChoice(editor')
  ELSE IF Variant = "Unfixed"
    THEN IF root = "open" THEN "root" ELSE "emptyRoot"
  ELSE anchor \* derive the value base from the stored task anchor

SteerChoice ==
  IF Variant = "Unfixed"
    THEN IF AnchorChoice(editor) = "desktop" THEN "desktop-worded" ELSE "generic"
  ELSE "generic" \* the fixed wording never names Desktop

Init ==
  /\ root \in {"open", "none"}
  /\ editor \in {"fileA", "fileB", "none"}
  /\ desktopExists \in BOOLEAN
  /\ anchor = AnchorChoice(editor)
  /\ valueBase = ValueChoice
  /\ steer = SteerChoice

\* The user moves the active editor after the task started. The task keeps
\* its construction-time anchor; only the tracker's value base may move.
EditorChange ==
  /\ editor' \in {"fileA", "fileB", "none"}
  /\ anchor' = anchor
  /\ valueBase' = RebaseChoice
  /\ UNCHANGED <<root, desktopExists, steer>>

\* A task becomes current after values were already offered: a new task
\* starts, or a history task resumes with the workspacePath stored in its
\* history item, which can differ from the pre-task live anchor. The fixed
\* tracker republishes at activation, so the offered value base follows the
\* new stored anchor. NoActivationRefresh keeps the stale values instead.
TaskActivates(newAnchor) ==
  /\ newAnchor \in {"dirA", "dirB", "home"}
  /\ anchor' = newAnchor
  /\ valueBase' = IF Variant = "NoActivationRefresh"
                    THEN valueBase \* stale offered values survive
                    ELSE newAnchor
  /\ UNCHANGED <<root, editor, desktopExists, steer>>

Next ==
  EditorChange
  \/ (\E newAnchor \in {"dirA", "dirB", "home"}: TaskActivates(newAnchor))
  \/ UNCHANGED vars

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ root \in {"open", "none"}
  /\ editor \in {"fileA", "fileB", "none"}
  /\ desktopExists \in BOOLEAN
  /\ anchor \in {"root", "dirA", "dirB", "home", "desktop", "nowhere"}
  /\ valueBase \in {"root", "dirA", "dirB", "home", "emptyRoot", "nowhere"}
  /\ steer \in {"generic", "desktop-worded"}

\* The task never runs from a directory the system does not have.
AnchorExists == anchor \in {"root", "dirA", "dirB", "home"} \/ (anchor = "desktop" /\ desktopExists)

\* Context text names the Desktop only when the task really runs there.
NoDesktopSteer == steer # "desktop-worded" \/ (anchor = "desktop" /\ desktopExists)

\* A tab mention value resolves: it was cut against the same anchor the
\* mention resolver joins it to.
MentionRoundTrip == valueBase = anchor
====
