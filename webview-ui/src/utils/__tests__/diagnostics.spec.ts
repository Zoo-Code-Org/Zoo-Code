import {
	createWebviewDiagnosticsSnapshot,
	installWebviewDiagnostics,
	recordDiagnosticsActiveTab,
	recordDiagnosticsError,
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

		recordDiagnosticsStateSequence(25, true)
		recordDiagnosticsStateSequence(24, true)

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
