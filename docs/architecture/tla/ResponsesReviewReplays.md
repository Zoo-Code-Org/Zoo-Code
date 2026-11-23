# Responses review replay evidence

These are separate manual TLC and real-code checks for PR #2498. Each fixed configuration passes; each sabotage configuration fails with invariant error 12. The matching code mutation makes the named focused Vitest cases fail. This table records the correspondence; CI does not verify it automatically.

The unit files are `openai.spec.ts`, `openai-compatible-responses.spec.ts`, and `responses-api-stream.spec.ts`. Ownership value cases also live in `responses-api-contract.spec.ts`.

| Model configuration                                | Focused test title or pattern                            |
| -------------------------------------------------- | -------------------------------------------------------- |
| `OpenAICompatibleResponses.EarlyAttach.cfg`        | `does not attach a listener`                             |
| `OpenAICompatibleResponses.NoCleanup.cfg`          | `releases the listener`                                  |
| `OpenAICompatibleResponses.NoCompletion.cfg`       | `routes single completions`                              |
| `OpenAICompatibleResponses.NoExtra.cfg`            | `preserves streaming=`                                   |
| `OpenAICompatibleResponses.NoIsolation.cfg`        | `isolates the inherited`                                 |
| `OpenAICompatibleResponses.NoReasoning.cfg`        | `preserves routing, tools`                               |
| `OpenAICompatibleResponses.NoRoute.cfg`            | `preserves routing, tools`                               |
| `OpenAICompatibleResponses.NoSanitize.cfg`         | `sends well-formed prompt`                               |
| `OpenAICompatibleResponses.NoStreaming.cfg`        | `preserves streaming=`                                   |
| `OpenAICompatibleResponses.NoTools.cfg`            | `preserves routing, tools`                               |
| `ResponsesRequestParameters.NoLimit.cfg`           | `output limit defaults`                                  |
| `ResponsesRequestParameters.NoNullParameters.cfg`  | `API defaults for tools`                                 |
| `ResponsesRequestParameters.NoNullStrict.cfg`      | `API defaults for tools`                                 |
| `ResponsesRequestParameters.NoStrict.cfg`          | `strict-schema setting or preserves request invariants`  |
| `ResponsesRequestParameters.NoTemperature.cfg`     | `temperature capability`                                 |
| `ResponsesRequestParameters.NoTimeout.cfg`         | `normalizes completion timeout`                          |
| `ResponsesRequestParameters.NoZeroLimit.cfg`       | `output limit defaults`                                  |
| `ResponsesRequestParameters.NoZeroTemperature.cfg` | `temperature capability`                                 |
| `ResponsesProtocol.NoCapture.cfg`                  | `round-trips all encrypted`                              |
| `ResponsesProtocol.NoFailureGuard.cfg`             | `rejects terminal / Responses terminal failure contract` |
| `ResponsesProtocol.NoForeign.cfg`                  | `switching endpoint`                                     |
| `ResponsesProtocol.NoInferenceGuard.cfg`           | `rejects the legacy Azure`                               |
| `ResponsesProtocol.NoOrder.cfg`                    | `round-trips all encrypted`                              |
| `ResponsesProtocol.NoReplay.cfg`                   | `round-trips all encrypted`                              |
| `ResponsesProtocol.NoReset.cfg`                    | `clears prior reasoning`                                 |
| `ResponsesProtocol.NoRestriction.cfg`              | `allowed_tools mode or malformed function restrictions`  |
| `ResponsesProtocol.NoTerminal.cfg`                 | `rejects EOF without`                                    |
| `ResponsesProtocol.OldAzureDefault.cfg`            | `uses Azure v1 for Responses`                            |
| `ResponsesProtocol.PublishFailed.cfg`              | `clears prior reasoning`                                 |

`ResponsesProtocol.NoForeign.cfg` also corresponds to the `NoChatFilter` code mutation, rejected by `switching chat`. The ownership table exercises matching and mismatched endpoints, mismatched providers, missing ownership, and the other Responses consumers that supply no OpenAI ownership scope.

`OpenAICompatibleResponses.Unfixed.cfg` remains a negative routing baseline. It fails independently of the 29 single-guard sabotage configurations. The initial unfixed implementation failed 24 focused regression cases at the previous review.

The latest code mutation run rejected 30 mutations: one for each sabotage configuration and a second transport boundary for `NoForeign`. It includes DeepSeek in the inherited-flag mutation. Fixed models explored 6,912 routing states, 19,440 parameter states, and 10,368 protocol states. No additional runtime defect or replay false alarm was found by the expanded models.

## Review of temperature and history IDs

PR #2498 threads [4638668706](https://github.com/Zoo-Code-Org/Zoo-Code/pull/2498#discussion_r4638668706), [4638668716](https://github.com/Zoo-Code-Org/Zoo-Code/pull/2498#discussion_r4638668716), and [4644389836](https://github.com/Zoo-Code-Org/Zoo-Code/pull/2498#discussion_r4644389836) add three input rules. The code fixes were already in `fbf1f233d` and `8dc519673`. This round adds model and property coverage.

| Model configuration                                 | Real-code mutation                                    | Property test pattern                  |
| --------------------------------------------------- | ----------------------------------------------------- | -------------------------------------- |
| `ResponsesRequestParameters.NoOSeries.cfg`          | Disable the final o-series temperature branch         | `removes o-series temperature`         |
| `ResponsesRequestParameters.NoExtraTemperature.cfg` | Restore Extra Body temperature in the o-series branch | `removes o-series temperature`         |
| `ResponsesRequestParameters.NoCallId.cfg`           | Remove truncation from `tool_use.id`                  | `keeps history IDs bounded and paired` |
| `ResponsesRequestParameters.NoResultId.cfg`         | Remove truncation from `tool_result.tool_use_id`      | `keeps history IDs bounded and paired` |

All four code mutations fail assertions. The code was restored after each replay. The properties cover 108 temperature combinations and 28 history IDs. They check zero, unset values, model capability, ordinary-model precedence, short IDs, the 64-character boundary, long IDs, surrogate expansion, pairing, and unchanged history.

The expanded parameter model has 233,280 distinct states. All 37 Responses configurations were run: three fixed configurations pass, 33 sabotage configurations fail with invariant error 12, and the older unfixed configuration also fails with error 12. No new runtime defect or replay false alarm was found. These results supersede the earlier parameter state count and configuration totals above. The model uses opaque normalized IDs; it does not establish hash collision freedom or validate model-name recognition.

The runtime refactor resolves temperature only after the Extra Body merge and uses `normalizeHistoryCallId` for both history fields. All four code mutations were repeated against this version and rejected by assertions. Ordinary models retain configured-value precedence and Extra Body fallback. The existing invariants cover this refactor; no new invariant or runtime defect was found.
