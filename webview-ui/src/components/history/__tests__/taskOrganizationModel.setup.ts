import { TransformStream } from "node:stream/web"

// Polyfills for running the taskOrganizationModel pure-logic suite in a Node
// environment without the full JSDOM setup required by component tests.

if (typeof globalThis.TransformStream === "undefined") {
	globalThis.TransformStream = TransformStream as unknown as typeof globalThis.TransformStream
}

if (typeof globalThis.HTMLElement === "undefined") {
	globalThis.HTMLElement = class HTMLElement {} as unknown as typeof globalThis.HTMLElement
}

if (typeof globalThis.Element === "undefined") {
	globalThis.Element = class Element {} as unknown as typeof globalThis.Element
}

if (typeof globalThis.ResizeObserver === "undefined") {
	globalThis.ResizeObserver = class ResizeObserver {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof globalThis.ResizeObserver
}

if (typeof globalThis.window === "undefined") {
	globalThis.window = globalThis as unknown as Window & typeof globalThis
}

if (typeof globalThis.matchMedia === "undefined") {
	globalThis.matchMedia = (() => ({
		matches: false,
		media: "",
		onchange: null,
		addListener: () => {},
		removeListener: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => false,
	})) as unknown as typeof globalThis.matchMedia
}

if (typeof globalThis.Element.prototype.scrollIntoView === "undefined") {
	globalThis.Element.prototype.scrollIntoView = () => {}
}
