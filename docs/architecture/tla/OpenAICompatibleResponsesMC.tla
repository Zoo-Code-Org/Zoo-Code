---- MODULE OpenAICompatibleResponsesMC ----
\* Finite request boundaries stand for the SDK call. No parser is copied.
EXTENDS OpenAICompatibleResponses
CONSTANTS HonorStreaming, MergeExtra, CleanText, RouteOptIn,
          ForwardTools, ForwardReasoning, ReleaseListener, HonorLimit
RequestOracle == [s \in InputDomain |->
    [responses |-> IF RouteOptIn THEN s.responses ELSE ~s.responses,
     streaming |-> IF HonorStreaming THEN s.streaming # "off" ELSE TRUE,
     reasoning |-> IF ForwardReasoning THEN s.reasoning ELSE FALSE,
     tools |-> IF ForwardTools THEN s.tools ELSE FALSE,
     extra |-> IF MergeExtra THEN s.extra ELSE FALSE,
     badText |-> s.badText /\ ~CleanText,
     limit |-> IF ~HonorLimit /\ s.limit = "custom" THEN "default" ELSE s.limit]]
CleanupOracle == ~ReleaseListener
====
