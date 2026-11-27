---- MODULE McpToolSelectionLifecycle ----
\* Sources: McpToolSelection.select, McpToolSelection.reset, Task condensation paths, Task.initializeAttachedMcpTools.
\* Sink: the tool definitions advertised to the model.
\* Failure 1: a tool the user's latest message needs is unreachable because the selection was frozen at initialization.
\* Failure 2: condensation keeps every tool from earlier topics, so the selection grows across the whole task.
\* Failure 3: supplemental ranks continue after the search window, so the selection grows on every user message.
\* Failure 4: supplemental ranks grow the selection past the attach cap.
\* Invariant 1: TopicReachable — inside the window and below the cap, the model sees a tool for the current topic.
\* Invariant 2: PrunedSinceCondense — the selection holds at most one initial rank plus one supplement per turn
\*   since the last condensation.
\* Invariant 3: FrozenAfterWindow — after SearchTurns user turns since the last condensation, the selection does not grow.
\* Invariant 4: RollingCapped — supplemental ranks never grow the selection past MaxAttached.
\* Oracle: the ranker returns relevant tools from scope, capped at k.
\* Scope: one task with up to MaxTurns user messages. The task message is turn 1. The catalog has two topic groups.
\* Expect: NoSupplement and TaskTextRerank violate TopicReachable. NoPrune violates PrunedSinceCondense.
\*   NoFreeze violates FrozenAfterWindow. NoCap violates RollingCapped.
\* Tests: mcpToolSelection.spec.ts covers the runtime behavior.
\* Finding: the history scan must run unconditionally. A pre-feature history item has no attachedMcpToolNames
\*   but has conversation history with tool_use blocks. Guarding the scan behind `initialized` loses those names.
\* Finding: TaskTextRerank shows the re-rank after condensation must use the latest user message.
\* Simplified: `initialized` equals phase # "idle". Resume was never enabled, so it and `persisted` are removed.
\*   PersistenceRetained held in every state by construction, so it and the SaveFail config are removed.
\*   SelectionBounded follows from PrunedSinceCondense.
\* Not modeled: reload. Each condensation path calls reset before say("condense_context"), which saves
\*   attachedMcpToolNames as absent. A reload after it ranks again.
\* Finding: Condense first required model_ready. attemptApiRequest condenses between UserMessage and the tool build.
\* False alarm: FrozenAfterWindow first said selection' = selection. A Condense outside the window shrinks it.
\* Not modeled: tool order. Any change to the tools array ends the prompt cache, an append too.
\*   So order matters only for an unchanged set, and build-tools filters the catalog in a fixed order.
\* Baseline: Fixed holds. Each variant fails its invariant.
\* Cost: each config under 1 second.

EXTENDS Integers, FiniteSets

CONSTANTS
    Catalog,         \* set of all tool names
    TopicA,          \* subset of Catalog: tools relevant to topic A
    TopicB,          \* subset of Catalog: tools relevant to topic B
    InitialK,        \* max tools from initial ranking
    SupplementalK,   \* max tools from supplemental ranking per turn
    SearchTurns,     \* user turns since the last condensation that still get a supplemental rank
    MaxAttached,     \* attach cap for supplemental ranks
    MaxTurns,        \* max user turns to explore
    Variant          \* "Fixed" | "NoSupplement" | "NoPrune" | "TaskTextRerank" | "NoFreeze" | "NoCap"

VARIABLES
    selection,       \* set of tool names currently selected
    turn,            \* current user turn; the task message is turn 1
    topic,           \* current user topic: "A" or "B"
    phase,           \* "idle" (not initialized) | "needs_supplement" | "model_ready"
    condensedTurn    \* turn of the last condensation (0 = never)

vars == <<selection, turn, topic, phase, condensedTurn>>

TypeOK ==
    /\ selection \subseteq Catalog
    /\ turn \in 1..MaxTurns
    /\ topic \in {"A", "B"}
    /\ phase \in {"idle", "needs_supplement", "model_ready"}
    /\ condensedTurn \in 0..MaxTurns

Max(a, b) == IF a > b THEN a ELSE b

RelevantTools == IF topic = "A" THEN TopicA ELSE TopicB

\* The code counts the user messages after the last summary. No counter is stored.
InWindow == turn - condensedTurn <= SearchTurns

\* The task text always describes the first topic. The latest user message describes the current one.
RankQueryTools == IF Variant = "TaskTextRerank" THEN TopicA ELSE RelevantTools

RankedResult(scope, k, topicTools) ==
    LET relevant == scope \cap topicTools
    IN  IF Cardinality(relevant) <= k THEN relevant
        ELSE CHOOSE s \in SUBSET relevant : Cardinality(s) = k

\* Room is negative when InitialK exceeds MaxAttached. The code must clamp it at 0.
CapTo(s, room) ==
    IF Cardinality(s) <= Max(room, 0) THEN s
    ELSE CHOOSE t \in SUBSET s : Cardinality(t) = Max(room, 0)

Supplement ==
    LET ranked == RankedResult(Catalog \ selection, SupplementalK, RelevantTools)
    IN  CASE Variant = "NoSupplement" -> {}
          [] Variant = "NoFreeze" -> CapTo(ranked, MaxAttached - Cardinality(selection))
          [] ~InWindow -> {}
          [] Variant = "NoCap" -> ranked
          [] OTHER -> CapTo(ranked, MaxAttached - Cardinality(selection))

Init ==
    /\ selection = {}
    /\ turn = 1
    /\ topic = "A"
    /\ phase = "idle"
    /\ condensedTurn = 0

\* The initial ranking runs at task start and again after each condensation.
InitialRank ==
    /\ phase = "idle"
    /\ selection' = RankedResult(Catalog, InitialK, RankQueryTools)
    /\ phase' = "model_ready"
    /\ UNCHANGED <<turn, topic, condensedTurn>>

UserMessage ==
    /\ phase = "model_ready"
    /\ turn < MaxTurns
    /\ turn' = turn + 1
    /\ \E t \in {"A", "B"} : topic' = t
    /\ phase' = "needs_supplement"
    /\ UNCHANGED <<selection, condensedTurn>>

\* Runs in buildNativeToolsArrayWithRestrictions before the model sees tools.
SupplementalRank ==
    /\ phase = "needs_supplement"
    /\ selection' = selection \cup Supplement
    /\ phase' = "model_ready"
    /\ UNCHANGED <<turn, topic, condensedTurn>>

\* Condensation drops the selection. NoPrune leaves the selection as it is.
\* attemptApiRequest condenses after the user message and before the tool build, so needs_supplement is allowed.
Condense ==
    /\ phase \in {"model_ready", "needs_supplement"}
    /\ turn > condensedTurn
    /\ condensedTurn' = turn
    /\ IF Variant = "NoPrune"
       THEN UNCHANGED <<selection, phase>>
       ELSE /\ selection' = {}
            /\ phase' = "idle"
    /\ UNCHANGED <<turn, topic>>

Next == InitialRank \/ UserMessage \/ SupplementalRank \/ Condense

Spec == Init /\ [][Next]_vars

TopicReachable ==
    (phase = "model_ready" /\ InWindow /\ Cardinality(selection) < MaxAttached)
        => RelevantTools \cap selection # {}

PrunedSinceCondense == Cardinality(selection) <= InitialK + SupplementalK * (turn - condensedTurn)

RollingCapped == Cardinality(selection) <= Max(InitialK, MaxAttached)

FrozenAfterWindow == [][phase = "needs_supplement" /\ ~InWindow => selection' \subseteq selection]_vars

====
