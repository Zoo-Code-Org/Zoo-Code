---- MODULE FolderInlineBudget ----
\* Models the folder-mention inline ledger for src/core/mentions/index.ts
\* (getFileOrFolderContentWithMetadata, isDirectory branch) and the pure ledger
\* assembleFolderInline in src/core/mentions/folderInlineBudget.ts.
\* Source: a folder mention "@/pkg/" lists one directory level and inlines the
\* extracted text of every readable, non-ignored top-level file. Plain files
\* come back capped by readWithSlice; binary-format extraction (.ipynb, .pdf,
\* .docx, .xlsx) returns every extracted line with no line cap and no line
\* length cap, so one huge source line can carry millions of characters.
\* Sink: the folder MentionContentBlock joined into the user message. The
\* context meter counts every line and every character in it.
\* Failure 1 (issue 1539): the folder path has no aggregate cap. One mention
\* can inline millions of extracted lines. The meter reports them and the
\* condense loop fires on every request.
\* Failure 2: one notebook with large cells can bypass the per-file line cap
\* the plain-text reader applies, because binary-format extraction has no cap.
\* Failure 3 (PR 2680 round 4): one huge extracted line passes both line caps
\* as a single line. The block then carries unbounded characters.
\* Failure 4: a file the budget skips must stay readable. Before the fix the
\* code had no budget, so no skip existed; any future ledger that drops a
\* file without naming it hides it from the model.
\* Invariant TotalCapInv: the block inlines at most PinTotal extracted lines.
\* Invariant PerFileCapInv: no file inlines more than PinPerFile lines.
\* Invariant CharTotalCapInv: the block inlines at most PinTotalChars
\* characters.
\* Invariant CharPerFileCapInv: no file inlines more than PinPerFileChars
\* characters.
\* Invariant SkippedReadable: every processed file whose content is not shown
\* in full carries a note. Files before i are processed; the final state
\* covers all.
\* Invariant AllShownAccounted: a file never shows lines or characters it
\* does not have.
\* FixedStep applies all four caps and writes notes. The sabotage step lives
\* in FolderInlineBudgetMC.tla, as the folder rules require. NoPerFile
\* removes the per-file line cap. NoCharCap removes both character caps.
\* NoPointer turns notes off.
\* Expected before the run: the MC sabotage breaks TotalCapInv and
\* PerFileCapInv (reproduction). Fixed holds all invariants. NoPerFile breaks
\* PerFileCapInv with the total line cap still holding. NoCharCap breaks both
\* character invariants with the line caps still holding. NoPointer breaks
\* SkippedReadable.
\* Oracle: Lines[i] and Chars[i], the extracted line and character counts of
\* file i. The model does not parse files or name them. The directory listing
\* is the model's file set.
\* Not modeled: line-number prefixes, ignore decisions, the partial-line tail
\* a character cut leaves out, subdirectory walks, binary detection, note
\* wording, and the read_file guidance format. Note text and its format rule
\* are code pins covered by unit tests.
\* Cost: each run takes under 2 minutes. Agent time is not measured.
\* Result: FolderInlineBudget.cfg (Fixed) holds all invariants (13500
\* states). The MC sabotage (Unfixed) breaks TotalCapInv alone (7966 states,
\* the no-cap reproduction). NoPerFile breaks PerFileCapInv with TotalCapInv
\* still holding (5401 states). NoCharCap breaks CharPerFileCapInv with the
\* line caps still holding (3394 states). NoPointer breaks SkippedReadable
\* (3394 states). Property tests in
\* core/mentions/__tests__/folderInlineBudget.spec.ts pin the same sentences.
\* Review (PR 2680 round 4): 2 covered (total and per-file line caps), 2
\* added (character caps from the oversized-line finding, note-on-char-cut in
\* SkippedReadable; MC module move per the folder rules), 1 gap (the
\* read_file guidance format is below the model's abstraction; the ledger
\* carries no path or format, so the plain-offset versus extracted-format
\* rule is pinned by unit tests in folder-mention.spec.ts).
EXTENDS Naturals

CONSTANTS
	N \* readable, non-ignored files in the folder
	, MaxLines \* max extracted lines one file can have
	, MaxChars \* max extracted characters one file can have
	, PerFileCap \* ledger cap: max lines one file may inline
	, TotalCap \* ledger cap: max lines all files may inline
	, PerFileCharsCap \* ledger cap: max characters one file may inline
	, TotalCharsCap \* ledger cap: max characters all files may inline
	, NotesOn \* TRUE when the ledger writes pointer notes
	, PinPerFile \* pinned per-file line budget the invariants require
	, PinTotal \* pinned total line budget the invariants require
	, PinPerFileChars \* pinned per-file character budget the invariants require
	, PinTotalChars \* pinned total character budget the invariants require

VARIABLES
	Lines, \* oracle: extracted line count per file
	Chars, \* oracle: extracted character count per file
	i, \* next file to process
	used, \* total inlined lines so far
	usedChars, \* total inlined characters so far
	shown, \* shown[k] = lines of file k in the block
	shownChars, \* shownChars[k] = characters of file k in the block
	noted \* noted[k] = file k carries a pointer note

vars == <<Lines, Chars, i, used, usedChars, shown, shownChars, noted>>

MinOf(S) == CHOOSE x \in S : \A y \in S : x <= y

TypeOK ==
	/\ Lines \in [1..N -> 0..MaxLines]
	/\ Chars \in [1..N -> 0..MaxChars]
	/\ i \in 1..(N + 1)
	/\ used \in Nat
	/\ usedChars \in Nat
	/\ shown \in [1..N -> Nat]
	/\ shownChars \in [1..N -> Nat]
	/\ noted \in [1..N -> BOOLEAN]

Init ==
	/\ Lines \in [1..N -> 0..MaxLines]
	/\ Chars \in [1..N -> 0..MaxChars]
	/\ i = 1
	/\ used = 0
	/\ usedChars = 0
	/\ shown = [k \in 1..N |-> 0]
	/\ shownChars = [k \in 1..N |-> 0]
	/\ noted = [k \in 1..N |-> FALSE]

FixedStep ==
	/\ i <= N
	/\ Lines' = Lines
	/\ Chars' = Chars
	/\ LET take == MinOf({Lines[i], PerFileCap, TotalCap - used})
	       chars == MinOf({Chars[i], PerFileCharsCap, TotalCharsCap - usedChars})
	   IN
		/\ shown' = [shown EXCEPT ![i] = take]
		/\ shownChars' = [shownChars EXCEPT ![i] = chars]
		/\ used' = used + take
		/\ usedChars' = usedChars + chars
		/\ noted' = [noted EXCEPT ![i] = (NotesOn /\ (Lines[i] > take \/ Chars[i] > chars))]
		/\ i' = i + 1

Done ==
	/\ i > N
	/\ Lines' = Lines
	/\ Chars' = Chars
	/\ i' = i
	/\ used' = used
	/\ usedChars' = usedChars
	/\ shown' = shown
	/\ shownChars' = shownChars
	/\ noted' = noted

Next == \/ FixedStep
	\/ Done

Spec == Init /\ [][Next]_vars

TotalCapInv == used <= PinTotal

PerFileCapInv == \A k \in 1..N : shown[k] <= PinPerFile

CharTotalCapInv == usedChars <= PinTotalChars

CharPerFileCapInv == \A k \in 1..N : shownChars[k] <= PinPerFileChars

SkippedReadable ==
	\A k \in 1..(i - 1) :
		((Lines[k] > shown[k] \/ Chars[k] > shownChars[k]) => noted[k])

AllShownAccounted ==
	\A k \in 1..N : shown[k] <= Lines[k] /\ shownChars[k] <= Chars[k]

Inv ==
	/\ TypeOK
	/\ TotalCapInv
	/\ PerFileCapInv
	/\ CharTotalCapInv
	/\ CharPerFileCapInv
	/\ SkippedReadable
	/\ AllShownAccounted

====
