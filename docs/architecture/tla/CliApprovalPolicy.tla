---- MODULE CliApprovalPolicy ----
\* Models ExtensionHost.runTask in apps/cli/src/agent/extension-host.ts.
\* Source: the taskConfiguration argument of runTask. Sink: ClineProvider.createTask, which calls setValues.
\* Failure: a task configuration turns on autoApprovalEnabled in a host that needs manual approval.
\* Invariant: NoAutoApprovalWhenManual. The value in stored settings is the sink.
\* Expected before the run: Clamp holds. None fails in 2 states.
\* Result: Clamp holds in 1 state. None fails in 2 states (stored becomes TRUE). NonInteractive holds in 2 states.
\* The model has no task count. Each RunTask step sets stored from one input, so one step covers every order.
\* Not modeled: the other keys, such as alwaysAllowExecute. The master switch autoApprovalEnabled gates them.
\* Not modeled: the VS Code UI toggle. It does not use runTask.
\* Cost: TLC runs in under 1 second. Agent time is not measured.
\* Review: 0 covered, 0 added, 0 gap. The first version was written after the fix. It is not an independent first pass.

CONSTANTS
    NonInteractive,   \* TRUE when the CLI runs with the nonInteractive option
    Variant           \* "Clamp" is the code. "None" is the sabotage check.

VARIABLE stored       \* autoApprovalEnabled in stored settings

\* One task input. "absent" is a configuration without the key. "no config" is no configuration.
Inputs == {"no config", "absent", "true", "false"}

Init == stored = FALSE   \* initialSettings: manual host starts with FALSE

\* What runTask sends. Clamp rewrites the key to FALSE when the host needs approval.
Sent(in) ==
    IF Variant = "Clamp" /\ ~NonInteractive /\ in # "no config"
    THEN "false"
    ELSE in

\* setValues keeps the stored value when the key is missing.
Apply(in) ==
    CASE Sent(in) = "true"  -> TRUE
      [] Sent(in) = "false" -> FALSE
      [] OTHER              -> stored

RunTask == \E in \in Inputs : stored' = Apply(in)

Next == RunTask
Spec == Init /\ [][Next]_stored

TypeOK == stored \in BOOLEAN

\* Safety Rule 1: a manual host never stores autoApprovalEnabled = TRUE.
NoAutoApprovalWhenManual == ~NonInteractive => ~stored
====
