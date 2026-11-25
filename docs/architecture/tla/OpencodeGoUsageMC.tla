---- MODULE OpencodeGoUsageMC ----
\* Model-checking selectors and the injected defect for OpencodeGoUsage.
\* Contract, findings, and cost: see the OpencodeGoUsage header.
\* Fixed passes. The PerChunk defect variant fails OneRequestOneUsageTotal.
\* The NoErrorEmit defect variant fails ErrorStillAccountsUsage.
\* ErrorAfterLastChunk.cfg is the reachability witness (must fail).
EXTENDS OpencodeGoUsage
CONSTANT Variant

MCEmitPerChunk == Variant = "PerChunk"
MCEmitOnError == Variant /= "NoErrorEmit"
MCNoUsage == [absent |-> TRUE]
MCUsages == { [prompt |-> 1, output |-> 1],
              [prompt |-> 4, output |-> 2],
              [prompt |-> 9, output |-> 3] }
MCMaxChunks == 3
MCMaxChunks1 == 1
MCThreshold == 7
====
