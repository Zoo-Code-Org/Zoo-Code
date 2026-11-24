---- MODULE LiteLLMMaxTokenParamMC ----
\* Model-checking selectors and injected defects for LiteLLMMaxTokenParam.
\* Contract, findings, and cost: see the LiteLLMMaxTokenParam header. Fixed
\* passes and the two defect variants fail.
EXTENDS LiteLLMMaxTokenParam

\* NoRouted drops the routed-backend branch — exactly the issue 1865 bug.
NoRoutedRule == req.namedGpt5 \/ req.responsesApi
\* InvertRouted sends the modern parameter for NON-OpenAI routings instead.
InvertRoutedRule == req.namedGpt5 \/ req.responsesApi \/ ~req.routedOpenAi
====
