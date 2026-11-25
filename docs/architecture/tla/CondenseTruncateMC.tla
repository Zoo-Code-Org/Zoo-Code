---- MODULE CondenseTruncateMC ----
\* Model-checking settings for CondenseTruncate.
EXTENDS CondenseTruncate

\* The actions already bound n. The constraint keeps the state count low in every config.
Bounded == n <= MaxMsgs

====
