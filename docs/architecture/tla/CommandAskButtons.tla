---- MODULE CommandAskButtons ----
\* Models the ChatView message effect (webview-ui/src/components/chat/ChatView.tsx), ask case "command".
\* Source: ExecuteCommandTool.handlePartial. It calls task.ask("command", command, block.partial) on each partial tool call.
\* Source: Task.ask. It emits the complete command ask when the tool call ends.
\* Sink: the effect sets the primary and secondary button keys (chat:runCommand.title, chat:reject.title). The pair always sets and clears together.
\* Failure 1: a partial command ask draws a Run and a Deny button that no user can use (issue 2232).
\* Failure 2: a complete command ask that waits for the user draws no buttons.
\* Invariant NoButtonsWhilePartial: opposite of failure 1. Invariant ButtonsWhenLive: opposite of failure 2.
\* ButtonsFor is the handler. The MC module holds one operator for each version of it.
\* Run: java -cp <jar> tlc2.TLC -metadir <dir> -config <Spec[.Variant].cfg> CommandAskButtonsMC.tla
\* Expect: Old fails on NoButtonsWhilePartial. NoLive fails on ButtonsWhenLive. Fixed holds.
\* Not modeled: the answered ask (the effect breaks on isAnswered before it sets buttons; a unit test covers it),
\* enableButtons (it only dims the pair; the failure is that the pair draws), other ask kinds, and the command text.
\* Cost: TLC runs in under 1 second. Agent time is not measured.

EXTENDS Naturals

CONSTANT ButtonsFor   \* For each ask state, TRUE when the effect sets the Run/Deny keys.

VARIABLES ask, buttons

\* None: no command ask. Partial: handlePartial emitted a partial ask. Live: the complete ask waits for the user.
AskStates == {"None", "Partial", "Live"}

TypeOK == /\ ask \in AskStates
          /\ buttons \in BOOLEAN

Init == /\ ask = "None"
        /\ buttons = FALSE

\* ExecuteCommandTool.handlePartial: a partial command ask arrives.
HandlePartial == /\ ask' = "Partial"
                 /\ buttons' = ButtonsFor["Partial"]

\* Task.ask: the tool call ends. The complete ask is live and unanswered.
AskComplete == /\ ask' = "Live"
               /\ buttons' = ButtonsFor["Live"]

Next == HandlePartial \/ AskComplete
Spec == Init /\ [][Next]_<<ask, buttons>>

\* Safety: no approval buttons are drawn while the command ask is partial.
NoButtonsWhilePartial == ask = "Partial" => buttons = FALSE

\* Safety: the live ask that waits for the user draws both buttons.
ButtonsWhenLive == ask = "Live" => buttons = TRUE

====
