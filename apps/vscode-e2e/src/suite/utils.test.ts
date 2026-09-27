import * as assert from "assert"

import type { ClineMessage } from "@roo-code/types"

import { isCompletedAsk } from "./utils"

suite("E2E message guards", () => {
	test("distinguishes completed asks from streaming previews", () => {
		const message = { ts: 1, type: "ask", ask: "tool" } satisfies ClineMessage

		assert.strictEqual(isCompletedAsk({ ...message, partial: true }), false)
		assert.strictEqual(isCompletedAsk({ ...message, partial: false }), true)
		assert.strictEqual(isCompletedAsk(message), true)
		assert.strictEqual(isCompletedAsk({ ts: 1, type: "say", say: "text" }), false)
	})
})
