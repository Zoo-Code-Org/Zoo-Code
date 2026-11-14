# LM Studio HTTP compatibility

Zoo Code discovers models without `@lmstudio/sdk`. It tries these endpoints in order:

| Endpoint                                | Available metadata                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /api/v1/models` (LM Studio 0.4.0+) | LLM catalog keys, vision capability, maximum context, loaded instances and runtime context |
| `GET /api/v0/models` (LM Studio 0.3.6+) | LLM/VLM IDs, vision inferred from `vlm`, maximum context                                   |
| `GET /v1/models`                        | IDs with Zoo Code's existing default metadata                                              |

HTTP 404 or 405 starts the next discovery endpoint. HTTP 200 with a body of `{"error": "<message>"}` also starts the next endpoint for the two native routes. At the final `/v1/models` endpoint, an error body fails discovery. Authentication errors, network failures, timeouts, cancellation and other invalid bodies do not.

All three discovery requests share a 15-second deadline. Explicit model loading has a separate 10-minute timeout. A failed refresh clears cached loaded-detail flags and instance aliases for that server; caller cancellation preserves them.
Settings previews do not update runtime metadata. Detected API versions are remembered per server until refresh or failure, so task preparation skips native loading for older APIs. A client load timeout or cancellation releases the local operation, but the server may still finish loading; a retry can create another instance.

Older APIs do not expose the native model-load operation; chat/JIT remains responsible for loading on those servers.

Sources: [native API changelog](https://lmstudio.ai/docs/developer/api-changelog), [legacy API reference](https://lmstudio.ai/docs/developer/rest/endpoints).

## Saved selections and instances

Saved `lmStudioModelId` values are preserved. Previous SDK discovery exposed downloaded file paths and loaded model keys, so either may be saved. A catalog miss uses default metadata and sends the original ID to chat. If chat rejects the model selection, Zoo Code asks the user to reselect a model without changing their saved setting.

Native REST catalog keys and loaded instance IDs are distinct. A separate server-scoped runtime map retains exact instance IDs as aliases; the dropdown receives only catalog keys. These aliases include custom instance names and names created before another quantization was installed. For a selected catalog key, use the instance whose ID matches the key, or the first instance in server order. For an instance alias, use that instance's context length. There is no substring or display-name mapping from legacy paths to catalog keys.

Native loading checks the selected model's `loaded_instances` first. If none exist, it posts the resolved catalog key to `/api/v1/models/load`. Concurrent callers acquire a shared operation for the normalized server URL and saved ID before discovery; discovery, loading, and cache refresh all run inside it. An unloaded model resolves only by its catalog key; instance aliases already refer to loaded models. Each caller can cancel its wait; the shared network operation is cancelled only after its last caller detaches. The shared operation is cleared on success or failure. This coordinates callers within this extension process, not other clients of the server.

## Verified migration limits

A local probe on Linux with llmster **0.0.27+1**, llama.cpp CPU runtime **2.66.0**, and SmolLM2 135M established:

- Two identical REST load calls created separate instances; loading is not idempotent.
- REST `key` matched the SDK's downloaded `modelKey`, but not its file `path`.
- Installing Q4_K_M alongside Q8_0 added quantization suffixes to catalog keys; already-loaded instances retained their previous keys/IDs.
- REST loading rejected the SDK file path with HTTP 404, but `/v1/chat/completions` accepted that same path with HTTP 200 while the model was loaded.

The chat result supports preserving legacy selections; it does not establish path compatibility across all LM Studio releases, model formats, or JIT/unloaded configurations. Legacy HTTP fallbacks have focused response-contract tests, not live coverage against historical server binaries.
