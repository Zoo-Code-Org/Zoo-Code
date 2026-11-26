---- MODULE RootlessCwdAnchor ----
\* Models the task working-directory anchor and the editor-tab mention value
\* for a VS Code session with no workspace folder open (issue 1271).
\* Source: getTaskCwdPath (src/utils/path.ts). Sinks: Task workspacePath,
\* WorkspaceTracker getOpenedTabsInfo, getEnvironmentDetails file listing and
\* getRulesSection Desktop example text. path.resolve and path.relative are
\* oracles; only the anchor choice, the value base and the wording are modeled.
\* Failure: with no workspace root the task anchors to a constructed
\* <home>/Desktop path that may not exist (a lowercase "desktop" home),
\* prompt text steers the model into it, and a tab mention value built
\* against an empty root never resolves back to the open file.
\* Invariants: AnchorExists, NoDesktopSteer, MentionRoundTrip.
\* Expect: Fixed holds in every state.
\* Expect: Unfixed fails AnchorExists (home "desktop", Desktop missing),
\* NoDesktopSteer and MentionRoundTrip.
\* Expect: NoAnchorGuard, the sabotage that removes the last-resort fallback,
\* fails AnchorExists only.
\* Result: Fixed holds in 8 states. Unfixed fails AnchorExists in 1 state,
\* with a missing Desktop, Desktop-worded steer text and an empty-root
\* mention value - the reporter's case. NoAnchorGuard fails AnchorExists
\* only. Found: the counterexample above; no unknown failure mode.
\* Replay: Task.ts anchored the workspace path to <home>/Desktop, env
\* details steered to it, and getOpenedTabsInfo cut tab paths against an
\* empty root. All three leak; a unit test pins each.
\* Not modeled: real path algebra (resolve and relative are oracles), the
\* webview suggestion UI, multi-root workspaces.
\* Cost: TLC runs in under 5 seconds per config. Agent time is not measured.
\* Review: 0 covered, 0 added, 0 gap (first version, pre-review).
\* Property test: src/utils/__tests__/path.spec.ts (mention value round-trip,
\* it.each). Caller tests: WorkspaceTracker.spec.ts, getEnvironmentDetails.spec.ts,
\* sections.spec.ts.
CONSTANT Variant \* "Fixed", "Unfixed" or "NoAnchorGuard"

VARIABLES root, editor, desktopExists, anchor, valueBase, steer

vars == <<root, editor, desktopExists, anchor, valueBase, steer>>

\* root = "open": a workspace folder exists. editor = "file": a text editor
\* tab is active. desktopExists says whether <home>/Desktop exists on this
\* system; both answers are real user systems.
AnchorChoice ==
  IF Variant = "Fixed"
    THEN IF root = "open" THEN "root"
         ELSE IF editor = "file" THEN "editorDir"
         ELSE "home"
  ELSE IF Variant = "NoAnchorGuard"
    THEN IF root = "open" THEN "root"
         ELSE IF editor = "file" THEN "editorDir"
         ELSE "nowhere" \* sabotage: the last-resort fallback is gone
  ELSE IF root = "open" THEN "root"
  ELSE "desktop" \* unfixed: a constructed path, existing or not

ValueChoice ==
  IF Variant = "Unfixed"
    THEN IF root = "open" THEN "root" ELSE "emptyRoot" \* relative to no root
  ELSE AnchorChoice \* the tracker cuts tab paths against the task anchor

SteerChoice ==
  IF Variant = "Unfixed"
    THEN IF AnchorChoice = "desktop" THEN "desktop-worded" ELSE "generic"
  ELSE "generic" \* the fixed wording never names Desktop

Init ==
  /\ root \in {"open", "none"}
  /\ editor \in {"file", "none"}
  /\ desktopExists \in BOOLEAN
  /\ anchor = AnchorChoice
  /\ valueBase = ValueChoice
  /\ steer = SteerChoice

Next == UNCHANGED vars

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ root \in {"open", "none"}
  /\ editor \in {"file", "none"}
  /\ desktopExists \in BOOLEAN
  /\ anchor \in {"root", "editorDir", "home", "desktop", "nowhere"}
  /\ valueBase \in {"root", "editorDir", "home", "emptyRoot"}
  /\ steer \in {"generic", "desktop-worded"}

\* The task never runs from a directory the system does not have.
AnchorExists == anchor \in {"root", "editorDir", "home"} \/ (anchor = "desktop" /\ desktopExists)

\* Context text names the Desktop only when the task really runs there.
NoDesktopSteer == steer # "desktop-worded" \/ (anchor = "desktop" /\ desktopExists)

\* A tab mention value resolves: it was cut against the same anchor the
\* mention resolver joins it to.
MentionRoundTrip == valueBase = anchor

====
