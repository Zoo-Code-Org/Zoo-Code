import {
	createWebviewDiagnosticsSnapshot,
	installWebviewDiagnostics,
	recordDiagnosticsActiveTab,
	recordDiagnosticsError,
	recordDiagnosticsExtensionState,
	recordDiagnosticsHydration,
	recordDiagnosticsStateSequence,
	recordDiagnosticsUnknownMessageUpdate,
} from "../diagnostics"
import { vscode } from "../vscode"

vi.mock("../vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

describe("webview diagnostics", () => {
	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	})

	it.each([
		null,
		undefined,
		"request",
		{},
		{ type: "diagnosticsRequest", requestId: "" },
		{ type: "diagnosticsRequest", requestId: 1 },
	])("ignores malformed requests: %j", (data) => {
		installWebviewDiagnostics()
		vi.mocked(vscode.postMessage).mockClear()
		window.dispatchEvent(new MessageEvent("message", { data }))
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("installs browser error listeners only once", () => {
		installWebviewDiagnostics()
		const addListener = vi.spyOn(window, "addEventListener")
		installWebviewDiagnostics()
		expect(addListener).not.toHaveBeenCalled()
		window.dispatchEvent(new ErrorEvent("error", { error: new TypeError("private message") }))
		expect(createWebviewDiagnosticsSnapshot().error?.name).toBe("TypeError")
		window.dispatchEvent(new ErrorEvent("error", { message: "private fallback" }))
		expect(createWebviewDiagnosticsSnapshot().error?.name).toBe("UnknownError")
		const rejection = new Event("unhandledrejection")
		Object.defineProperty(rejection, "reason", { value: new RangeError("private rejection") })
		window.dispatchEvent(rejection)
		expect(createWebviewDiagnosticsSnapshot().error?.name).toBe("RangeError")
	})

	it("contains hostile error objects without retaining their content", () => {
		const error = new Error("secret")
		Object.defineProperty(error, "name", {
			get: () => {
				throw new Error("secret getter")
			},
		})
		recordDiagnosticsError("errorBoundary", error)
		expect(createWebviewDiagnosticsSnapshot().error).toEqual({
			name: "UnknownError",
			fingerprint: expect.stringMatching(/^fnv1a-/),
		})
		recordDiagnosticsError("errorBoundary", Object.assign(new Error("secret"), { name: "!!!" }))
		expect(createWebviewDiagnosticsSnapshot().error?.name).toBe("Error")
	})

	it("returns partial snapshots when browser APIs fail", () => {
		vi.spyOn(document, "getElementById").mockImplementation(() => {
			throw new Error("unavailable")
		})
		vi.spyOn(window, "getComputedStyle").mockImplementation(() => {
			throw new Error("unavailable")
		})
		vi.stubGlobal("innerWidth", Number.NaN)
		const snapshot = createWebviewDiagnosticsSnapshot()
		expect(snapshot.rootMounted).toBeUndefined()
		expect(snapshot.theme).toBeUndefined()
		expect(snapshot.viewport).toBeUndefined()
	})

	it("can collect diagnostics without a browser", () => {
		vi.stubGlobal("window", undefined)
		vi.stubGlobal("document", undefined)
		expect(() => installWebviewDiagnostics()).not.toThrow()
		const snapshot = createWebviewDiagnosticsSnapshot()
		expect(snapshot.rootMounted).toBeUndefined()
		expect(snapshot.theme).toBeUndefined()
		expect(snapshot.viewport).toBeUndefined()
	})
	beforeAll(() => {
		const root = document.createElement("div")
		root.id = "root"
		root.append(document.createElement("div"))
		document.body.append(root)
		document.documentElement.style.setProperty("--vscode-foreground", "#eeeeee")
		document.documentElement.style.color = "rgb(238, 238, 238)"
		document.documentElement.style.backgroundColor = "rgb(30, 30, 30)"
	})

	afterAll(() => {
		document.getElementById("root")?.remove()
		document.documentElement.removeAttribute("style")
	})

	it("collects a bounded structural snapshot without error paths", () => {
		recordDiagnosticsHydration(true)
		recordDiagnosticsActiveTab("settings")
		recordDiagnosticsExtensionState({
			currentTaskId: "task-123",
			chatMessageCount: 4,
			historyItemCount: 7,
			todoCount: 2,
		})

		recordDiagnosticsStateSequence(25, true, false)
		recordDiagnosticsStateSequence(24, true, true)

		for (let update = 0; update < 12; update += 1) {
			recordDiagnosticsUnknownMessageUpdate()
		}

		recordDiagnosticsError(
			"windowError",
			new Error("Secret content at /Users/example/private/file.ts and C:\\Users\\example\\secret.ts"),
		)

		const snapshot = createWebviewDiagnosticsSnapshot()

		expect(snapshot.didHydrateState).toBe(true)
		expect(snapshot.activeView).toBe("settings")
		expect(snapshot).toMatchObject({
			currentTaskId: "task-123",
			chatMessageCount: 4,
			historyItemCount: 7,
			todoCount: 2,
		})
		expect(snapshot.lastReceivedStateSequence).toBe(24)
		expect(snapshot.lastAppliedStateSequence).toBe(25)
		expect(snapshot.staleStateRejectionCount).toBe(1)
		expect(snapshot.unknownMessageUpdateCount).toBe(12)
		expect(snapshot).toMatchObject({ rootMounted: true, rootChildCount: 1 })
		expect(snapshot.theme).toMatchObject({
			rootForeground: "rgb(238, 238, 238)",
			rootBackground: "rgb(30, 30, 30)",
		})
		expect(snapshot.theme?.variables?.["--vscode-foreground"]).toBe("#eeeeee")
		expect(snapshot.error).toMatchObject({ name: "Error", fingerprint: expect.stringMatching(/^fnv1a-/) })
		expect(snapshot.error).not.toHaveProperty("message")
		expect(snapshot.error).not.toHaveProperty("stackLocations")
	})

	it.each([
		{ sequence: 0, hasMessages: true, stale: false },
		{ sequence: 0, hasMessages: true, stale: true },
		{ sequence: 100, hasMessages: false, stale: false },
		{ sequence: undefined, hasMessages: true, stale: false },
		{ sequence: -1, hasMessages: true, stale: false },
		{ sequence: Number.NaN, hasMessages: true, stale: true },
	])("records the supplied stale decision for $sequence", ({ sequence, hasMessages, stale }) => {
		const before = createWebviewDiagnosticsSnapshot()
		recordDiagnosticsStateSequence(sequence, hasMessages, stale)
		const after = createWebviewDiagnosticsSnapshot()
		const valid = typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 0
		expect(after.lastReceivedStateSequence).toBe(valid ? sequence : before.lastReceivedStateSequence)
		expect(after.lastAppliedStateSequence).toBe(
			valid && hasMessages && !stale ? sequence : before.lastAppliedStateSequence,
		)
		expect(after.staleStateRejectionCount).toBe(
			(before.staleStateRejectionCount ?? 0) + (valid && hasMessages && stale ? 1 : 0),
		)
	})

	it("responds only to valid diagnostics requests and contains posting failures", () => {
		installWebviewDiagnostics()

		window.dispatchEvent(new MessageEvent("message", { data: { type: "other", requestId: "ignored" } }))
		expect(vscode.postMessage).not.toHaveBeenCalled()

		window.dispatchEvent(
			new MessageEvent("message", { data: { type: "diagnosticsRequest", requestId: "request-1" } }),
		)

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "diagnosticsResponse",
				requestId: "request-1",
				diagnostics: expect.objectContaining({ activeView: "settings" }),
			}),
		)

		vi.mocked(vscode.postMessage).mockImplementationOnce(() => {
			throw new Error("disconnected")
		})
		expect(() => {
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "diagnosticsRequest", requestId: "request-2" } }),
			)
		}).not.toThrow()
	})
})
