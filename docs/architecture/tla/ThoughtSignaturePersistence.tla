---- MODULE ThoughtSignaturePersistence ----
\* Source: an interrupted proxy stream can deliver an explicit signature during its drain.
\* Sink: Task prepares and saves the assistant history block before replay.
\* Failure: save snapshots an ID fallback before the explicit field arrives. Invariant: SavedSignatureFinal.
\* PR 2643: https://github.com/Zoo-Code-Org/Zoo-Code/pull/2643#discussion_r4660933915
\* Expect SaveBeforeDrain to fail. Replay a delayed explicit delta through the real Task request loop.
\* Oracle: the drained stream either supplies an explicit signature or ends without one.
\* Error and cancellation end the consumed stream. Transport liveness is outside this safety model.
\* Replay: two Task cases delay the drain and verify history stays pending until it settles.
\* Both fail on the old code. After release, replay gets the explicit field or the ID fallback if no field arrives.
\* Result: fixed holds (6 states). SaveBeforeDrain fails with 8 states. No additional failure was found.
\* Task waits for opted-in handlers only. Cancellation races the drain read through nextChunkWithAbort.
\* This changes stream/history ordering, not persisted task status or shared lifecycle reducers.
\* Scope: the model checks safety for consumed chunks, not provider completion or transport liveness.
\* Validation: 1,323 focused tests pass. Types, lint, formatting and both Knip checks pass. Suppression counts stay equal.
\* All three signature model gates and lifecycle:model-check pass. Each active sabotage variant fails as expected.
\* Full pnpm test hit an unrelated custom-tool timeout. That suite passes alone; pnpm test --concurrency=2 passes all 14 tasks.
\* The extension suite passes 15,527 tests. No further modeled failure was found. Cost: about 11 agent minutes.
EXTENDS Naturals

VARIABLES phase, candidate, saved
vars == <<phase, candidate, saved>>
WaitForDrain == TRUE
Init == /\ phase = "reading" /\ candidate = "encoded" /\ saved = "pending"
Stop == /\ phase = "reading" /\ phase' = "stopped" /\ UNCHANGED <<candidate, saved>>
Drain(value) == /\ phase = "stopped" /\ phase' = "drained"
                /\ candidate' = value /\ UNCHANGED saved
Save == /\ phase # "reading" /\ (phase = "drained" \/ ~WaitForDrain) /\ saved = "pending"
        /\ saved' = candidate /\ UNCHANGED <<phase, candidate>>
Next == Stop \/ (\E value \in {"encoded", "explicit"} : Drain(value)) \/ Save
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in {"reading", "stopped", "drained"}
          /\ candidate \in {"encoded", "explicit"} /\ saved \in {"pending", "encoded", "explicit"}
SavedSignatureFinal == phase = "drained" /\ saved # "pending" => saved = candidate
====
