# AGENTS.md (TLA+ specs)

This file applies to every file in this folder.
It tells an agent how to write and check a TLA+ spec for a change in this repo.

## Policy

1. Write a spec for each change you implement. This rule stays until the user ends it.
2. The goal is a knowledge base of how the repo works. Cost is not a reason to skip a spec.
3. Record the cost and the findings in the spec header. The user uses them to cut scope later.
4. This policy is a choice. It is not a claim that specs find more bugs than tests or reviews.

## Stance

1. Before you write a spec, write down what you expect it to find. After the run, write what it found.
2. Write the first version of each invariant before you read the review comments or the fix. Add later invariants through the review ratchet.
3. Report a null result. A spec that finds nothing new is data, not a failure.
4. Do not tune a spec until it finds a bug you already know.
5. A spec checks the model, not the code. Do not say a spec proves the code correct.

## Evidence so far

The sample is small. Do not use it as proof.

- `RequestyConsent.tla` holds in 25 states. It found no defect in the PR 2408 code.
- `UrlRedaction.tla` found a leak form that the bot comment did not name. One counterexample was a false alarm.
- In 8 PRs, 4 of 105 late bot threads sit on code that existed in round 1. About 10 percent look protocol-level by title.
- No comparison between a spec, a property test and a plain review has run.

## What to model

Write the unit tests and do the review as usual. The spec does not replace them.

| Change kind                                  | The spec models                                                      |
| -------------------------------------------- | -------------------------------------------------------------------- |
| Order of events, async work, state over time | The actions and every order of them                                  |
| A value that enters a function               | The input domain. Make the parser or callee an oracle.               |
| A setting or a config value                  | Each reader of the value and its default                             |
| None of these                                | The source and the sink. Ask what a bad value can do at each source. |

## Terms

| Term           | Meaning                                                                               |
| -------------- | ------------------------------------------------------------------------------------- |
| TLC            | The TLA+ model checker. It tries every state and checks each invariant.               |
| oracle         | A function the spec does not define. TLC tries every result. Example: `parses`.       |
| replay         | Run a counterexample on the real code. It shows if the counterexample is real.        |
| sabotage check | Remove a guard on purpose. The invariant must fail. If not, the invariant is vacuous. |
| vacuous        | True in all states because of the model, not because of the code.                     |
| gate           | The check an agent runs on each commit before the push.                               |

## Procedure

1. Search this folder for a spec of the same subsystem. If one exists, extend it.
2. Write each failure that the change must prevent as one sentence.
3. Write each invariant as the opposite of one failure.
4. Mark the source and the sink in the code. Name the line numbers.
5. Model only the source and the sink. Make every other part an oracle. Do not copy a parser.
6. Limit the input domain to values that look real. If TLC finds an input that no user can send, add a rule to remove it.
7. Run TLC on the unfixed code. If the code has no known bug, run the sabotage check. The invariant must fail.
8. Replay each counterexample on the real code. Keep the counterexamples that leak. Record the false alarms.
9. Run TLC on the fixed code. The invariant must hold.
10. Write a property test from the same invariant sentence. Run it on the real code.
11. Simplify the spec. Use the questions below.
12. Put the spec check and the property test in the gate. Run the gate on each fix commit.

## Review ratchet

A review finding is a failure that someone saw in this repo. Use each finding to grow the spec.

1. After each review round, read each finding.
2. If the spec can express the failure, add an invariant or an input rule. Cite the PR and the thread in a comment.
3. If the first version of the spec already covered the finding, write "covered" in the header.
4. If the spec cannot express the finding, write "gap" in the header and say why.
5. Run the gate on the next fix commit.

Count the "covered", "added" and "gap" results in the header. The user uses the counts to decide scope.

## Simplify questions

1. Is a variable always equal to a function of other variables? If yes, derive it. Do not store it.
2. Do two actions have the same effect? If yes, merge them.
3. Does a new variable multiply the state count? If yes, remove it or prove it is needed.
4. Do two parts of the code or of this folder repeat the same rule? If yes, keep the rule in one place.

## File layout

1. Name each spec after its subsystem. Example: `UrlRedaction.tla`.
2. Name the config that must pass `Spec.cfg`. Name each other config `Spec.Variant.cfg`, for example a sabotage run that must fail.
3. Keep every module in this folder. TLC finds the modules there.
4. Put shared operators in `Common.tla`. Extract an operator when a second spec needs it, not before.
5. Use `EXTENDS` to split one spec. Use `INSTANCE` for a module that other specs reuse.
6. Put model-checking settings in an `MC` module. Keep the spec free of them.
7. Keep each spec under 300 lines. If a spec is longer, split it by subsystem.
8. Start each spec with a comment. Name the code lines, the failure, the invariant, the cost and the findings.

Sources: [module structure](https://learning.tlapl.us/intro/module-structure/) and [MC file advice](https://discuss.tlapl.us/msg06726.html).

## Run TLC

1. Download `tla2tools.jar` to a folder outside the repo. Do not commit it.
2. Run: `java -XX:+UseParallelGC -cp <jar> tlc2.TLC -metadir <folder outside the repo> -config Spec.Variant.cfg Spec.tla`. Without `-metadir`, TLC writes a `states` folder here.
3. If the system can end, add `CHECK_DEADLOCK FALSE` to the config. Without it, TLC reports the end as a deadlock.
4. Pick the smallest constants that show the interaction. Two links are enough for interleaving.

## Rules for this folder

1. Write prose and comments in ASD-STE100. Keep each comment to one or two lines.
2. The repo has TypeScript model checks. Run `pnpm lifecycle:model-check` for lifecycle code. Read `docs/architecture/task-lifecycle-model.md` first. Do not replace these checks with a spec.
3. Follow the root `AGENTS.md` for tests and lint.
