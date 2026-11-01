import { describe, expect, it, vi } from "vitest"

import { registerCopilotModelBroadcast } from "../copilotModelBroadcast"

// A host (or test double) that offers language models but no authentication API at all.
vi.mock("vscode", () => ({ lm: { onDidChangeChatModels: vi.fn(() => ({ dispose: vi.fn() })) } }))
vi.mock("../../../api/providers/github-copilot", () => ({
	getGitHubCopilotModels: vi.fn(),
	getGitHubCopilotAccount: vi.fn(),
}))

describe("registerCopilotModelBroadcast without an authentication API", () => {
	it("registers and disposes cleanly, still following model changes", () => {
		const registration = registerCopilotModelBroadcast({ getTargets: () => [], log: vi.fn() })
		expect(() => registration.dispose()).not.toThrow()
	})
})
