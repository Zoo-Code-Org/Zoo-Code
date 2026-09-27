import { act, renderHook } from "@testing-library/react"

import { vscode } from "../vscode"
import { captureWebviewThemeFixture, useThemeFixtureProbe } from "../useThemeFixtureProbe"

describe("captureWebviewThemeFixture", () => {
	afterEach(() => {
		document.documentElement.removeAttribute("style")
		document.body.removeAttribute("style")
		document.body.removeAttribute("class")
		delete document.body.dataset.vscodeThemeId
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	it("captures only resolved VS Code custom properties", () => {
		document.documentElement.style.setProperty("--vscode-root", "#ffffff")
		document.body.className = "vscode-dark extra-class"
		document.body.dataset.vscodeThemeId = "Default Dark Modern"
		document.body.style.colorScheme = "dark"
		document.body.style.setProperty("--vscode-z-last", "rgb(2, 2, 2)")
		document.body.style.setProperty("--vscode-a-first", "#010101")
		document.body.style.setProperty("--other-variable", "ignored")

		expect(captureWebviewThemeFixture()).toEqual({
			themeId: "Default Dark Modern",
			bodyClass: "vscode-dark extra-class",
			variables: {
				"--vscode-root": "",
				"--vscode-z-last": "rgb(2, 2, 2)",
				"--vscode-a-first": "#010101",
			},
		})
	})

	it("responds after two animation frames", () => {
		const callbacks = new Map<number, FrameRequestCallback>()
		let nextFrame = 0
		vi.stubGlobal(
			"requestAnimationFrame",
			vi.fn((callback: FrameRequestCallback) => {
				const id = ++nextFrame
				callbacks.set(id, callback)
				return id
			}),
		)
		vi.stubGlobal(
			"cancelAnimationFrame",
			vi.fn((id: number) => callbacks.delete(id)),
		)
		const postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined)
		const { unmount } = renderHook(() => useThemeFixtureProbe())

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "themeFixtureProbeRequest", requestId: "request-1" } }),
			)
		})
		expect(postMessage).not.toHaveBeenCalled()

		act(() => {
			callbacks.get(1)?.(0)
		})
		expect(postMessage).not.toHaveBeenCalled()

		act(() => {
			callbacks.get(2)?.(0)
		})

		expect(postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: "themeFixtureProbeResponse", requestId: "request-1" }),
		)
		unmount()
	})

	it("ignores incomplete requests and cancels pending frames on unmount", () => {
		const callbacks = new Map<number, FrameRequestCallback>()
		vi.stubGlobal(
			"requestAnimationFrame",
			vi.fn((callback: FrameRequestCallback) => {
				callbacks.set(1, callback)
				return 1
			}),
		)
		const cancelAnimationFrame = vi.fn((id: number) => callbacks.delete(id))
		vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame)
		const postMessage = vi.spyOn(vscode, "postMessage").mockImplementation(() => undefined)
		const { unmount } = renderHook(() => useThemeFixtureProbe())

		act(() => {
			window.dispatchEvent(new MessageEvent("message", { data: { type: "themeFixtureProbeRequest" } }))
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "themeFixtureProbeRequest", requestId: "pending" } }),
			)
		})
		unmount()

		expect(postMessage).not.toHaveBeenCalled()
		expect(cancelAnimationFrame).toHaveBeenCalledWith(1)
	})
})
