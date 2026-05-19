# E2E Test Fixture Workflow

E2E tests run against `@copilotkit/aimock` (`LLMock`) — a local HTTP server that replays recorded LLM responses. This makes tests free, deterministic, and CI-friendly.

Before adding an e2e test, check whether the regression can be proven with a package-local unit or integration test. E2E tests should cover real extension-host boundaries and full workflow smoke checks, not detailed assertions that belong to service, protocol, or UI component tests.

## How aimock matching works

Fixtures are matched by **substring**: `incoming_last_user_message.includes(fixture.match.userMessage)`. A fixture fires if its match string appears _anywhere_ in the last user message of the API request.

**Critical**: the last user message always contains `<environment_details>` with the current time. Never use a match string that includes a timestamp — it will stop matching on the next run.

Record mode uses **record-on-miss**: if an existing fixture already matches a request, aimock serves it and does **not** re-record. Only unmatched requests are proxied to the real API and saved as `openai-*.json` files.

## Adding a fixture for a new test

1. Write the test in `src/suite/`. Use short, stable, unique text in the task prompt.

2. Clear any stale auto-recorded files first (they accumulate across record runs):

    ```sh
    git clean -fx apps/vscode-e2e/fixtures/
    ```

    The `-x` flag is required because `openai-*.json` files are gitignored — `git clean -f` alone silently skips them.

3. Record fixtures. Use an OpenRouter key (default) or an Anthropic key (for tests that use the
   Anthropic provider directly):

    ```sh
    # OpenRouter (default — most tests)
    OPENROUTER_API_KEY=<key> pnpm --filter @roo-code/vscode-e2e test:record

    # Anthropic provider (tests that call api.setConfiguration({ apiProvider: "anthropic" }))
    # OPENROUTER_API_KEY is still required — the harness always initialises with OpenRouter.
    OPENROUTER_API_KEY=<or-key> ANTHROPIC_API_KEY=<key> TEST_FILE=my-anthropic-test.test.js pnpm --filter @roo-code/vscode-e2e test:record
    ```

    To avoid re-recording unrelated tests, filter to just your file:

    ```sh
    OPENROUTER_API_KEY=<key> TEST_FILE=my-feature.test.js pnpm --filter @roo-code/vscode-e2e test:record
    ```

    This proxies unmatched requests to the real API and writes `fixtures/openai-*.json` (OpenRouter)
    or `fixtures/anthropic-*.json` (Anthropic). Background calls from the extension will also be
    recorded — that's expected, ignore them.

4. Find the auto-recorded file for your test:

    ```sh
    grep -l "your unique prompt text" apps/vscode-e2e/fixtures/openai-*.json
    ```

5. Inspect it to find the `response` block (tool calls the LLM made).

6. Create a named fixture file, e.g. `fixtures/my-feature.json`, with a **short stable match string**:

    ```json
    {
    	"fixtures": [
    		{
    			"match": { "userMessage": "your unique prompt text" },
    			"response": {
    				"toolCalls": [
    					{ "name": "attempt_completion", "arguments": "{\"result\":\"...\"}", "id": "call_001" }
    				]
    			}
    		}
    	]
    }
    ```

    The match string should be unique enough to identify this request but contain **no timestamps, file paths, or environment details**.

7. Delete the `openai-*.json` files — they're gitignored and can't be replayed.

8. Verify in mock mode (no API key needed):
    ```sh
    pnpm --filter @roo-code/vscode-e2e test:ci:mock
    ```

## Multi-turn tests

If the LLM calls a tool first (e.g. `read_file`) and then calls `attempt_completion` after seeing the result, you need two fixtures:

- **Turn 1**: match on the task prompt (with `sequenceIndex: 0` so it fires only once) → respond with the tool call, giving the tool call a unique `id`
- **Turn 2**: match on `toolCallId` → respond with `attempt_completion`

Using `toolCallId` (the `id` of the tool call emitted in turn 1) is the recommended approach for turn-2 matching. It is:

- **Precise**: fires only when that exact tool call's result is in the conversation
- **Cross-test safe**: each test's tool call ids are unique, so accumulated match counts from previous tests can't interfere
- **Stateless**: no `sequenceIndex` needed on turn-2 fixtures — if the task makes extra API calls they'll keep getting the same `attempt_completion`

Example:

```json
{
	"fixtures": [
		{
			"match": {
				"userMessage": "my-e2e-tag:my-test",
				"sequenceIndex": 0
			},
			"response": {
				"toolCalls": [{ "name": "read_file", "arguments": "{\"path\":\"marker.txt\"}", "id": "call_my_read" }]
			}
		},
		{
			"match": { "toolCallId": "call_my_read" },
			"response": {
				"toolCalls": [
					{ "name": "attempt_completion", "arguments": "{\"result\":\"MY_MARKER\"}", "id": "call_my_done" }
				]
			}
		}
	]
}
```

The `model` field can be added to either match when a test targets a specific model.

## 404 errors in logs are expected

Background API calls from the extension (usage collection, initialization) hit aimock with no matching fixture and return 404. These do **not** affect test results — the tests still pass. You'll see `[OpenRouter] API error: { message: '404 No fixture matched' }` in the output; this is normal.

## Running tests

| Command                                                                   | Purpose                                                            |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `pnpm --filter @roo-code/vscode-e2e test:ci:mock`                         | Replay mode — no API key needed, uses fixtures                     |
| `OPENROUTER_API_KEY=<key> pnpm --filter @roo-code/vscode-e2e test:record` | Record mode — proxies to real API, writes `openai-*.json`          |
| `OPENROUTER_API_KEY=<key> pnpm --filter @roo-code/vscode-e2e test:ci`     | Real-API mode — runs against live OpenRouter (for drift detection) |

## Tests that use a fetch interceptor instead of aimock

Some suites can't redirect their provider through aimock. These suites patch `globalThis.fetch` directly — the OpenAI SDK resolves `fetch` at API client construction time (which happens lazily at task start), so installing the interceptor before `api.startNewTask()` is sufficient. Installing it before `api.setConfiguration()` (as done below) is the conservative, recommended order.

Keep fetch-interceptor suites hermetic across test cases:

- reset in-memory request/event capture in `setup()` or allocate a fresh per-test buffer instead of reusing shared mutable state implicitly
- scope request-shape assertions to the current probe or test tag only; do not pull in older requests just because they contain tool outputs
- assume late async requests from the prior task can still arrive after a shared array/map was cleared, so tags or other per-probe identity should be the source of truth
- when changing persisted provider/model settings in tests, use the path that clears prior provider fields instead of partial mutation

### Z.ai GLM (`suite/providers/zai.test.ts`)

Z.ai doesn't expose a user-configurable base URL (it uses a fixed set of regional endpoints), so we deliberately avoided adding a hidden test-only override to the schema. The suite instead patches `globalThis.fetch` to intercept requests to `api.z.ai` and return a crafted OpenAI-compatible SSE response.

The suite always runs (never skips). Set `ZAI_API_KEY` to bypass the interceptor and hit the real API instead:

```sh
# Mock mode (default — no key needed, interceptor active)
pnpm --filter @roo-code/vscode-e2e test:ci:mock

# Live mode — bypasses interceptor, calls real Z.ai API
ZAI_API_KEY=<key> TEST_FILE=zai.test pnpm --filter @roo-code/vscode-e2e test:ci
```

When adding a new test to this suite, add a matching fixture to the `installZAiFetchInterceptor` call in `suiteSetup`. Use a short unique prefix (e.g. `"zai-glm-e2e-mytest:"`) that won't appear in `<environment_details>`.

### Gemini (`suite/providers/gemini.test.ts`)

Gemini routes through aimock via `googleGeminiBaseUrl: aimockUrl`. aimock has native Gemini SSE support and can proxy to `https://generativelanguage.googleapis.com` in record mode. The model ID defaults to `gemini-3-flash-preview` but can be overridden via `GEMINI_MODEL_ID`.

The test only runs when aimock is active (replay or record). Live runs without aimock are not supported because `GEMINI_MODEL_ID` must match the fixture.

**Record** (refresh fixtures from the real Gemini API):

```sh
GEMINI_API_KEY=<key> TEST_FILE=providers/gemini.test pnpm --filter @roo-code/vscode-e2e test:record
```

After recording, inspect the generated `fixtures/gemini-*.json`, extract the response blocks into `fixtures/gemini.json`, then delete the raw files.

**Verify in mock mode** (no key needed):

```sh
TEST_FILE=providers/gemini.test pnpm --filter @roo-code/vscode-e2e test:ci:mock
```

### xAI Grok (`suite/providers/xai.test.ts`)

xAI uses the **Responses API** (`POST https://api.x.ai/v1/responses`), which is not OpenAI-compatible. aimock can't intercept it. The suite instead patches `globalThis.fetch` to intercept requests to that endpoint. By default it replays hand-crafted SSE events; when a local `fixtures/xai.json` recording exists, it can replay recorded real-API SSE events for reference.

The local `fixtures/xai.json` file is gitignored. It keeps an empty top-level `fixtures` array so aimock can scan the directory without warnings. xAI recordings live under `xaiResponses`, which maps each model ID to `{ readCallId, turn1, turn2 }`:

- **`turn1`** — raw SSE events from the real API for the first API call (should contain a `read_file` function call)
- **`readCallId`** — the `call_id` extracted from turn 1's `response.output_item.done` event; used to match the turn 2 request
- **`turn2`** — raw SSE events for the second API call (should contain an `attempt_completion` call with the correct result text)

Having real-API events in the fixture guarantees:

1. The SSE format expected by the stream processor is correct.
2. The `attempt_completion.result` field contains the actual marker value (not an empty string).

**Recording** (populate or refresh the fixture from the real xAI API):

```sh
XAI_API_KEY=<key> XAI_RECORD=true TEST_FILE=providers/xai.test.js pnpm --filter @roo-code/vscode-e2e test:run
```

This routes all xAI requests through the real API, captures the SSE events per turn, and writes the local gitignored `fixtures/xai.json` on teardown.

**Verifying the recorded fixture in mock mode** (no API key needed):

```sh
TEST_FILE=xai.test pnpm --filter @roo-code/vscode-e2e test:ci:mock
```

When no local recording exists for a model, the interceptor falls back to hand-crafted SSE events (using a hardcoded `readCallId`). CI should use this fallback so the suite remains deterministic and does not depend on large raw provider recordings.

When adding a new test to this suite, update the hand-crafted interceptor response unless the behavior specifically needs a real xAI SSE recording for local debugging. Use a short unique probe tag (e.g. `"xai-e2e:grok-4.20"`) that won't appear in `<environment_details>`.

### DeepSeek V4 (`suite/providers/deepseek-v4.test.ts`)

DeepSeek exposes `deepSeekBaseUrl`, so the suite redirects the OpenAI-compatible DeepSeek client through aimock with `deepSeekBaseUrl: ${AIMOCK_URL}/v1`. The test still installs a lightweight fetch capture for request-shape assertions, but responses should come from aimock fixtures or aimock record mode.

Record DeepSeek fixtures with the targeted file filter so aimock proxies OpenAI-compatible traffic to `https://api.deepseek.com`:

```sh
DEEPSEEK_API_KEY=<key> TEST_FILE=deepseek-v4.test pnpm --filter @roo-code/vscode-e2e test:record
```

After converting the generated `openai-*.json` files into stable named fixtures, verify in mock mode:

```sh
USE_MOCK=true TEST_FILE=deepseek-v4.test pnpm --filter @roo-code/vscode-e2e test:run
```

## Tests that use a non-default provider

If your test calls `api.setConfiguration({ apiProvider: "anthropic", ... })`, point aimock at the
Anthropic endpoint by passing `anthropicBaseUrl: aimockUrl` (without a `/v1` suffix — aimock
appends the path itself):

```typescript
await api.setConfiguration({
	apiProvider: "anthropic" as const,
	apiKey: aimockUrl && !isRecord ? "mock-key" : process.env.ANTHROPIC_API_KEY!,
	apiModelId: "claude-opus-4-7",
	...(aimockUrl && { anthropicBaseUrl: aimockUrl }),
})
```

Always restore the default OpenRouter config in `suiteTeardown` so subsequent suites are unaffected.

## Programmatic fixtures (regex matching)

For requests that can't be matched by a stable substring (e.g. "starts with `<environment_details>` but not preceded by a user message"), add a programmatic fixture in `src/runTest.ts` using `mock.addFixture()` with a `RegExp` match. These are only available in replay mode and are not recorded.
