---- MODULE MentionOrigin ----
\* Models applyEdit in src/shared/mentionSegments.ts. The webview calls it on each input event.
\* Source: text typed by the user. Sink: expandUserMentions expands each user-tagged letter.
\* Failure: a letter the user did not type is tagged user. Generated text then expands.
\* Invariant: NoGeneratedTagged. A letter tagged user is a letter the user typed.
\* It replaces a count check (user tags <= typed letters). This form implies the count check.
\* Expected before the run: the edits hold. A change of two ranges would fail with generated text between them.
\* Result, MaxLen 2: the code retagger FAILS in 2 states. The Both retagger holds in 2,193 states.
\* MaxLen 3 and MaxInit 3 give the same verdicts. The fixed run holds in 71,225 states and takes 30 seconds.
\* Not modeled: a change of two ranges in one event. It fails with either retagger. A textarea cannot send it.
\* Replay: paste "@/x" before generated "@/x", then replace the first typed "@". The generated copy turns user.
\* The finding is real in applyEdit. The fix runs the diff from both ends and keeps "u" only where both agree.
\* Property test: mentionSegments.spec.ts, "never tags a generated letter user". It fails on the old code.
\* Actions: Change (typing), Load (ArrowUp loads a stored prompt), HistoryRestoreAct (ArrowDown), UndoAct.
\* Load can have the draft's letters, and HistoryRestoreAct has no guard on them. Every order of the four runs.
\* nav is the history navigation state. Load saves the draft only when nav is false. Typing, undo and restore end nav.
\* UndoAct restores any other text, so it covers consecutive undos and redos through the whole undo stack.
\* HistoryRestore "AsEdit" (restore through applyEdit) fails in 3 states. "Saved" holds. The history hook does this.
\* UndoRestore "AsEdit" fails in 2 states. "Retained" (keep the old tags, tag the new text generated) fails in 3.
\* "AllGenerated" (the whole draft turns generated) holds. ChatTextArea does this for historyUndo and historyRedo.
\* Tests: ChatTextArea.spec.tsx (history input types) and ChatView.clear-approval-buttons.spec.tsx (delete, undo, send).
\* Cost of AllGenerated: after an undo or redo the user must retype a mention that was in the draft.
\* Not modeled: normalizeSegments (the text match check), merge, trim and the host expansion.
\* Configs: MentionOrigin.cfg must pass. Must fail: .Code, .History, .Undo, .Retained.
\* Cost: each run takes under 10 seconds at MaxLen 2. Agent time is not measured.
\* Review: 0 covered, 7 added (history restore, per-position form, native undo, one run for both restores,
\* no guard on the restore letters, navigation state, any undo target; PR 2421), 0 gap.
\* The first version came after the code and the reviews. It is not an independent first pass.
\* No review thread named the equal-letter failure. TLC found it.

EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Alphabet, MaxLen, MaxInit, Retagger, HistoryRestore, UndoRestore
\* Retagger: "Code" or "Both". HistoryRestore: "Saved" or "AsEdit".
\* UndoRestore: "AllGenerated", "Retained" or "AsEdit".

VARIABLES text, tags, snap, nav   \* text: letters with true origin. tags: the "u" or "g" flag per letter.

vars == <<text, tags, snap, nav>>

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
\* The new letters in the middle get the tag f.
TagsFor(oldT, newL, k, m, f) ==
    SubSeq(oldT, 1, k)
    \o [p \in 1..(Len(newL) - k - m) |-> f]
    \o SubSeq(oldT, Len(oldT) - m + 1, Len(oldT))

\* Suffix first. The prefix cannot overlap the suffix.
SufAll(a, b) == Suf(a, b, 0)
PreS(a, b, m) == CHOOSE k \in 0..(Min2(Len(a), Len(b)) - m) :
    /\ \A p \in 1..k : a[p] = b[p]
    /\ k = Min2(Len(a), Len(b)) - m \/ a[k+1] # b[k+1]

\* The code of applyEdit takes the prefix first. "Both" also takes the suffix first. It tags a letter
\* "u" only if both diffs agree.
Retag(oldL, oldT, newL, f) ==
    LET k == Pre(oldL, newL)
        A == TagsFor(oldT, newL, k, Suf(oldL, newL, k), f)
        m2 == SufAll(oldL, newL)
        B == TagsFor(oldT, newL, PreS(oldL, newL, m2), m2, f)
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
    /\ nav = FALSE

Now == [t |-> text, g |-> tags]

\* The user types. Typing ends history navigation (resetOnInputChange).
Change == \E t \in Edits(text) :
    /\ text' = t
    /\ tags' = Retag(Letters(text), tags, Letters(t), "u")
    /\ nav' = FALSE
    /\ UNCHANGED snap

\* ArrowUp loads a stored prompt as generated text. It can have the draft's letters.
\* It saves the draft only when navigation starts. Later loads keep the first snapshot.
Load == \E g \in Seqs(Alphabet, MaxLen) :
    /\ text' = [p \in 1..Len(g) |-> [c |-> g[p], o |-> "g"]]
    /\ tags' = [p \in 1..Len(g) |-> "g"]
    /\ snap' = IF nav THEN snap ELSE Now
    /\ nav' = TRUE

\* ArrowDown restores the saved draft and ends navigation. "AsEdit" sends the restore through applyEdit.
\* The letters can match the stored prompt, so there is no guard on them.
HistoryRestoreAct ==
    /\ nav
    /\ text' = snap.t
    /\ tags' = IF HistoryRestore = "Saved" THEN snap.g
               ELSE Retag(Letters(text), tags, Letters(snap.t), "u")
    /\ nav' = FALSE
    /\ UNCHANGED snap

\* Native undo or redo restores any other text. This covers every older state in the undo stack.
\* The browser sends no event with the old origins, so each letter can have either origin.
\* The input event ends history navigation (ChatTextArea calls resetOnInputChange).
UndoAct == \E t \in Seqs(Cell, MaxLen) :
    /\ Letters(t) # Letters(text)
    /\ text' = t
    /\ tags' = CASE UndoRestore = "AllGenerated" -> [p \in 1..Len(t) |-> "g"]
             [] UndoRestore = "Retained"    -> Retag(Letters(text), tags, Letters(t), "g")
             [] OTHER                       -> Retag(Letters(text), tags, Letters(t), "u")
    /\ nav' = FALSE
    /\ UNCHANGED snap

Next == Change \/ Load \/ HistoryRestoreAct \/ UndoAct

Spec == Init /\ [][Next]_vars

Saved == {<<>>} \cup [t : Seqs(Cell, MaxLen), g : Seqs(Origins, MaxLen)]
TypeOK == snap \in Saved /\ nav \in BOOLEAN /\ text \in Seqs(Cell, MaxLen) /\ tags \in Seqs(Origins, MaxLen) /\ Len(tags) = Len(text)

\* Safety: a generated letter is never tagged user. The bot thread on PR 2421 asked for this per-position form.
NoGeneratedTagged == \A p \in 1..Len(tags) : tags[p] = "u" => text[p].o = "u"

====
