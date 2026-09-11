// npx vitest run src/utils/__tests__/vscode.spec.ts

// The browser bridge is exercised through its public statics only; the real
// client (and its lazy socket.io-client import) is covered by
// `browserBridgeClient.spec.ts`.
const { bridgeMock } = vi.hoisted(() => ({
	bridgeMock: {
		maybeConnect: vi.fn(),
		active: vi.fn(() => false),
		postMessage: vi.fn(),
	},
}))

vi.mock("../browserBridgeClient", () => ({ BrowserBridgeClient: bridgeMock }))

/**
 * `vscode.ts` exports a module-level singleton, so each scenario re-imports
 * the module with a fresh module registry to run its constructor.
 */
async function importFresh(): Promise<typeof import("../vscode")> {
	vi.resetModules()
	return await import("../vscode")
}

describe("vscode (VSCodeAPIWrapper) browser bridge wiring", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
		bridgeMock.maybeConnect.mockClear()
		bridgeMock.active.mockReset().mockReturnValue(false)
		bridgeMock.postMessage.mockClear()
	})

	it("asks the bridge client to connect on construction when no vscode api exists", async () => {
		await importFresh()

		// jsdom has no acquireVsCodeApi, so the dev-gated else-branch runs.
		expect(bridgeMock.maybeConnect).toHaveBeenCalledTimes(1)
	})

	it("never touches the bridge when acquireVsCodeApi is available", async () => {
		const vsCodeApi = { postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }
		vi.stubGlobal("acquireVsCodeApi", () => vsCodeApi)

		const { vscode } = await importFresh()
		vscode.postMessage({ type: "webviewDidLaunch" } as any)

		expect(vsCodeApi.postMessage).toHaveBeenCalledWith({ type: "webviewDidLaunch" })
		expect(bridgeMock.maybeConnect).not.toHaveBeenCalled()
		expect(bridgeMock.postMessage).not.toHaveBeenCalled()
	})

	it("routes postMessage over the bridge while it is active", async () => {
		bridgeMock.active.mockReturnValue(true)

		const { vscode } = await importFresh()
		const message = { type: "showTaskWithId", text: "task-1" } as any
		vscode.postMessage(message)

		expect(bridgeMock.active).toHaveBeenCalled()
		expect(bridgeMock.postMessage).toHaveBeenCalledWith(message)
	})

	it("falls back to console logging when the bridge is inactive", async () => {
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})

		const { vscode } = await importFresh()
		const message = { type: "acceptInput" } as any
		vscode.postMessage(message)

		expect(bridgeMock.active).toHaveBeenCalled()
		expect(bridgeMock.postMessage).not.toHaveBeenCalled()
		expect(consoleSpy).toHaveBeenCalledWith(message)

		consoleSpy.mockRestore()
	})
})
