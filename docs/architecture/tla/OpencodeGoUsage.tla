---- MODULE OpencodeGoUsage ----
\* Source: OpencodeGoHandler chat-completions stream loop, chunk.usage events.
\* Sink: Task stream loop case "usage" (add to tokensIn), consolidateTokenUsage
\* (contextTokens), willManageContext (condense trigger).
\* Failure: the loop yields a usage event for every chunk that carries usage.
\* chunk.usage holds the full request totals, and Go-plan models repeat it on
\* many chunks, so the sink adds the same totals N times. tokensIn grows to
\* N chunks x prompt_tokens, contextTokens exceeds the window, and the task
\* condenses every turn (issue 1365: 280M tokens, 6M used of a 1M window).
\* First invariant: OneRequestOneUsageTotal. The sink sees one usage event per
\* request, and its totals equal the last chunk usage, never a sum.
\* Derived invariant: CondenseMatchesLastUsage. Condense triggers only when
\* the last-usage context tokens exceed the threshold (the issue symptom).
\* Oracle: the wire shape of DeepSeek usage chunks is not observable in this
\* environment (no-web rule). The fix holds under both shapes: one final
\* usage chunk (lastUsage is that chunk) and repeated per-chunk usage (the
\* last one wins). The spec models the sink contract, not the wire.
\* Expected finding: the PerChunk sabotage reproduces issue 1365. The base
\* config models the fixed code and must pass.
\* Cost: about 30 minutes of agent work; each TLC run takes seconds.
EXTENDS Naturals
CONSTANTS EmitPerChunk, MaxChunks, Usages, Threshold, NoUsage
VARIABLES left, lastU, emitted, sinkIn, sinkOut, condense, done
vars == <<left, lastU, emitted, sinkIn, sinkOut, condense, done>>

Init == /\ left \in 0..MaxChunks
        /\ lastU = NoUsage
        /\ emitted = 0
        /\ sinkIn = 0
        /\ sinkOut = 0
        /\ condense = FALSE
        /\ done = 0

\* A chunk without usage. The loop passes it through.
ChunkPlain == /\ left > 0
              /\ left' = left - 1
              /\ UNCHANGED <<lastU, emitted, sinkIn, sinkOut, condense, done>>

\* A chunk with usage. The fixed loop only stashes it. The per-chunk
\* defect also emits a usage event here, so the sink adds the totals now.
ChunkUsage(u) == /\ u \in Usages
                 /\ left > 0
                 /\ lastU' = u
                 /\ left' = left - 1
                 /\ IF EmitPerChunk
                    THEN /\ emitted' = emitted + 1
                         /\ sinkIn' = sinkIn + u.prompt
                         /\ sinkOut' = sinkOut + u.output
                    ELSE /\ UNCHANGED <<emitted, sinkIn, sinkOut>>
                 /\ UNCHANGED <<condense, done>>

\* The fixed loop emits one usage event after the stream, with last totals.
YieldUsage == /\ ~EmitPerChunk
              /\ left = 0
              /\ lastU # NoUsage
              /\ emitted = 0
              /\ emitted' = 1
              /\ sinkIn' = sinkIn + lastU.prompt
              /\ sinkOut' = sinkOut + lastU.output
              /\ UNCHANGED <<left, lastU, condense, done>>

\* The sink evaluates the condense threshold once, from recorded totals.
Evaluate == /\ left = 0
            /\ lastU = NoUsage \/ emitted >= 1
            /\ done = 0
            /\ condense' = (sinkIn + sinkOut > Threshold)
            /\ done' = 1
            /\ UNCHANGED <<left, lastU, emitted, sinkIn, sinkOut>>

Next == \/ ChunkPlain
        \/ \E u \in Usages : ChunkUsage(u)
        \/ YieldUsage
        \/ Evaluate
Spec == Init /\ [][Next]_vars

TypeOK == /\ left \in 0..MaxChunks
          /\ lastU \in Usages \cup {NoUsage}
          /\ emitted \in Nat
          /\ sinkIn \in Nat
          /\ sinkOut \in Nat
          /\ condense \in BOOLEAN
          /\ done \in {0, 1}

LastPrompt == IF lastU = NoUsage THEN 0 ELSE lastU.prompt
LastOutput == IF lastU = NoUsage THEN 0 ELSE lastU.output

\* One usage event per request; its totals equal the last chunk usage.
OneRequestOneUsageTotal == /\ emitted <= 1
                           /\ emitted = 0 => sinkIn = 0 /\ sinkOut = 0
                           /\ emitted >= 1 => sinkIn = LastPrompt /\ sinkOut = LastOutput

\* Condense matches the last-usage context tokens, not an accumulated sum.
CondenseMatchesLastUsage == done = 0 \/ (condense <=> (LastPrompt + LastOutput > Threshold))
====
