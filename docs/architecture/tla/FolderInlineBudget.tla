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
\* Invariant ChargeConsistentInv (PR 2680 round 5): the characters charged
\* for a file are exactly the characters of the lines shown for it. A charge
\* never splits a line, and a cut that leaves no complete line charges
\* nothing. Production keeps whole lines only (capRenderedChars); the old
\* model charged MinOf of the file total and the caps, a partial-line state
\* production never reaches.
\* Invariant SkippedReadable: every processed file whose content is not shown
\* in full carries a note. Files before i are processed; the final state
\* covers all.
\* Invariant AllShownAccounted: a file never shows lines or characters it
\* does not have.
\* FixedStep applies all four caps and charges whole lines only: it keeps the
\* longest complete-line prefix that fits the character caps and writes
\* notes. The sabotage steps live in FolderInlineBudgetMC.tla, as the folder
\* rules require. Unfixed removes every cap. PartialCharge charges a cut
\* character count that is not a whole-line prefix. NoPerFile removes the
\* per-file line cap. NoCharCap removes both character caps. NoPointer turns
\* notes off.
\* Expected before the run: the MC sabotage breaks TotalCapInv and
\* PerFileCapInv (reproduction). Fixed holds all invariants. PartialCharge
\* breaks ChargeConsistentInv alone. NoPerFile breaks PerFileCapInv with the
\* total line cap still holding. NoCharCap breaks both character invariants
\* with the line caps still holding. NoPointer breaks SkippedReadable.
\* Oracle: Lines[i], the extracted line count of file i, and PrefixChars[i],
\* the characters of the first j complete lines of file i for each j. The
\* per-line character layout is extraction's business, so TLC tries every
\* table; TotalCharsOf(i) is the file's extracted character count. The model
\* does not parse files or name them. The directory listing is the model's
\* file set.
\* Not modeled: line-number prefixes, ignore decisions, subdirectory walks,
\* binary detection, note wording, and the read_file guidance format. Note
\* text and its format rule are code pins covered by unit tests.
\* Cost: each run takes under 2 minutes. Agent time is not measured.
\* Result: FolderInlineBudget.cfg (Fixed; MaxChars=4, PerFileCharsCap=3,
\* TotalCharsCap=5) holds all invariants (13500 states). Every pin binds:
\* used reaches 4, shown reaches 2, shownChars reaches 3, and usedChars
\* reaches 5. The MC sabotage (Unfixed) breaks TotalCapInv alone (1449 states,
\* the no-cap reproduction). PartialCharge breaks ChargeConsistentInv alone
\* (578 states). NoPerFile breaks PerFileCapInv with the total line cap
\* still holding (961 states). NoCharCap breaks CharPerFileCapInv with the
\* line caps still holding (578 states). NoPointer breaks SkippedReadable
\* (578 states). Property tests in
\* core/mentions/__tests__/folderInlineBudget.spec.ts pin the same sentences.
\* Review (PR 2680 round 5): 1 added (the complete-line prefix charge: the
\* PrefixChars oracle replaces the flat Chars oracle, ChargeConsistentInv,
\* and the PartialCharge sabotage; thread on FolderInlineBudget.tla:118).
\* Review (PR 2680 round 6): 1 added (the fixed profile now exercises both
\* line guards: PerFileCharsCap=1 let FittingLines keep at most one line per
\* file, so the line pins held even when FixedStep dropped the line caps;
\* the caps are MaxChars=4, PerFileCharsCap=3, TotalCharsCap=5 with pins at
\* the cap values; thread on FolderInlineBudget.cfg:10).
\* Totals over rounds 4-6: 2 covered, 4 added, 1 gap (the read_file guidance
\* format is below the model's abstraction; the ledger carries no path or
\* format, so the plain-offset versus extracted-format rule is pinned by
\* unit tests in folder-mention.spec.ts).
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
	PrefixChars, \* oracle: PrefixChars[k][j] = characters of the first j lines of file k
	i, \* next file to process
	used, \* total inlined lines so far
	usedChars, \* total inlined characters so far
	shown, \* shown[k] = lines of file k in the block
	shownChars, \* shownChars[k] = characters of file k in the block
	noted \* noted[k] = file k carries a pointer note

vars == <<Lines, PrefixChars, i, used, usedChars, shown, shownChars, noted>>

MinOf(S) == CHOOSE x \in S : \A y \in S : x <= y

\* The characters of every complete line file k has extracted.
TotalCharsOf(k) == PrefixChars[k][Lines[k]]

\* A table is valid for `L` lines when it starts at zero, grows by one or
\* more characters per line up to `L` (every complete line costs at least its
\* newline), and freezes after `L`, so no junk states exist past a file's
\* last line. TableSet holds the tables valid for any line count, which keeps
\* the Init enumeration small.
TableOK(t, L) ==
	/\ t[0] = 0
	/\ \A j \in 1..MaxLines :
		IF j <= L
		THEN t[j] >= t[j - 1] + 1
		ELSE t[j] = t[j - 1]

TableSet == { t \in [0..MaxLines -> 0..MaxChars] : \E L \in 0..MaxLines : TableOK(t, L) }

TypeOK ==
	/\ Lines \in [1..N -> 0..MaxLines]
	/\ PrefixChars \in [1..N -> TableSet]
	/\ i \in 1..(N + 1)
	/\ used \in Nat
	/\ usedChars \in Nat
	/\ shown \in [1..N -> Nat]
	/\ shownChars \in [1..N -> Nat]
	/\ noted \in [1..N -> BOOLEAN]

Init ==
	/\ Lines \in [1..N -> 0..MaxLines]
	/\ PrefixChars \in [1..N -> TableSet]
	/\ \A k \in 1..N : TableOK(PrefixChars[k], Lines[k])
	/\ i = 1
	/\ used = 0
	/\ usedChars = 0
	/\ shown = [k \in 1..N |-> 0]
	/\ shownChars = [k \in 1..N |-> 0]
	/\ noted = [k \in 1..N |-> FALSE]

\* The longest whole-line prefix of the first `tk` lines of file `f` whose
\* characters fit `cap`. Called only when the full tk-line prefix does not
\* fit, so a fitting j exists (the empty prefix always fits) and the strict
\* per-line growth makes it unique.
FittingLines(f, tk, cap) ==
	CHOOSE j \in 0..(tk - 1) :
		/\ PrefixChars[f][j] <= cap
		/\ PrefixChars[f][j + 1] > cap

FixedStep ==
	/\ i <= N
	/\ Lines' = Lines
	/\ PrefixChars' = PrefixChars
	/\ LET take == MinOf({Lines[i], PerFileCap, TotalCap - used})
	       charCap == MinOf({PerFileCharsCap, TotalCharsCap - usedChars})
	       fit == IF PrefixChars[i][take] <= charCap
	              THEN take
	              ELSE FittingLines(i, take, charCap)
	   IN
		/\ shown' = [shown EXCEPT ![i] = fit]
		/\ shownChars' = [shownChars EXCEPT ![i] = PrefixChars[i][fit]]
		/\ used' = used + fit
		/\ usedChars' = usedChars + PrefixChars[i][fit]
		/\ noted' = [noted EXCEPT ![i] = (NotesOn /\ Lines[i] > fit)]
		/\ i' = i + 1

Done ==
	/\ i > N
	/\ Lines' = Lines
	/\ PrefixChars' = PrefixChars
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

ChargeConsistentInv == \A k \in 1..N : shownChars[k] = PrefixChars[k][shown[k]]

SkippedReadable ==
	\A k \in 1..(i - 1) :
		((Lines[k] > shown[k] \/ TotalCharsOf(k) > shownChars[k]) => noted[k])

AllShownAccounted ==
	\A k \in 1..N : shown[k] <= Lines[k] /\ shownChars[k] <= TotalCharsOf(k)

Inv ==
	/\ TypeOK
	/\ TotalCapInv
	/\ PerFileCapInv
	/\ CharTotalCapInv
	/\ CharPerFileCapInv
	/\ ChargeConsistentInv
	/\ SkippedReadable
	/\ AllShownAccounted

====
