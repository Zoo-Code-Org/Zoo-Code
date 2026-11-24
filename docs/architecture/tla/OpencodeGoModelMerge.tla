---- MODULE OpencodeGoModelMerge ----
EXTENDS Integers
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
\* Result: Fixed holds in 24 states. LiveOverride fails S1 on a curated model
\* with a live 0: [curated |-> TRUE, liveContextWindow |-> 0, liveMaxTokens |-> -1].
\* Result: UnknownIgnoresLive fails S2 on a live 0. NoLiveMaxTokens fails S3 on
\* liveMaxTokens 0. Each sabotage run fails on a live zero. Not vacuous.
\* Replay: the unfixed parseOpencodeGoModel fails 6 tests, with 200000 in
\* place of a curated 1M window. The fix passes all. No false alarm.
\* Review (PR 2646, thread 4656589514): one finding, added 1 (input rule:
\* 0 is a live value; the sentinel -1 marks absence), covered 0, gap 0.
\* Maintainer round (edelauna, review 6033833085): the endpoint publishes
\* limit.context/limit.output and modalities.input with a `type`
\* discriminator; unknown models must take the live values, and non-chat
\* types must be skipped. Added the liveShape (absent/flat/nested) and
\* modelType (chat/embedding/untyped) inputs, the Listed guard, and the
\* OnlyChatListed invariant. NoNestedLimit fails the live-merge invariants
\* on nested-only entries; NoTypeFilter fails OnlyChatListed. 0 covered,
\* 1 added, 0 gap. Fixed gate grows 24 to 150 states.
\* Cost: four TLC runs take about 4 seconds. Focused tests take about 5 seconds.
\* Agent work: about 15 minutes, including tests.
\* Not modeled: the parser, the field-name pair, capability flags, and pricing.
\* The model checks the merge contract, not the vendor facts.

CONSTANT Variant    \* "Fixed", "LiveOverride", "UnknownIgnoresLive", "NoLiveMaxTokens"

VARIABLE in

\* The live payload omits a field or reports a value. Nil is the -1 sentinel.
\* 0 is a real live value: ?? falls back only on null and undefined.
\* 200000 is the blanket value the endpoint reports for every model.
\* 2000000 is a live value larger than the registry one.
Nil == -1

\* The absent shape carries no values at all; a present shape may still
\* omit either field individually (Nil marks that field's absence).
Inputs == {i \in [curated : BOOLEAN,
           liveContextWindow : {Nil, 0, 200000, 2000000},
           liveMaxTokens : {Nil, 0, 65536},
           liveShape : {"absent", "flat", "nested"},
           modelType : {"chat", "embedding", "untyped"}] :
           (i.liveShape = "absent" => i.liveContextWindow = Nil /\ i.liveMaxTokens = Nil)}

\* Registry limits for one curated model, as deepseek-v4-flash.
CuratedContextWindow == 1000000
CuratedMaxTokens == 384000
\* Default limits for an unknown model, as opencodeGoDefaultModelInfo.
DefaultContextWindow == 200000
DefaultMaxTokens == 32768

\* One value models the context_window and context_length pair.
\* The parser reads the nested limit objects; the flat fields stay a
\* fallback. A nested-only payload loses its live values when the nested
\* read is sabotaged (NoNestedLimit).
LiveContext(i) ==
    IF i.liveShape = "absent" THEN Nil
    ELSE IF i.liveShape = "nested" /\ Variant = "NoNestedLimit" THEN Nil
    ELSE i.liveContextWindow

LiveMaxTokens(i) ==
    IF i.liveShape = "absent" THEN Nil
    ELSE IF i.liveShape = "nested" /\ Variant = "NoNestedLimit" THEN Nil
    ELSE i.liveMaxTokens

\* Fixed code: an entry whose type is present and not "chat" is skipped
\* from the catalog. Untyped entries stay listed for older responses.
\* Sabotage NoTypeFilter lists every parsed entry.
Listed(i) == ~(Variant # "NoTypeFilter" /\ i.modelType = "embedding")

PublishedContextWindow(i) ==
    IF i.curated
    THEN IF Variant = "LiveOverride" /\ LiveContext(i) # Nil
         THEN LiveContext(i)
         ELSE CuratedContextWindow
    ELSE IF LiveContext(i) = Nil \/ Variant = "UnknownIgnoresLive"
         THEN DefaultContextWindow
         ELSE LiveContext(i)

PublishedMaxTokens(i) ==
    IF i.curated
    THEN IF Variant = "NoLiveMaxTokens" \/ LiveMaxTokens(i) = Nil
         THEN CuratedMaxTokens
         ELSE LiveMaxTokens(i)
    ELSE IF LiveMaxTokens(i) = Nil
         THEN DefaultMaxTokens
         ELSE LiveMaxTokens(i)

TypeOk == in \in Inputs
\* A skipped entry never reaches the merge, so the merge contract applies
\* only to listed entries. The EXPECTED side uses the raw payload value, not
\* the read operator, so a dropped read (NoNestedLimit) cannot vacuously
\* pass by flipping both sides.
CuratedContextWindowFromRegistry ==
    Listed(in) /\ in.curated => PublishedContextWindow(in) = CuratedContextWindow
UnknownContextWindowCorrect ==
    Listed(in) /\ ~in.curated => PublishedContextWindow(in) =
        IF in.liveShape = "absent" \/ in.liveContextWindow = Nil THEN DefaultContextWindow ELSE in.liveContextWindow
CuratedLiveMaxTokensMerged ==
    Listed(in) /\ in.curated /\ in.liveShape # "absent" /\ in.liveMaxTokens # Nil =>
        PublishedMaxTokens(in) = in.liveMaxTokens
UnknownMaxTokensCorrect ==
    Listed(in) /\ ~in.curated => PublishedMaxTokens(in) =
        IF in.liveShape = "absent" \/ in.liveMaxTokens = Nil THEN DefaultMaxTokens ELSE in.liveMaxTokens

\* Maintainer round: an entry whose declared type is not "chat" is never
\* published to the picker.
OnlyChatListed == in.modelType = "embedding" => ~Listed(in)

Init == in \in Inputs
Next == UNCHANGED in
Spec == Init /\ [][Next]_in
====
