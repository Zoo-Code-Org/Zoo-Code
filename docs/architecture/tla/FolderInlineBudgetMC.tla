---- MODULE FolderInlineBudgetMC ----
\* Model-checking settings for FolderInlineBudget.
EXTENDS FolderInlineBudget

\* Sabotage: the code before the fix. Every readable file inlines all its
\* lines and all its characters; notes are moot. The Unfixed config swaps it
\* in with the operator override FixedStep <- UnfixedStep.
UnfixedStep ==
	/\ i <= N
	/\ Lines' = Lines
	/\ PrefixChars' = PrefixChars
	/\ shown' = [shown EXCEPT ![i] = Lines[i]]
	/\ shownChars' = [shownChars EXCEPT ![i] = TotalCharsOf(i)]
	/\ used' = used + Lines[i]
	/\ usedChars' = usedChars + TotalCharsOf(i)
	/\ noted' = [noted EXCEPT ![i] = TRUE]
	/\ i' = i + 1

\* Sabotage (PR 2680 round 5): the character rule the review flagged. The
\* step charges MinOf of the file total and the caps, so a cut can charge a
\* partial line and reach a state production never produces. The PartialCharge
\* config swaps it in with FixedStep <- PartialChargeStep; ChargeConsistentInv
\* must fail while every cap invariant still holds.
PartialChargeStep ==
	/\ i <= N
	/\ Lines' = Lines
	/\ PrefixChars' = PrefixChars
	/\ LET take == MinOf({Lines[i], PerFileCap, TotalCap - used})
	       chars == MinOf({TotalCharsOf(i), PerFileCharsCap, TotalCharsCap - usedChars})
	   IN
		/\ shown' = [shown EXCEPT ![i] = take]
		/\ shownChars' = [shownChars EXCEPT ![i] = chars]
		/\ used' = used + take
		/\ usedChars' = usedChars + chars
		/\ noted' = [noted EXCEPT ![i] = (NotesOn /\ (Lines[i] > take \/ TotalCharsOf(i) > chars))]
		/\ i' = i + 1

====
