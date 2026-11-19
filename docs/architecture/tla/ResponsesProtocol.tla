---- MODULE ResponsesProtocol ----
\* Source: OpenAiHandler.createMessage, completePrompt, and buildResponsesRequest.
\* Sinks: assertResponsesApiSuccess, getReasoningDetails, and convertToResponsesApiInput.
\* Expect to find silent terminal failure, missing replay, and stale reasoning state.
\* Failure: a bad terminal status is accepted. Rule: TerminalFailuresVisible.
\* Failure: reasoning is lost or reused from a previous request. Rules: ReplayComplete, NoStaleReasoning.
\* Failure: failed request reasoning is persisted. Rule: NoFailedReasoning.
\* Failure: a tool restriction is lost or malformed. Rule: ToolRestrictionPreserved.
\* Failure: an Azure endpoint selects the wrong client. Rule: EndpointPolicy.
\* Review PR 2498: added rules for findings 1, 2, 5, 7, 9, 10, 11.
\* Domain: compatible provider with Responses enabled. SDK events and storage are oracles.
\* The domain has two opaque reasoning items. Their contents are not parsed.
\* Manual gate: 2880 states pass. All nine sabotage configs fail with invariant error 12.
\* Each sabotage was replayed by removing its code guard and running the matching focused tests.
\* New inspection finding: use completed output order, not item arrival order, for saved reasoning.
\* Self-review ratchet: 0 covered, 2 added, 0 gap (saved order and replay oracle domain).
\* Model setup: the replay oracle domain was extended to include a reordered sample.
\* No real-code replay false alarm remains. The model does not prove the code correct.
\* Cost: each config runs in less than 1 second. Agent cost is in OpenAICompatibleResponses.tla.
\* Run with -config ResponsesProtocol.cfg ResponsesProtocolMC.tla, and repeat for each variant.
EXTENDS Naturals, Sequences
CONSTANTS ReasoningSamples, AcceptBoundary, SaveBoundary, ReplayBoundary,
          ResetBoundary, PublishFailedBoundary, ChoiceBoundary, ClientBoundary
VARIABLES source, phase, received, saved, replayed, accepted
vars == <<source, phase, received, saved, replayed, accepted>>
Domain == [status : {"completed", "failed", "incomplete", "cancelled", "error"},
           reasoning : ReasoningSamples, choice : {"none", "auto", "restricted", "malformed"},
           endpoint : {"generic", "azureLegacy", "azureV1", "inferenceLegacy", "inferenceV1"},
           explicitVersion : BOOLEAN]
ExpectedClient(s) ==
    IF s.endpoint = "inferenceLegacy" THEN "reject"
    ELSE IF s.endpoint = "azureLegacy" /\ s.explicitVersion THEN "azure"
    ELSE "plain"
Captured == SubSeq(source.reasoning, 1, received)
Init ==
    /\ source \in Domain
    /\ phase = "start"
    /\ received = 0
    /\ saved = <<"old">>
    /\ replayed = <<>>
    /\ accepted = FALSE
Reset ==
    /\ phase = "start"
    /\ phase' = "build"
    /\ saved' = ResetBoundary[saved]
    /\ UNCHANGED <<source, received, replayed, accepted>>
Build ==
    /\ phase = "build"
    /\ phase' = IF ChoiceBoundary[source.choice] = "reject" \/ ClientBoundary[source] = "reject"
                 THEN "buildFailed" ELSE "request"
    /\ UNCHANGED <<source, received, saved, replayed, accepted>>
Receive ==
    /\ phase = "request"
    /\ received < Len(source.reasoning)
    /\ received' = received + 1
    /\ UNCHANGED <<source, phase, saved, replayed, accepted>>
Finish ==
    /\ phase = "request"
    /\ source.status # "completed" \/ received = Len(source.reasoning)
    /\ phase' = "finished"
    /\ accepted' = AcceptBoundary[source.status]
    /\ saved' = IF source.status = "completed" THEN SaveBoundary[source.reasoning]
                ELSE IF PublishFailedBoundary THEN Captured ELSE <<>>
    /\ UNCHANGED <<source, received, replayed>>
Replay ==
    /\ phase = "finished"
    /\ accepted
    /\ phase' = "replayed"
    /\ replayed' = ReplayBoundary[saved]
    /\ UNCHANGED <<source, received, saved, accepted>>
Next == Reset \/ Build \/ Receive \/ Finish \/ Replay
Spec == Init /\ [][Next]_vars
TerminalFailuresVisible == phase \in {"finished", "replayed"} /\ source.status # "completed" => ~accepted
SavedComplete == phase \in {"finished", "replayed"} /\ source.status = "completed" => saved = source.reasoning
ReplayComplete == phase = "replayed" /\ source.status = "completed" => replayed = source.reasoning
NoStaleReasoning == phase \in {"build", "request", "buildFailed"} => saved = <<>>
NoFailedReasoning == phase \in {"finished", "replayed"} /\ source.status # "completed" => saved = <<>>
ToolRestrictionPreserved ==
    /\ source.choice = "restricted" => ChoiceBoundary[source.choice] = "restricted"
    /\ source.choice = "malformed" => phase \notin {"request", "finished", "replayed"}
EndpointPolicy == ClientBoundary[source] = ExpectedClient(source)
====
