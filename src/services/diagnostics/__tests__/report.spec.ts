import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { DiagnosticsProviderSource } from "../types"
import { buildDiagnosticsReport } from "../report"

describe("buildDiagnosticsReport", () => {
	it("produces bounded, pseudonymized, privacy-safe valid JSON", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-report-test-"))
		const provider: DiagnosticsProviderSource = {
			getDiagnosticsSnapshot: () => ({
				renderContext: "sidebar",
				disposed: false,
				viewPresent: true,
				visible: false,
				launched: true,
				taskHistoryInitialized: true,
				taskCount: 1,
				currentTaskId: "raw-task-id",
				currentMessageCount: 4,
				currentTodoCount: 2,
				history: [
					{
						id: "raw-task-id",
						number: 1,
						ts: 1,
						task: "TOP SECRET PROMPT",
						tokensIn: 0,
						tokensOut: 0,
						totalCost: 0,
					},
					{
						id: "failed-navigation-target",
						number: 2,
						ts: 2,
						task: "ANOTHER SECRET PROMPT",
						tokensIn: 0,
						tokensOut: 0,
						totalCost: 0,
					},
				],
				events: [
					...Array.from({ length: 99 }, (_, index) => ({
						timestamp: new Date(index).toISOString(),
						boundary: "webview-out" as const,
						phase: "success" as const,
						type: "state",
						taskId: "raw-task-id",
					})),
					{
						timestamp: new Date(100).toISOString(),
						boundary: "task-navigation" as const,
						phase: "failure" as const,
						type: "show-task",
						taskId: "failed-navigation-target",
					},
				],
				eventsTruncated: true,
			}),
			requestWebviewDiagnostics: async () => ({
				capturedAt: new Date(0).toISOString(),
				didHydrateState: true,
				activeView: "chat",
				currentTaskId: "raw-task-id",
				chatMessageCount: 4,
				theme: {
					bodyBackground: "#fff",
					variables: {
						"--vscode-editor-background": "#fff",
						"--private-secret": "API_KEY_SECRET",
					},
				},
				error: {
					message: "user@example.com /Users/person/private.ts",
					fingerprint: "error-123",
					stackLocations: ["webview-ui/src/App.tsx:1", "/Users/person/private.ts:2"],
				},
			}),
		}

		try {
			const report = await buildDiagnosticsReport({
				providers: [provider],
				storagePath,
				version: "1.2.3",
				releaseChannel: "stable",
				environment: {
					vscodeVersion: "1.100.0",
					appName: "Visual Studio Code",
					uiKind: "desktop",
					platform: "linux",
					architecture: "x64",
					locale: "en",
					remote: false,
					workspaceFolderCount: 1,
					customStorageConfigured: false,
					colorThemeKind: "dark",
				},
			})
			const serialized = JSON.stringify(report)
			expect(() => JSON.parse(serialized)).not.toThrow()
			expect(report.providers[0].events).toHaveLength(100)
			expect(report.providers[0].currentTask).toMatch(/^task-[a-f0-9]{12}$/)
			expect(report.providers[0].webviewResponse).toBe("received")
			expect(report.persistence.tasks).toHaveLength(2)
			expect(report.providers[0].webview).toMatchObject({
				didHydrateState: true,
				currentTask: report.providers[0].currentTask,
			})
			expect(serialized).not.toContain("raw-task-id")
			expect(serialized).not.toContain("failed-navigation-target")
			expect(serialized).not.toContain("TOP SECRET")
			expect(serialized).not.toContain("API_KEY_SECRET")
			expect(serialized).not.toContain("user@example.com")
			expect(serialized).not.toContain("/Users/person")
			expect(serialized).not.toContain("webview-ui/src/App.tsx")
			expect(report.privacy).toMatchObject({ conversationContentIncluded: false, uploaded: false })
		} finally {
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it("marks a nonresponsive webview unavailable", async () => {
		const provider: DiagnosticsProviderSource = {
			getDiagnosticsSnapshot: () => ({
				renderContext: "editor",
				disposed: false,
				viewPresent: false,
				visible: false,
				launched: false,
				taskHistoryInitialized: false,
				taskCount: 0,
				currentMessageCount: 0,
				currentTodoCount: 0,
				history: [],
				events: [],
				eventsTruncated: false,
			}),
			requestWebviewDiagnostics: async () => undefined,
		}
		const report = await buildDiagnosticsReport({
			providers: [provider],
			storagePath: os.tmpdir(),
			version: "1",
			releaseChannel: "stable",
			environment: {
				vscodeVersion: "1",
				appName: "Code",
				uiKind: "desktop",
				platform: "linux",
				architecture: "x64",
				locale: "en",
				remote: false,
				workspaceFolderCount: 0,
				customStorageConfigured: false,
				colorThemeKind: "dark",
			},
		})

		expect(report.providers[0].webviewResponse).toBe("unavailable")
	})
})
