import { makeExtensionContext } from "../../../test-utils/vscode"
import { CodeIndexSecretStatusManager } from "../code-index-secret-status-manager"

describe("CodeIndexSecretStatusManager", () => {
	const fields = {
		codeIndexOpenAiKey: "hasOpenAiKey",
		codeIndexQdrantApiKey: "hasQdrantApiKey",
		codebaseIndexOpenAiCompatibleApiKey: "hasOpenAiCompatibleApiKey",
		codebaseIndexGeminiApiKey: "hasGeminiApiKey",
		codebaseIndexMistralApiKey: "hasMistralApiKey",
		codebaseIndexVercelAiGatewayApiKey: "hasVercelAiGatewayApiKey",
		codebaseIndexOpenRouterApiKey: "hasOpenRouterApiKey",
	}

	function setup() {
		const secrets = makeExtensionContext().secrets
		const get = vi.spyOn(secrets, "get").mockResolvedValue(undefined)
		const provider = { postMessageToWebview: vi.fn().mockResolvedValue(undefined) }
		return { get, provider, manager: new CodeIndexSecretStatusManager(secrets) }
	}

	it.each([undefined, "", "test-secret"])("reports only boolean presence for %s", async (value) => {
		const { get, provider, manager } = setup()
		get.mockResolvedValue(value)
		await manager.postStatus(provider)
		expect(get.mock.calls).toEqual(Object.keys(fields).map((key) => [key]))
		expect(provider.postMessageToWebview).toHaveBeenCalledExactlyOnceWith({
			type: "codeIndexSecretStatus",
			values: Object.fromEntries(Object.values(fields).map((field) => [field, !!value])),
		})
	})

	it.each(Object.entries(fields))("maps %s to %s independently and refreshes values", async (key, field) => {
		const { get, provider, manager } = setup()
		get.mockImplementation(async (requested) => (requested === key ? "test-secret" : undefined))
		await manager.postStatus(provider)
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "codeIndexSecretStatus",
			values: Object.fromEntries(Object.values(fields).map((name) => [name, name === field])),
		})
		get.mockResolvedValue(undefined)
		await manager.postStatus(provider)
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "codeIndexSecretStatus",
			values: Object.fromEntries(Object.values(fields).map((name) => [name, false])),
		})
	})

	it("propagates storage failures without publishing partial status", async () => {
		const { get, provider, manager } = setup()
		const error = new Error("storage failed")
		get.mockResolvedValueOnce("test-secret").mockRejectedValueOnce(error)
		await expect(manager.postStatus(provider)).rejects.toBe(error)
		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
	})

	it("propagates publishing failures", async () => {
		const { provider, manager } = setup()
		const error = new Error("publish failed")
		provider.postMessageToWebview.mockRejectedValue(error)
		await expect(manager.postStatus(provider)).rejects.toBe(error)
	})
})
