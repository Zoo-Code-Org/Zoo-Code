---- MODULE FolderInlineBudget ----
\* Models the folder-mention inline ledger for src/core/mentions/index.ts
\* (getFileOrFolderContentWithMetadata, isDirectory branch) and the pure ledger
\* assembleFolderInline in src/core/mentions/folderInlineBudget.ts.
\* Source: a folder mention "@/pkg/" lists one directory level and inlines the
\* extracted text of every readable, non-ignored top-level file. Plain files
\* come back capped by readWithSlice; binary-format extraction (.ipynb, .pdf,
\* .docx, .xlsx) returns every extracted line with no cap.
\* Sink: the folder MentionContentBlock joined into the user message. The
\* context meter counts every line in it.
\* Failure 1 (issue 1539): the folder path has no aggregate cap. One mention
\* can inline millions of extracted lines. The meter reports them and the
\* condense loop fires on every request.
\* Failure 2: one notebook with large cells can bypass the per-file line cap
\* the plain-text reader applies, because binary-format extraction has no cap.
\* Failure 3: a file the budget skips must stay readable. Before the fix the
\* code had no budget, so no skip existed; any future ledger that drops a file
\* without naming it hides it from the model.
\* Invariant TotalCapInv: the block inlines at most PinTotal extracted lines.
\* Invariant PerFileCapInv: no file inlines more than PinPerFile lines.
\* Invariant SkippedReadable: every processed file with lines not shown
\* carries a note. Files before i are processed; the final state covers all.
\* Invariant AllShownAccounted: a file never shows lines it does not have.
\* Modes: Fixed applies both caps and writes notes. Unfixed is the code before
\* the fix: every readable file inlines all its lines, notes are moot.
\* NoPerFile is Fixed with the per-file cap removed (sabotage). NoPointer is
\* Fixed with notes off (sabotage).
\* Expected before the run: Unfixed breaks TotalCapInv and PerFileCapInv
\* (reproduction). Fixed holds all invariants. NoPerFile breaks PerFileCapInv
\* with TotalCapInv still holding. NoPointer breaks SkippedReadable.
\* Oracle: Lines[i], the extracted line count of file i. The model does not
\* parse files or name them. The directory listing is the model's file set.
\* Not modeled: line-number prefixes, ignore decisions, character budgets,
\* subdirectory walks (the code reads one level), binary detection, and the
\* exact note text. Listing presence is a code pin covered by unit tests.
\* Cost: each run takes under 10 seconds. Agent time is not measured.
\* Result: FolderInlineBudget.cfg (Fixed) holds with 500 distinct states.
\* Unfixed breaks TotalCapInv (the no-cap reproduction) with 296 states.
\* NoPerFile breaks PerFileCapInv with TotalCapInv still holding (201 states).
\* NoPointer breaks SkippedReadable (201 states). Property tests in
\* core/mentions/__tests__/folderInlineBudget.spec.ts pin the same sentences.
EXTENDS Naturals

CONSTANTS
	N \* readable, non-ignored files in the folder
	, MaxLines \* max extracted lines one file can have
	, PerFileCap \* ledger cap: max lines one file may inline
	, TotalCap \* ledger cap: max lines all files may inline
	, NotesOn \* TRUE when the ledger writes pointer notes
	, PinPerFile \* pinned per-file budget the invariants require
	, PinTotal \* pinned total budget the invariants require
	, Mode \* "Fixed" or "Unfixed"

VARIABLES
	Lines, \* oracle: extracted line count per file
	i, \* next file to process
	used, \* total inlined lines so far
	shown, \* shown[k] = lines of file k in the block
	noted \* noted[k] = file k carries a pointer note

vars == <<Lines, i, used, shown, noted>>

MinOf(S) == CHOOSE x \in S : \A y \in S : x <= y

TypeOK ==
	/\ Lines \in [1..N -> 0..MaxLines]
	/\ i \in 1..(N + 1)
	/\ used \in Nat
	/\ shown \in [1..N -> Nat]
	/\ noted \in [1..N -> BOOLEAN]

Init ==
	/\ Lines \in [1..N -> 0..MaxLines]
	/\ i = 1
	/\ used = 0
	/\ shown = [k \in 1..N |-> 0]
	/\ noted = [k \in 1..N |-> FALSE]

FixedStep ==
	/\ i <= N
	/\ Lines' = Lines
	/\ LET take == MinOf({Lines[i], PerFileCap, TotalCap - used})
	   IN
		/\ shown' = [shown EXCEPT ![i] = take]
		/\ used' = used + take
		/\ noted' = [noted EXCEPT ![i] = (NotesOn /\ Lines[i] > take)]
		/\ i' = i + 1

UnfixedStep ==
	/\ i <= N
	/\ Lines' = Lines
	/\ shown' = [shown EXCEPT ![i] = Lines[i]]
	/\ used' = used + Lines[i]
	/\ noted' = [noted EXCEPT ![i] = TRUE]
	/\ i' = i + 1

Done ==
	/\ i > N
	/\ Lines' = Lines
	/\ i' = i
	/\ used' = used
	/\ shown' = shown
	/\ noted' = noted

Next == \/ (Mode = "Fixed" /\ FixedStep)
	\/ (Mode = "Unfixed" /\ UnfixedStep)
	\/ Done

Spec == Init /\ [][Next]_vars

TotalCapInv == used <= PinTotal

PerFileCapInv == \A k \in 1..N : shown[k] <= PinPerFile

SkippedReadable == \A k \in 1..(i - 1) : (Lines[k] > shown[k]) => noted[k]

AllShownAccounted == \A k \in 1..N : shown[k] <= Lines[k]

Inv ==
	/\ TypeOK
	/\ TotalCapInv
	/\ PerFileCapInv
	/\ SkippedReadable
	/\ AllShownAccounted

====
