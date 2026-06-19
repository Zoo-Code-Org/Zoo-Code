import "@testing-library/jest-dom"
import "@testing-library/jest-dom/vitest"

// Mock the VSCode webview-ui-toolkit to avoid dual React instance issues caused
// by FAST Foundation web component registration. Registered here (rather than via
// a resolve.alias in vitest.config.ts) so the global config stays clean.
//
// The factory delegates to the JSX mock implementation in
// `src/__mocks__/@vscode/webview-ui-toolkit/react.tsx`, imported through the `@`
// alias so it resolves on Vite's (deduped) module graph and shares the test's
// React instance.
vi.mock("@vscode/webview-ui-toolkit/react", async () => {
	return await import("@/__mocks__/@vscode/webview-ui-toolkit/react")
})

// Force React into development mode for tests
// This is needed to enable act(...) function in React Testing Library
globalThis.process = globalThis.process || {}
globalThis.process.env = globalThis.process.env || {}
globalThis.process.env.NODE_ENV = "development"

class MockResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

global.ResizeObserver = MockResizeObserver

// Fix for Microsoft FAST Foundation compatibility with JSDOM
// FAST Foundation tries to set HTMLElement.focus property, but it's read-only in JSDOM
// The issue is that FAST Foundation's handleUnsupportedDelegatesFocus tries to set element.focus = originalFocus
// but JSDOM's HTMLElement.focus is a getter-only property
Object.defineProperty(HTMLElement.prototype, "focus", {
	get: function () {
		return (
			this._focus ||
			function () {
				// Mock focus behavior for tests
			}
		)
	},
	set: function (value) {
		this._focus = value
	},
	configurable: true,
})

Object.defineProperty(window, "matchMedia", {
	writable: true,
	value: vi.fn().mockImplementation((query) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: vi.fn(),
		removeListener: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(),
	})),
})

// Mock scrollIntoView which is not available in jsdom
Element.prototype.scrollIntoView = vi.fn()

// Ensure all dynamic imports are settled before jsdom teardown to prevent
// EnvironmentTeardownError. See https://github.com/vitest-dev/vitest/issues/9872
afterEach(async () => {
	await vi.dynamicImportSettled()
})
