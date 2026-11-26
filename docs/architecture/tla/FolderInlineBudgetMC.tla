---- MODULE FolderInlineBudgetMC ----
\* Model-checking settings for FolderInlineBudget.
EXTENDS FolderInlineBudget

\* Sabotage: the code before the fix. Every readable file inlines all its
\* lines and all its characters; notes are moot. The Unfixed config swaps it
\* in with the operator override FixedStep <- UnfixedStep.
UnfixedStep ==
	/\ i <= N
	/\ Lines' = Lines
	/\ Chars' = Chars
	/\ shown' = [shown EXCEPT ![i] = Lines[i]]
	/\ shownChars' = [shownChars EXCEPT ![i] = Chars[i]]
	/\ used' = used + Lines[i]
	/\ usedChars' = usedChars + Chars[i]
	/\ noted' = [noted EXCEPT ![i] = TRUE]
	/\ i' = i + 1

====
