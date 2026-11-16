---- MODULE MentionOrigin ----
\* Models applyEdit in src/shared/mentionSegments.ts. The webview calls it on each input event.
\* Source: text typed by the user. Sink: expandUserMentions expands each user-tagged letter.
\* Failure: a letter the user did not type is tagged user. Generated text then expands.
\* Invariant: NoGeneratedTagged. A letter tagged user is a letter the user typed.
\* It replaces a count check (user tags <= typed letters). This form implies the count check.
\* Expected before the run: the edits hold. A change of two ranges would fail with generated text between them.
\* Result, MaxLen 3: the code retagger FAILS in 3 states. The Both retagger holds in 22,990 states.
\* Not modeled: a change of two ranges in one event. It fails with either retagger. A textarea cannot send it.
\* Replay: paste "@/x" before generated "@/x", then replace the first typed "@". The generated copy turns user.
\* The finding is real in applyEdit. The fix runs the diff from both ends and keeps "u" only where both agree.
\* Property test: mentionSegments.spec.ts, "never tags a generated letter user". It fails on the old code.
\* Restore: History sets how prompt history and native undo restore a saved draft.
\* AsEdit (restore through applyEdit) fails in 3 states. Saved holds, and the history hook does this.
\* Keeping the retained tags and tagging only the new text also fails in 5 states, so undo cannot use it.
\* AllGenerated (the whole draft turns generated) holds in 26,864 states. ChatTextArea does this for historyUndo.
\* Tests: ChatTextArea.spec.tsx (history input types) and ChatView.clear-approval-buttons.spec.tsx (delete, undo, send).
\* Cost of AllGenerated: after an undo or redo the user must retype a mention that was in the draft.
\* Not modeled: normalizeSegments (the text match check), merge, trim and the host expansion.
\* Configs: MentionOrigin.cfg must pass. Must fail: .Code, .History. Must pass: .AllGenerated.
\* Cost: each run takes under 10 seconds at MaxLen 3. Agent time is not measured.
\* Review: 0 covered, 3 added (history restore, per-position form, native undo; PR 2421), 0 gap.
\* The first version came after the code and the reviews. It is not an independent first pass.
\* No review thread named the equal-letter failure. TLC found it.

EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Alphabet, MaxLen, MaxInit, Retagger, History
\* Retagger: "Code" or "Both". History: "Saved", "AsEdit" or "AllGenerated".

VARIABLES text, tags, snap   \* text: letters with true origin. tags: the "u" or "g" flag per letter.

vars == <<text, tags, snap>>

Origins == {"u", "g"}
Cell == [c : Alphabet, o : Origins]
Letters(s) == [p \in 1..Len(s) |-> s[p].c]
Seqs(S, n) == UNION {[1..k -> S] : k \in 0..n}
Min2(x, y) == IF x < y THEN x ELSE y

\* Longest common prefix and suffix of two letter lists. The suffix cannot overlap the prefix.
Pre(a, b) == CHOOSE k \in 0..Min2(Len(a), Len(b)) :
    /\ \A p \in 1..k : a[p] = b[p]
    /\ k = Min2(Len(a), Len(b)) \/ a[k+1] # b[k+1]
Suf(a, b, k) == CHOOSE m \in 0..(Min2(Len(a), Len(b)) - k) :
    /\ \A p \in 1..m : a[Len(a)-p+1] = b[Len(b)-p+1]
    /\ m = Min2(Len(a), Len(b)) - k \/ a[Len(a)-m] # b[Len(b)-m]

\* Tags for a diff. k letters keep their tags at the front. m letters keep their tags at the back.
TagsFor(oldT, newL, k, m) ==
    SubSeq(oldT, 1, k)
    \o [p \in 1..(Len(newL) - k - m) |-> "u"]
    \o SubSeq(oldT, Len(oldT) - m + 1, Len(oldT))

\* Suffix first. The prefix cannot overlap the suffix.
SufAll(a, b) == Suf(a, b, 0)
PreS(a, b, m) == CHOOSE k \in 0..(Min2(Len(a), Len(b)) - m) :
    /\ \A p \in 1..k : a[p] = b[p]
    /\ k = Min2(Len(a), Len(b)) - m \/ a[k+1] # b[k+1]

\* The code of applyEdit takes the prefix first. "Both" also takes the suffix first. It tags a letter
\* "u" only if both diffs agree.
Retag(oldL, oldT, newL) ==
    LET k == Pre(oldL, newL)
        A == TagsFor(oldT, newL, k, Suf(oldL, newL, k))
        m2 == SufAll(oldL, newL)
        B == TagsFor(oldT, newL, PreS(oldL, newL, m2), m2)
    IN  IF Retagger = "Code" THEN A
        ELSE [p \in 1..Len(A) |-> IF A[p] = "u" /\ B[p] = "u" THEN "u" ELSE "g"]

\* One edit replaces the range i+1..j with the typed letters r. Kept cells keep their origin.
Replace(s, i, j, r) ==
    SubSeq(s, 1, i) \o [p \in 1..Len(r) |-> [c |-> r[p], o |-> "u"]] \o SubSeq(s, j+1, Len(s))

Rs == Seqs(Alphabet, 2)
One(s) == UNION {UNION {{Replace(s, i, j, r) : r \in Rs} : j \in i..Len(s)} : i \in 0..Len(s)}
Edits(s) == {t \in One(s) : Len(t) <= MaxLen}

Init == \E g \in Seqs(Alphabet, MaxInit) :
    /\ text = [p \in 1..Len(g) |-> [c |-> g[p], o |-> "g"]]
    /\ tags = [p \in 1..Len(g) |-> "g"]
    /\ snap = <<>>

\* Prompt history saves the draft. ArrowDown restores it. "AsEdit" sends the restore through applyEdit.
Save == snap' = [t |-> text, g |-> tags] /\ UNCHANGED <<text, tags>>

Restore ==
    /\ snap # <<>>
    /\ Letters(snap.t) # Letters(text)
    /\ text' = snap.t
    /\ tags' = CASE History = "Saved"  -> snap.g
             [] History = "AsEdit" -> Retag(Letters(text), tags, Letters(snap.t))
             [] OTHER              -> [p \in 1..Len(snap.t) |-> "g"]
    /\ UNCHANGED snap

Change == \E t \in Edits(text) :
    /\ text' = t
    /\ tags' = Retag(Letters(text), tags, Letters(t))
    /\ UNCHANGED snap

Next == Change \/ Save \/ Restore

Spec == Init /\ [][Next]_vars

TypeOK == snap \in {<<>>} \cup [t : Seqs(Cell, MaxLen), g : Seqs(Origins, MaxLen)] /\ text \in Seqs(Cell, MaxLen) /\ tags \in Seqs(Origins, MaxLen) /\ Len(tags) = Len(text)

\* Safety: a generated letter is never tagged user. The bot thread on PR 2421 asked for this per-position form.
NoGeneratedTagged == \A p \in 1..Len(tags) : tags[p] = "u" => text[p].o = "u"

====
