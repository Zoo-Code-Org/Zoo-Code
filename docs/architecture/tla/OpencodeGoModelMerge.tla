---- MODULE OpencodeGoModelMerge ----
\* Source: parseOpencodeGoModel (src/api/providers/fetchers/opencode-go.ts).
\* Sink: ModelInfo.contextWindow published by getOpencodeGoModels for the model picker.
\* Failure: a curated model gets its registry contextWindow replaced by the live
\* context_window value. The Go endpoint reports a blanket 200000 (issue 723).
\* Invariant sentences came before the model and before the fix:
\* S1 a registry model must keep the registry contextWindow.
\* S2 an unknown model must keep the live value, and the default when absent.
\* S3 a registry model must still take a live max-token value.
\* S4 an unknown model must keep the live max-token rule and the default.
\* Invariants: CuratedContextWindowFromRegistry, UnknownContextWindowCorrect,
\* CuratedLiveMaxTokensMerged, UnknownMaxTokensCorrect.
\* Expect: Fixed holds. LiveOverride models the old code and must fail S1.
\* Expect: UnknownIgnoresLive fails S2. NoLiveMaxTokens fails S3.
\* Result: Fixed holds in 12 states. LiveOverride fails S1 on a curated model
\* with the blanket 200000: [curated |-> TRUE, liveContextWindow |-> 200000].
\* Result: UnknownIgnoresLive fails S2. NoLiveMaxTokens fails S3. Not vacuous.
\* Replay: the unfixed parseOpencodeGoModel fails 6 tests, with 200000 in
\* place of a curated 1M window. The fix passes all. No false alarm.
\* Review: 0 covered, 0 added, 0 gap. No review round has run yet.
\* Cost: four TLC runs take about 4 seconds. Focused tests take about 5 seconds.
\* Agent work: about 15 minutes, including tests.
\* Not modeled: the parser, the field-name pair, capability flags, and pricing.
\* The model checks the merge contract, not the vendor facts.

CONSTANT Variant    \* "Fixed", "LiveOverride", "UnknownIgnoresLive", "NoLiveMaxTokens"

VARIABLE in

\* The live payload omits a field or reports a value. Nil is 0, not a real limit.
\* 200000 is the blanket value the endpoint reports for every model.
\* 2000000 is a live value larger than the registry one.
Inputs == [curated : BOOLEAN,
           liveContextWindow : {0, 200000, 2000000},
           liveMaxTokens : {0, 65536}]

\* Registry limits for one curated model, as deepseek-v4-flash.
CuratedContextWindow == 1000000
CuratedMaxTokens == 384000
\* Default limits for an unknown model, as opencodeGoDefaultModelInfo.
DefaultContextWindow == 200000
DefaultMaxTokens == 32768

Nil == 0

\* One value models the context_window and context_length pair.
PublishedContextWindow(i) ==
    IF i.curated
    THEN IF Variant = "LiveOverride" /\ i.liveContextWindow # Nil
         THEN i.liveContextWindow
         ELSE CuratedContextWindow
    ELSE IF i.liveContextWindow = Nil \/ Variant = "UnknownIgnoresLive"
         THEN DefaultContextWindow
         ELSE i.liveContextWindow

PublishedMaxTokens(i) ==
    IF i.curated
    THEN IF Variant = "NoLiveMaxTokens" \/ i.liveMaxTokens = Nil
         THEN CuratedMaxTokens
         ELSE i.liveMaxTokens
    ELSE IF i.liveMaxTokens = Nil
         THEN DefaultMaxTokens
         ELSE i.liveMaxTokens

TypeOk == in \in Inputs
CuratedContextWindowFromRegistry ==
    in.curated => PublishedContextWindow(in) = CuratedContextWindow
UnknownContextWindowCorrect ==
    ~in.curated => PublishedContextWindow(in) =
        IF in.liveContextWindow = Nil THEN DefaultContextWindow ELSE in.liveContextWindow
CuratedLiveMaxTokensMerged ==
    in.curated /\ in.liveMaxTokens # Nil => PublishedMaxTokens(in) = in.liveMaxTokens
UnknownMaxTokensCorrect ==
    ~in.curated => PublishedMaxTokens(in) =
        IF in.liveMaxTokens = Nil THEN DefaultMaxTokens ELSE in.liveMaxTokens

Init == in \in Inputs
Next == UNCHANGED in
Spec == Init /\ [][Next]_in
====
