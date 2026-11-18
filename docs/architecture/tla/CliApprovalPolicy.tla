---- MODULE CliApprovalPolicy ----
\* Models ExtensionHost.runTask in apps/cli/src/agent/extension-host.ts.
\* Source: the taskConfiguration argument of runTask. Sink: ClineProvider.createTask, which calls setValues.
\* Failure: a task configuration turns on autoApprovalEnabled in a host that needs manual approval.
\* Invariant: NoAutoApprovalWhenManual. The value in stored settings is the sink.
\* Run each config on CliApprovalPolicyMC.tla. The MC module holds the sabotage variant.
\* Expected before the run: the invariant holds in the model. The sabotage variant fails in 2 states.
\* Result: the invariant holds in the model in 1 state. Sabotage fails in 2 states (stored becomes TRUE).
\* The model has no task count. Each Next step sets stored from one input, so one step covers every order.
\* Not modeled: the other keys, such as alwaysAllowExecute. The master switch autoApprovalEnabled gates them.
\* Not modeled: the VS Code UI toggle. It does not use runTask.
\* Cost: TLC runs in under 1 second. Agent time is not measured.
\* Review (PR 2472): 0 covered, 3 added (Init from NonInteractive, sabotage moved to the MC module, result wording), 0 gap. The first version was written after the fix. It is not an independent first pass.

CONSTANT NonInteractive   \* TRUE when the CLI runs with the nonInteractive option

VARIABLE stored       \* autoApprovalEnabled in stored settings

\* One task input. "absent" is no key or no configuration. Both keep the stored value.
Inputs == {"absent", "on", "off"}

Init == stored = NonInteractive   \* initialSettings: an unattended host starts with TRUE

\* What runTask sends. The clamp rewrites the key to FALSE when the host needs approval.
\* No configuration is not clamped in the code. A manual host stores FALSE already, so the result is the same.
Sent(in) == IF NonInteractive THEN in ELSE "off"

\* setValues keeps the stored value when the key is missing.
Next ==
    \E in \in Inputs :
        stored' = CASE Sent(in) = "on"  -> TRUE
                    [] Sent(in) = "off" -> FALSE
                    [] OTHER            -> stored

Spec == Init /\ [][Next]_stored

TypeOK == stored \in BOOLEAN

\* Safety Rule 1: a manual host never stores autoApprovalEnabled = TRUE.
NoAutoApprovalWhenManual == ~NonInteractive => ~stored
====
