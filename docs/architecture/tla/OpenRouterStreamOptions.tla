---
Subsystem: OpenRouter provider request construction (src/api/providers/openrouter.ts).
Source: the chat-completion call path that builds completionParams and posts it.
Sinks: the outbound request body, and the usage chunk the stream reports back.

Values modelled: the body as the SET OF FIELD NAMES it carries ("model", "stream",
"stream_options", "provider"); the stage of the call (Building, Sending, Done);
whether a usage chunk was reported.

Failure this models (lane commit 2a402d4bbf86814afecd2b6c991405bf7143f3da): this side's
request-parameter block carried stream_options: { include_usage: true }. Upstream pins
the opposite for this provider - api/providers/__tests__/openrouter-usage.spec.ts:62
asserts the request body has no stream_options property - and its own code does not
send the field. The merge kept this side's block, so the disagreement was textual-only
and survived into the merged tree.

Invariant BodyComplete is the opposite of that failure: the deletion must not take a
required field with it, so every sent body still carries model and stream.
Invariant NoStreamOptionsInBody is the contract upstream's spec asserts.
Invariant UsageReportedAtEnd is the claim the deletion depends on - that usage still
arrives when the flag is absent.

Provenance declaration: UsageArrivesWithoutFlag is a CONSTANT assumption, not a derived
fact. Its evidence is executable and outside this model (upstream's usage spec exercises
usage through the real SDK without the flag); the variant UsageNeedsFlag shows what
would break if that assumption were false, so the assumption is visible rather than
buried in the invariant.

Variants: "Fixed" = the field is not added. "SendsStreamOptions" = sabotage, restores
this side's pre-merge behaviour. Assumption variant UsageNeedsFlag sets the constant to
FALSE with the field still absent.

Result: see the FOUND block below, written after the run.

Review: accompanies the hand-authored line deletion in 2a402d4bbf; the two fields the
lane added on the cost side are modelled by arithmetic attribution that upstream tests
directly, and the merge's ledger resolution is a count fact, not a behaviour.

Cost (caliber declared before the run, read off the same run): wall clock seconds across
java invocations, one per config; agent-side writing time is excluded.

Gate: Spec.cfg must pass and every <Spec>.<Variant>.cfg must fail (governance copy of
docs/architecture/tla/AGENTS.md, blob 783837dba555c74441b1fe91e4766cd69ed5914a, line 56).
check.sh is absent at this base, so the runner reproduces the same java line and the same
two decision strings, and additionally pins which invariant each variant must violate.

EXPECTED, written here before TLC ran: "SendsStreamOptions" violates NoStreamOptionsInBody
and nothing else; "UsageNeedsFlag" (assumption set to FALSE, field still absent) violates
UsageReportedAtEnd; "Fixed" violates nothing; BodyComplete fails in no configuration,
because that is the check that the deletion took only the one field.

FOUND, written after the run: appended at the foot of this file by the run that produced
the archived output, not from memory.
---

---- MODULE OpenRouterStreamOptions ----
EXTENDS Naturals, TLC

CONSTANT Variant
CONSTANT UsageArrivesWithoutFlag

VARIABLES stage, body, usageReported

vars == <<stage, body, usageReported>>

RequiredFields == {"model", "stream"}

Init ==
  /\ stage = "Building"
  /\ body = {}
  /\ usageReported = FALSE

BuildRequest ==
  /\ stage = "Building"
  /\ stage' = "Sending"
  /\ body' = IF (Variant = "SendsStreamOptions")
              THEN (RequiredFields \cup {"stream_options"})
              ELSE RequiredFields
  /\ usageReported' = usageReported

Send ==
  /\ stage = "Sending"
  /\ stage' = "Done"
  /\ body' = body
  /\ usageReported' = IF ("stream_options" \in body)
                       THEN TRUE
                       ELSE UsageArrivesWithoutFlag

Nothing == UNCHANGED(vars)

Next == BuildRequest \/ Send \/ Nothing

Spec == Init /\ [][Next]_vars

(* The deletion removed one field; it must not have removed a required one. *)
BodyComplete == stage = "Sending" => (RequiredFields \subseteq body)

(* The contract upstream's spec pins for this provider. *)
NoStreamOptionsInBody == "stream_options" \notin body

(* The claim the deletion rests on. *)
UsageReportedAtEnd == stage = "Done" => usageReported

THEOREM Spec
=====

(* FOUND, from the run that produced the archived output (not from memory).
   Runner: WSL openjdk 21.0.13.1, tlc2.TLC from /mnt/c/tools/tla2tools.jar 2274532 B.
   ok    OpenRouterStreamOptions.cfg (pass, 3 distinct states, nothing violated)
   ok    OpenRouterStreamOptions.SendsStreamOptions.cfg (fail, 2 distinct states,
         violated exactly NoStreamOptionsInBody)
   ok    OpenRouterStreamOptions.UsageNeedsFlag.cfg (fail, 3 distinct states,
         violated exactly UsageReportedAtEnd)
   BodyComplete failed in no configuration: the deletion removed one field, no required
   one. Cost: wall clock 3.051340789 s over 3 java invocations, one per config.
   Every EXPECTED item landed and nothing else did, so no behaviour exists in the guarded
   model that the executable assertions do not already pin; the only reachable failures
   are one injected sabotage and one carried by the declared CONSTANT assumption. *)
