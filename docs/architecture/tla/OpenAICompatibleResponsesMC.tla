---- MODULE OpenAICompatibleResponsesMC ----
\* Finite request boundaries stand for the SDK call. No parser is copied.
EXTENDS OpenAICompatibleResponses
CONSTANTS HonorStreaming, MergeExtra, CleanText, RouteOptIn,
          ForwardTools, ForwardReasoning, ReleaseListener, AttachAfterBuild, RouteCompletions, IsolateSubclasses
EffectiveResponses(s) == s.responses /\ (s.compatible \/ ~IsolateSubclasses)
    /\ (s.entrypoint = "message" \/ RouteCompletions)
RequestOracle == [s \in InputDomain |->
    [responses |-> IF RouteOptIn THEN EffectiveResponses(s) ELSE ~EffectiveResponses(s),
     streaming |-> IF s.entrypoint = "completion" THEN FALSE ELSE IF HonorStreaming THEN s.streaming # "off" ELSE TRUE,
     reasoning |-> IF ForwardReasoning THEN s.reasoning ELSE FALSE,
     tools |-> IF ForwardTools THEN s.tools ELSE FALSE,
     extra |-> IF MergeExtra THEN s.extra ELSE FALSE,
     badText |-> s.badText /\ ~CleanText]]
InitialListenerOracle == [s \in InputDomain |-> ~AttachAfterBuild /\ s.responses /\ s.compatible /\ s.entrypoint = "message" /\ s.signal = "live"]
CleanupOracle == [attached \in BOOLEAN |-> IF ReleaseListener THEN FALSE ELSE attached]
====
