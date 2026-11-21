---- MODULE GeminiRequestTail ----
\* Source: GeminiHandler.createMessage converts history. Sink: models.generateContentStream.
\* Failures: a request ends with a model turn; a repair removes or changes history.
\* First invariants: UserTail and HistoryPreserved. Expected finding: model-tail rejection.
\* Scope: nonempty converted text and tool turns. Conversion and API results are oracles.
\* Result: Raw fails for <<userText, modelText>>. The provider test replays this failure.
\* Fixed passes in 11 states. Raw fails in check.sh. No new bug beyond issue 1287 was found.
\* False alarms: tool results without a prior call fail conversion. Valid excludes these inputs.
\* Cost: about 5 minutes of agent work; each TLC run takes less than 1 second.
\* Review: 0 covered, 0 added, 3 gap. PR 2641, user-supplied review findings 1-3 (no thread URL supplied).
\* Gap 1: test-oracle duplication is outside the model. Tests now check the actual request properties.
\* Gap 2: reasoning-entry filtering precedes the modeled source. Provider tests cover both final roles.
\* Gap 3: evidence and header freshness are outside the state model. The manual results remain below.
\* Manual live REST replay: Vertex gemini-3.7-flash streamGenerateContent rejects the model tail (400).
\* The same history with the user continuation returns streamed candidates (200).
\* Limits: tool-response matching and empty turns are outside this model. The live replay uses REST.
\* Simplify: Request is derived. Conversion is an oracle. There is one state variable.
EXTENDS Naturals, Sequences
CONSTANTS Repair, MaxTurns
VARIABLE history
Turns == {"userText", "modelText", "modelTool", "userTool"}
Role(turn) == IF turn \in {"modelText", "modelTool"} THEN "model" ELSE "user"
Valid(h) == /\ h[1] = "userText"
            /\ \A i \in 2..Len(h) :
                  (h[i] = "userTool") = (h[i-1] = "modelTool")
Init == /\ history \in UNION { [1..n -> Turns] : n \in 1..MaxTurns }
        /\ Valid(history)
Next == UNCHANGED history
Spec == Init /\ [][Next]_history
Request == IF Repair /\ Role(history[Len(history)]) = "model"
           THEN Append(history, "userText") ELSE history
UserTail == Role(Request[Len(Request)]) = "user"
HistoryPreserved == SubSeq(Request, 1, Len(history)) = history
====
