# LM Studio HTTP compatibility

Zoo Code discovers models without `@lmstudio/sdk`. It tries these endpoints in order:

| Endpoint                                | Available metadata                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /api/v1/models` (LM Studio 0.4.0+) | Catalog keys, vision capability, maximum context, loaded instances and runtime context |
| `GET /api/v0/models` (LM Studio 0.3.6+) | LLM/VLM IDs, vision inferred from `vlm`, maximum context                               |
| `GET /v1/models`                        | IDs with default metadata                                                              |

HTTP 404 or 405 starts the next endpoint. A native route can also return HTTP 200 with an error string in its body. This response starts the next endpoint. An error body from `/v1/models` fails discovery. Authentication errors, network failures, timeouts, cancellation and other invalid bodies stop discovery.

All discovery requests share a 15-second deadline. Model loading has a separate 10-minute timeout. Load timeouts produce a specific error message. Caller cancellation does not produce an error log. A fallback warning appears once per server URL and includes the reason.

A failed refresh clears the server's loaded-detail flags and instance aliases. Caller cancellation preserves them. Each refresh takes a ticket when it starts. A refresh that settles after a newer one cannot change this metadata. Settings previews cannot change runtime metadata, even when they fail.

Detected API versions are remembered per server until refresh or failure. Task preparation skips native loading for older APIs. Discovery still checks newer endpoints during later catalog refreshes. Missing models and incomplete details have a 30-second preparation retry delay. A committed catalog refresh clears this delay. Network and load failures permit an immediate retry.

A client timeout or cancellation releases the local operation. The server can still finish loading. A retry can create another instance. Older APIs leave loading to chat or JIT.

Sources: [native API changelog](https://lmstudio.ai/docs/developer/api-changelog), [legacy API reference](https://lmstudio.ai/docs/developer/rest/endpoints).

## Saved selections and instances

Saved `lmStudioModelId` values are preserved. Previous SDK discovery exposed downloaded file paths and loaded model keys. Either form can be saved. A catalog miss uses default metadata and sends the original ID to chat. If chat rejects the selection, Zoo Code asks the user to select a model again. It does not change the saved setting.

Native catalog keys and loaded instance IDs are distinct. A server-scoped runtime map retains exact instance IDs as aliases. The dropdown receives only catalog keys. Aliases include custom names and IDs created before another quantization was installed.

For a catalog key, Zoo Code uses the instance with a matching ID. If none matches, it uses the first instance in server order. An instance alias uses that instance's context length. The native catalog does not provide SDK file paths. Zoo Code does not infer path aliases from display names or quantization names.

Loading checks `loaded_instances` first. If none exist, Zoo Code posts the catalog key to `/api/v1/models/load`. Concurrent callers share one operation for each normalized server URL and saved ID. Discovery, loading and cache refresh run inside this operation.

Each caller can cancel its wait. The network operation stops only after the last caller leaves. The shared operation ends on success or failure. This coordinates this extension process only.

Discovery before a load prevents duplicate instances. Discovery after a load reads the runtime context length. The latter refresh waits for any earlier cache flight before it requests the new catalog. It cannot reuse a catalog request from before the load.

## Verified migration limits

A Linux probe used llmster **0.0.27+1**, llama.cpp CPU runtime **2.66.0**, and SmolLM2 135M. It established these limits:

- Two identical REST load calls created separate instances. Loading is not idempotent.
- REST `key` matched the SDK's downloaded `modelKey`. It did not match its file `path`.
- Installing Q4_K_M alongside Q8_0 added quantization suffixes to catalog keys. Existing instances kept their previous IDs.
- REST loading rejected the SDK file path with HTTP 404. Chat accepted that path with HTTP 200 while the model was loaded.

The chat result supports preserving legacy selections. It does not establish path support across releases, formats or unloaded models. Legacy fallbacks have response-contract tests. They do not have live coverage against historical server binaries.
