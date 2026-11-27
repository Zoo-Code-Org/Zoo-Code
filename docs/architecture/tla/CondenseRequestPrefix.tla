---- MODULE CondenseRequestPrefix ----
\* Models the condense request assembly in summarizeConversation
\* (src/core/condense/index.ts) against the task request assembly in
\* recursivelyMakeClineRequests (src/core/task/Task.ts).
\* Source: the condense request builder. It picks the effective history, then
\* shapes the messages and calls createMessage.
\* Sink: apiHandler.createMessage. The provider sees (systemPrompt, messages).
\* KV caches are prefix caches: the provider reuses work only when the request
\* starts exactly like the previous request. The task request is the previous
\* request: it sends the task system prompt and the shaped history
\* (merge consecutive user messages, then clean images, then send native
\* blocks under the same tools metadata).
\* Failure (issue 2453): the condense request swapped in a condense-only
\* system prompt and converted tool blocks to text, so no part of the old
\* prefix survived. Every condense re-processed the whole context, which is
\* most expensive when the context is largest.
\* Invariant SystemStable: the condense request uses the task system prompt.
\* Invariant PrefixUnchanged: the request messages equal the task-shaped
\* history plus exactly one appended instruction message.
\* Invariant InstructionAtEnd: the instruction is the last request message.
\* Modes: Fixed mirrors the task pipeline. TextConvert is the old tool-block
\* text conversion. NoMerge skips the merge step. SystemSwap is the old
\* condense-only system prompt. InstructionFirst puts the instruction before
\* the history.
\* Expected: Fixed holds all invariants by construction; the variants give the
\* invariants their teeth. TextConvert breaks PrefixUnchanged on any history
\* that carries a tool block. NoMerge breaks PrefixUnchanged on consecutive
\* user messages. SystemSwap breaks SystemStable everywhere. InstructionFirst
\* breaks InstructionAtEnd everywhere.
\* Oracle assumption: any role and block sequence is an admissible history.
\* The over-approximation is conservative for a failure-hunting spec.
\* Not modeled: synthetic tool results (an append-only suffix, so prefix
\* safe), summary selection and condenseParent tags, token counts, the folded
\* file context, and provider-side transforms past createMessage.
\* Findings (PR 2698 round 2): Merge now merges user pairs only (added; the
\* condense call site passes roles = ["user"], thread on Merge line 60).
\* The default-template and frozen-prefix assertions are pinned in
\* prefix-cache.spec.ts (covered: the PrefixUnchanged oracle tests).
\* Cost: TLC runs each config in a few seconds.

EXTENDS Naturals, Sequences

CONSTANTS Mode, MaxMsgs, MaxBlocks, SysTask, SysCondense, SupportsImages

VARIABLES history, sys, request

Blocks == {"t", "u", "r", "i"}      \* text, tool_use, tool_result, image
Roles == {"user", "assistant"}

BSeqs == UNION {[1..n -> Blocks] : n \in 0..MaxBlocks}
Msgs == [role: Roles, blocks: BSeqs]
Histories == UNION {[1..n -> Msgs] : n \in 1..MaxMsgs}

\* Block tokens outside Blocks: "im" is an image turned into text, "tu" and
\* "tr" are tool blocks turned into text, "s" is the condense instruction.
Instr == [role |-> "user", blocks |-> <<"s">>]

\* The task request merges consecutive user messages only: the condense call
\* passes roles = ["user"], so assistant messages are never merged.
RECURSIVE Merge(_)
Merge(h) ==
    IF Len(h) <= 1 THEN h
    ELSE LET rest == Merge(SubSeq(h, 2, Len(h)))
             first == h[1]
         IN IF rest[1].role = first.role /\ first.role = "user"
            THEN <<[role |-> first.role, blocks |-> first.blocks \o rest[1].blocks]>>
                     \o SubSeq(rest, 2, Len(rest))
            ELSE <<first>> \o rest

BlockClean(b) == [j \in 1..Len(b) |-> IF b[j] = "i" THEN "im" ELSE b[j]]

\* The task request strips image blocks when the model cannot take images.
ImageClean(h) ==
    IF SupportsImages THEN h
    ELSE [i \in 1..Len(h) |-> [role |-> h[i].role, blocks |-> BlockClean(h[i].blocks)]]

TaskPipeline(h) == ImageClean(Merge(h))

\* The old condense-only conversion: tool blocks become text blocks.
BlockConvert(b) ==
    [j \in 1..Len(b) |->
        CASE b[j] = "u" -> "tu"
        []   b[j] = "r" -> "tr"
        []   OTHER      -> b[j]]

TextConvert(h) ==
    [i \in 1..Len(h) |-> [role |-> h[i].role, blocks |-> BlockConvert(h[i].blocks)]]

Build(h) ==
    CASE Mode = "Fixed" -> <<SysTask, TaskPipeline(h) \o <<Instr>>>>
    []   Mode = "TextConvert" -> <<SysTask, ImageClean(Merge(TextConvert(h))) \o <<Instr>>>>
    []   Mode = "NoMerge" -> <<SysTask, ImageClean(h) \o <<Instr>>>>
    []   Mode = "SystemSwap" -> <<SysCondense, TaskPipeline(h) \o <<Instr>>>>
    []   Mode = "InstructionFirst" -> <<SysTask, <<Instr>> \o TaskPipeline(h)>>

BlockTokens == Blocks \union {"im", "tu", "tr", "s"}

TypeOK ==
    /\ history \in Histories
    /\ sys \in {SysTask, SysCondense}
    /\ Len(request) <= MaxMsgs + 1
    /\ \A i \in 1..Len(request) :
        /\ request[i].role \in Roles
        /\ \A j \in 1..Len(request[i].blocks) : request[i].blocks[j] \in BlockTokens

Init ==
    /\ history \in Histories
    /\ sys = Build(history)[1]
    /\ request = Build(history)[2]

Next == UNCHANGED <<history, sys, request>>

Spec == Init /\ [][Next]_<<history, sys, request>>

\* The instruction must ride on the last request message.
InstructionAtEnd == request[Len(request)].blocks = <<"s">>

\* The request must start with the task system prompt.
SystemStable == sys = SysTask

\* The request must be the task-shaped history plus one appended message.
PrefixUnchanged ==
    /\ Len(request) = Len(TaskPipeline(history)) + 1
    /\ SubSeq(request, 1, Len(TaskPipeline(history))) = TaskPipeline(history)

====
