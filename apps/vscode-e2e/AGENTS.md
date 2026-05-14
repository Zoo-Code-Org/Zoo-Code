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
