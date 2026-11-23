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
\* Final review added premature EOF: ended means SDK EOF without a completion event.
\* Current gate: 10368 states pass; eleven sabotage configs fail with invariant error 12.
\* Review 6385d18512: expect cross-endpoint replay. Added NoForeignReasoning for finding 3.
\* Sources: saved reasoning scope. Sinks: Responses input and Chat Completions conversion.
\* Failure: reasoning reaches a different endpoint or Chat Completions.
\* Each sabotage was replayed by removing its code guard and running the matching focused tests.
\* New inspection finding: use completed output order, not item arrival order, for saved reasoning.
\* Self-review ratchet: 0 covered, 3 added, 0 gap (saved order, replay domain, and premature EOF).
\* Model setup: the replay oracle domain was extended to include a reordered sample.
\* No real-code replay false alarm remains. The model does not prove the code correct.
\* Cost: about 15 agent minutes this round; each config runs in about 1 second.
\* Simplification expectation: no new defect; one completion callback must retain snapshot and item fallback behavior.
\* Existing SavedComplete, NoFailedReasoning, and TerminalFailuresVisible rules cover this change.
\* Zoomote threads 4631255963 and 4631288743: 2 covered, 0 added, 0 gap.
\* The same-profile toggle-off replay uses the existing NoForeignReasoning rule.
\* Local fingerprint calculation adds no stored state. EndpointPolicy covers the removed duplicate Azure guard.
\* Simplification gate: all 33 TLC configs retain their pass or invariant-failure result.
\* The focused tests retain snapshot order, missing-snapshot fallback, and explicit-empty clearing.
\* No new runtime defect or replay false alarm was found. Cost: about 8 more agent minutes.
\* Run with -config ResponsesProtocol.cfg ResponsesProtocolMC.tla, and repeat for each variant.
EXTENDS Naturals, Sequences
CONSTANTS ReasoningSamples, AcceptBoundary, SaveBoundary, ReplayBoundary,
          ResetBoundary, PublishFailedBoundary, ChoiceBoundary, ClientBoundary, ReplayScopeBoundary
VARIABLES source, phase, received, saved, replayed, accepted
vars == <<source, phase, received, saved, replayed, accepted>>
Domain == [status : {"completed", "failed", "incomplete", "cancelled", "error", "ended"},
           reasoning : ReasoningSamples, choice : {"none", "auto", "restricted", "malformed"},
           endpoint : {"generic", "azureLegacy", "azureV1", "inferenceLegacy", "inferenceV1"},
           explicitVersion : BOOLEAN, destination : {"same", "other", "chat"}]
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
    /\ replayed' = IF ReplayScopeBoundary[source.destination] THEN ReplayBoundary[saved] ELSE <<>>
    /\ UNCHANGED <<source, received, saved, accepted>>
Next == Reset \/ Build \/ Receive \/ Finish \/ Replay
Spec == Init /\ [][Next]_vars
TerminalFailuresVisible == phase \in {"finished", "replayed"} /\ source.status # "completed" => ~accepted
SavedComplete == phase \in {"finished", "replayed"} /\ source.status = "completed" => saved = source.reasoning
ReplayComplete == phase = "replayed" /\ source.status = "completed" /\ source.destination = "same" => replayed = source.reasoning
NoForeignReasoning == phase = "replayed" /\ source.destination # "same" => replayed = <<>>
NoStaleReasoning == phase \in {"build", "request", "buildFailed"} => saved = <<>>
NoFailedReasoning == phase \in {"finished", "replayed"} /\ source.status # "completed" => saved = <<>>
ToolRestrictionPreserved ==
    /\ source.choice = "restricted" => ChoiceBoundary[source.choice] = "restricted"
    /\ source.choice = "malformed" => phase \notin {"request", "finished", "replayed"}
EndpointPolicy == ClientBoundary[source] = ExpectedClient(source)
====
