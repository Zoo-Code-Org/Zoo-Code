# E2E Test Fixture Workflow

E2E tests run against `@copilotkit/aimock` (`LLMock`) — a local HTTP server that replays recorded LLM responses. This makes tests free, deterministic, and CI-friendly.

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

3. Record fixtures (requires an OpenRouter API key with credits):

    ```sh
    OPENROUTER_API_KEY=<key> pnpm --filter @roo-code/vscode-e2e test:record
    ```

    This proxies unmatched requests to OpenRouter and writes `fixtures/openai-*.json`. Background
    calls from the extension will also be recorded here — that's expected, ignore them.

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

- **Turn 1**: match on the task prompt → respond with the tool call
- **Turn 2**: match on a stable part of the tool _result_ → respond with `attempt_completion`

The tool result is provided by the extension (not the mock), so its content is deterministic if test files have stable names. Use a stable substring from the tool result as the turn-2 match string.

## 404 errors in logs are expected

Background API calls from the extension (usage collection, initialization) hit aimock with no matching fixture and return 404. These do **not** affect test results — the tests still pass. You'll see `[OpenRouter] API error: { message: '404 No fixture matched' }` in the output; this is normal.

## Running tests

| Command                                                                   | Purpose                                                            |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `pnpm --filter @roo-code/vscode-e2e test:ci:mock`                         | Replay mode — no API key needed, uses fixtures                     |
| `OPENROUTER_API_KEY=<key> pnpm --filter @roo-code/vscode-e2e test:record` | Record mode — proxies to real API, writes `openai-*.json`          |
| `OPENROUTER_API_KEY=<key> pnpm --filter @roo-code/vscode-e2e test:ci`     | Real-API mode — runs against live OpenRouter (for drift detection) |

## Programmatic fixtures (regex matching)

For requests that can't be matched by a stable substring (e.g. "starts with `<environment_details>` but not preceded by a user message"), add a programmatic fixture in `src/runTest.ts` using `mock.addFixture()` with a `RegExp` match. These are only available in replay mode and are not recorded.
