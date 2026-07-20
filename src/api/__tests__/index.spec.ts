// npx vitest run src/api/__tests__/index.spec.ts

// Mock vscode first to avoid import errors
vitest.mock("vscode", () => ({
	workspace: {
		getConfiguration: () => ({
			get: (_key: string, defaultValue?: unknown) => defaultValue,
		}),
	},
}))

import type { ProviderSettings } from "@roo-code/types"

import { buildApiHandler } from "../index"
import { KenariHandler } from "../providers/kenari"

describe("buildApiHandler", () => {
	it("returns a KenariHandler for the kenari provider", () => {
		const configuration: ProviderSettings = {
			apiProvider: "kenari",
			kenariApiKey: "test-key",
			kenariModelId: "glm-5-2",
		}

		const handler = buildApiHandler(configuration)

		expect(handler).toBeInstanceOf(KenariHandler)
	})
})
