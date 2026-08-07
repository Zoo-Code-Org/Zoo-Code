import { describe, expect, it, vi } from "vitest"

import {
	makeDisposable,
	makeEventEmitter,
	makeExtensionContext,
	makePosition,
	makeRange,
	makeSelection,
	makeTextDocument,
	makeTextEditor,
	makeUri,
	makeWorkspaceConfiguration,
} from "../vscode"

describe("VS Code test utilities", () => {
	it("creates the common VS Code value shapes", async () => {
		expect(makePosition(2, 3)).toEqual({ line: 2, character: 3 })
		expect(makeRange(1, 2, 3, 4)).toEqual({
			start: { line: 1, character: 2 },
			end: { line: 3, character: 4 },
		})
		expect(makeSelection(4, 5)).toEqual({
			anchor: { line: 4, character: 5 },
			active: { line: 4, character: 5 },
		})

		const uri = makeUri("/tmp/test.ts", { scheme: "untitled" })
		const document = makeTextDocument({
			uri,
			getText: vi.fn().mockReturnValue("first\nsecond"),
		})
		const editor = makeTextEditor({ document })

		expect(uri).toMatchObject({ fsPath: "/tmp/test.ts", scheme: "untitled" })
		expect(uri.toString()).toBe("/tmp/test.ts")
		expect(uri.toJSON()).toEqual({ fsPath: "/tmp/test.ts" })
		expect(document.lineCount).toBe(2)
		expect(document.lineAt(1).text).toBe("second")
		expect(document.getText()).toBe("first\nsecond")
		expect(document.getWordRangeAtPosition(makePosition())).toBeUndefined()
		expect(document.offsetAt(makePosition())).toBeUndefined()
		expect(document.positionAt(0)).toBeUndefined()
		expect(document.validateRange(makeRange())).toEqual(makeRange())
		expect(document.validatePosition(makePosition())).toEqual(makePosition())
		expect(makeTextDocument().getText()).toBe("")
		expect(editor.document).toBe(document)
		expect(await editor.edit(() => undefined)).toBe(true)

		const disposable = makeDisposable()
		disposable.dispose()
		expect(disposable.dispose).toHaveBeenCalledOnce()
	})

	it("supports event subscriptions and cleanup", () => {
		const emitter = makeEventEmitter<number>()
		const listener = vi.fn()
		const subscription = emitter.event(listener)

		emitter.fire(1)
		expect(listener).toHaveBeenCalledWith(1)

		subscription.dispose()
		emitter.fire(2)
		expect(listener).toHaveBeenCalledOnce()

		emitter.dispose()
	})

	it("creates configurable workspace settings", async () => {
		const configuration = makeWorkspaceConfiguration({ enabled: true })

		expect(configuration.get("enabled")).toBe(true)
		expect(configuration.get("missing", "fallback")).toBe("fallback")
		expect(configuration.has("enabled")).toBe(true)
		expect(configuration.has("missing")).toBe(false)

		await configuration.update("enabled", false)
		expect(configuration.update).toHaveBeenCalledWith("enabled", false)
	})

	it("creates an extension context with fresh state containers", async () => {
		const context = makeExtensionContext({ extensionPath: "/custom/extension" })

		expect(context.extensionPath).toBe("/custom/extension")
		expect(context.asAbsolutePath("dist")).toBe("/mock/extension/dist")
		expect(context.workspaceState.keys()).toEqual([])
		await context.workspaceState.update("key", "value")
		await context.secrets.store("key", "value")
		expect(context.workspaceState.update).toHaveBeenCalledWith("key", "value")
		expect(context.secrets.store).toHaveBeenCalledWith("key", "value")
	})
})
