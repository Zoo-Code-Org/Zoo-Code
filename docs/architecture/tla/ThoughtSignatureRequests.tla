---- MODULE ThoughtSignatureRequests ----
\* Source: createMessage starts a reader; old usage drains keep reading earlier generators.
\* Sink: getThoughtSignature feeds prepareApiConversationMessage for the current request.
\* Failure: an older drain replaces or clears the current signature. Invariant: RequestSignatureOwned.
\* Expect SharedLast to fail when request 1 reads after request 2 starts.
\* Scope: history for a request is prepared before another request starts. Drains can overlap.
\* Two requests and five candidate values cover empty, encoded and explicit signatures.
\* Reader parsing and usage accounting are oracles. No task lifecycle transitions are modeled.
\* Cost and replay results are recorded in ThoughtSignature.tla.
EXTENDS ThoughtSignatureStream

\* shared records the old publication for the SharedLast sabotage. The fixed view derives from readers.
VARIABLES active, readers, shared
vars == <<active, readers, shared>>
Init == /\ active = 0
        /\ readers = [r \in 1..2 |-> StreamNone]
        /\ shared = StreamNone

Start == /\ active < 2
         /\ active' = active + 1
         /\ shared' = StreamNone
         /\ UNCHANGED readers

Read(r, candidate) ==
    LET value == CaptureStream(readers[r], candidate)
    IN /\ r <= active
       /\ readers' = [readers EXCEPT ![r] = value]
       /\ shared' = value
       /\ UNCHANGED active

Next == Start \/ (\E r \in 1..2, candidate \in StreamCandidates : Read(r, candidate))
Spec == Init /\ [][Next]_vars

\* The handler points to the current request reader. Older drains can update only their own reader.
CurrentSignature == IF active = 0 THEN StreamNone ELSE readers[active]
TypeOK == active \in 0..2 /\ readers \in [1..2 -> StreamCandidates] /\ shared \in StreamCandidates
RequestSignatureOwned == active > 0 => CurrentSignature = readers[active]
====
