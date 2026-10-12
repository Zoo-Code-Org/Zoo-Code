import type { WebviewMessage } from "@roo-code/types"

import type { ClineProvider } from "../ClineProvider"
import { WebviewFocusTracker } from "../WebviewFocusTracker"
import { makeEventEmitter } from "../../../test-utils/vscode"

function createView() {
	const messages = makeEventEmitter<WebviewMessage>()
	const disposed = makeEventEmitter<void>()
	const view = {
		webview: { onDidReceiveMessage: vi.fn(messages.event) },
		onDidDispose: vi.fn(disposed.event),
	}
	return { view, messages, disposed }
}

describe("WebviewFocusTracker", () => {
	let tracker: WebviewFocusTracker
	let provider: ClineProvider

	beforeEach(() => {
		tracker = new WebviewFocusTracker()
		// The tracker only stores provider identity; no provider methods are needed.
		provider = {} as ClineProvider
	})

	afterEach(() => tracker.dispose())

	it("waits for a focus message and ignores other messages", () => {
		const { view, messages } = createView()
		tracker.init(provider, view)
		expect(tracker.getLastActiveProvider()).toBeUndefined()

		messages.fire({ type: "themeFixtureProbeResponse" })
		expect(tracker.getLastActiveProvider()).toBeUndefined()

		messages.fire({ type: "webviewDidFocus" })
		expect(tracker.getLastActiveProvider()).toBe(provider)
	})

	it("follows focus messages rather than registration order", () => {
		const first = createView()
		const second = createView()
		const secondProvider = {} as ClineProvider
		tracker.init(provider, first.view)
		tracker.init(secondProvider, second.view)

		first.messages.fire({ type: "webviewDidFocus" })
		expect(tracker.getLastActiveProvider()).toBe(provider)
		second.messages.fire({ type: "webviewDidFocus" })
		expect(tracker.getLastActiveProvider()).toBe(secondProvider)
		first.messages.fire({ type: "webviewDidFocus" })
		expect(tracker.getLastActiveProvider()).toBe(provider)
	})

	it("does not clear focus when another view using the same provider is disposed", () => {
		const first = createView()
		const second = createView()
		tracker.init(provider, first.view)
		tracker.init(provider, second.view)

		first.messages.fire({ type: "webviewDidFocus" })
		second.disposed.fire()
		expect(tracker.getLastActiveProvider()).toBe(provider)
		first.disposed.fire()
		expect(tracker.getLastActiveProvider()).toBeUndefined()
	})

	it("unsubscribes both listeners exactly once when a registration is disposed", () => {
		const { view, messages, disposed } = createView()
		const registration = tracker.init(provider, view)
		const disposeMessages = vi.spyOn(view.webview.onDidReceiveMessage.mock.results[0].value, "dispose")
		const disposeView = vi.spyOn(view.onDidDispose.mock.results[0].value, "dispose")
		messages.fire({ type: "webviewDidFocus" })

		registration.dispose()
		registration.dispose()
		disposed.fire()
		tracker.dispose()
		expect(tracker.getLastActiveProvider()).toBeUndefined()
		expect(disposeMessages).toHaveBeenCalledOnce()
		expect(disposeView).toHaveBeenCalledOnce()
		messages.fire({ type: "webviewDidFocus" })
		expect(tracker.getLastActiveProvider()).toBeUndefined()
	})

	it.each(["onDidReceiveMessage", "onDidDispose"] as const)(
		"continues registration cleanup and logs a failing %s listener",
		(eventName) => {
			const { view, messages, disposed } = createView()
			const registration = tracker.init(provider, view)
			const error = new Error(`${eventName} cleanup failed`)
			const listeners = {
				onDidReceiveMessage: vi.spyOn(view.webview.onDidReceiveMessage.mock.results[0].value, "dispose"),
				onDidDispose: vi.spyOn(view.onDidDispose.mock.results[0].value, "dispose"),
			}
			listeners[eventName].mockImplementation(() => {
				throw error
			})
			const log = vi.spyOn(console, "error").mockImplementation(() => {})
			try {
				messages.fire({ type: "webviewDidFocus" })
				expect(() => registration.dispose()).not.toThrow()
				expect(tracker.getLastActiveProvider()).toBeUndefined()
				expect(listeners.onDidReceiveMessage).toHaveBeenCalledOnce()
				expect(listeners.onDidDispose).toHaveBeenCalledOnce()
				expect(log).toHaveBeenCalledExactlyOnceWith(
					"[WebviewFocusTracker] Failed to dispose webview subscription:",
					error,
				)

				// A failed unsubscription may leave the source alive, but it must not restore focus.
				messages.fire({ type: "webviewDidFocus" })
				disposed.fire()
				registration.dispose()
				tracker.dispose()
				expect(tracker.getLastActiveProvider()).toBeUndefined()
				expect(listeners.onDidReceiveMessage).toHaveBeenCalledOnce()
				expect(listeners.onDidDispose).toHaveBeenCalledOnce()
				expect(log).toHaveBeenCalledOnce()
			} finally {
				log.mockRestore()
			}
		},
	)

	it("disposes each listener once when cleanup reenters tracker disposal", () => {
		const first = createView()
		const second = createView()
		first.view.webview.onDidReceiveMessage.mockImplementation((listener) => {
			const subscription = first.messages.event(listener)
			return {
				dispose: () => {
					subscription.dispose()
					tracker.dispose()
				},
			}
		})
		tracker.init(provider, first.view)
		tracker.init(provider, second.view)
		const listeners = [first, second].flatMap(({ view }) => [
			vi.spyOn(view.webview.onDidReceiveMessage.mock.results[0].value, "dispose"),
			vi.spyOn(view.onDidDispose.mock.results[0].value, "dispose"),
		])
		second.messages.fire({ type: "webviewDidFocus" })

		tracker.dispose()

		for (const listener of listeners) {
			expect(listener).toHaveBeenCalledOnce()
		}
		expect(tracker.getLastActiveProvider()).toBeUndefined()
		first.messages.fire({ type: "webviewDidFocus" })
		second.messages.fire({ type: "webviewDidFocus" })
		expect(tracker.getLastActiveProvider()).toBeUndefined()
	})

	it("attempts every listener across views even when all listener disposals fail", () => {
		const first = createView()
		const second = createView()
		const secondProvider = {} as ClineProvider
		tracker.init(provider, first.view)
		tracker.init(secondProvider, second.view)
		const errors = [new Error("message listener failed"), "dispose listener failed"]
		const listeners = [first, second].flatMap(({ view }) => [
			vi.spyOn(view.webview.onDidReceiveMessage.mock.results[0].value, "dispose").mockImplementation(() => {
				throw errors[0]
			}),
			vi.spyOn(view.onDidDispose.mock.results[0].value, "dispose").mockImplementation(() => {
				throw errors[1]
			}),
		])
		const log = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			second.messages.fire({ type: "webviewDidFocus" })
			expect(() => tracker.dispose()).not.toThrow()
			expect(tracker.getLastActiveProvider()).toBeUndefined()
			for (const listener of listeners) {
				expect(listener).toHaveBeenCalledOnce()
			}
			expect(log).toHaveBeenCalledTimes(4)
			for (const [index, error] of [...errors, ...errors].entries()) {
				expect(log).toHaveBeenNthCalledWith(
					index + 1,
					"[WebviewFocusTracker] Failed to dispose webview subscription:",
					error,
				)
			}

			const third = createView()
			const thirdProvider = {} as ClineProvider
			tracker.init(thirdProvider, third.view)
			third.messages.fire({ type: "webviewDidFocus" })
			for (const previous of [first, second]) {
				previous.messages.fire({ type: "webviewDidFocus" })
				previous.disposed.fire()
			}
			expect(tracker.getLastActiveProvider()).toBe(thirdProvider)
			tracker.dispose()
			tracker.dispose()
			for (const listener of listeners) {
				expect(listener).toHaveBeenCalledOnce()
			}
			expect(log).toHaveBeenCalledTimes(4)
		} finally {
			log.mockRestore()
		}
	})

	it("ignores a queued focus callback from a disposed registration", () => {
		const first = createView()
		const second = createView()
		const secondProvider = {} as ClineProvider
		const registration = tracker.init(provider, first.view)
		const onMessage = first.view.webview.onDidReceiveMessage.mock.calls[0][0]
		tracker.init(secondProvider, second.view)
		second.messages.fire({ type: "webviewDidFocus" })

		registration.dispose()
		onMessage({ type: "webviewDidFocus" })
		expect(tracker.getLastActiveProvider()).toBe(secondProvider)
	})

	it("cleans up when the view is disposed while listeners are being registered", () => {
		const { view, messages } = createView()
		const disposeView = vi.fn()
		view.onDidDispose.mockImplementation((listener) => {
			listener()
			return { dispose: disposeView }
		})
		const registration = tracker.init(provider, view)
		const onMessage = view.webview.onDidReceiveMessage.mock.calls[0][0]
		messages.fire({ type: "webviewDidFocus" })
		onMessage({ type: "webviewDidFocus" })
		expect(tracker.getLastActiveProvider()).toBeUndefined()
		expect(disposeView).toHaveBeenCalledOnce()

		registration.dispose()
		tracker.dispose()
		expect(disposeView).toHaveBeenCalledOnce()
	})

	it("contains listener cleanup errors when a view closes during registration", () => {
		const { view, messages } = createView()
		const error = new Error("registration cleanup failed")
		const disposeMessages = vi.fn()
		view.webview.onDidReceiveMessage.mockImplementation((listener) => {
			const subscription = messages.event(listener)
			disposeMessages.mockImplementation(() => subscription.dispose())
			return { dispose: disposeMessages }
		})
		const disposeView = vi.fn(() => {
			throw error
		})
		view.onDidDispose.mockImplementation((listener) => {
			listener()
			return { dispose: disposeView }
		})
		const log = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			expect(() => tracker.init(provider, view)).not.toThrow()
			expect(disposeMessages).toHaveBeenCalledOnce()
			expect(disposeView).toHaveBeenCalledOnce()
			expect(log).toHaveBeenCalledExactlyOnceWith(
				"[WebviewFocusTracker] Failed to dispose webview subscription:",
				error,
			)
			messages.fire({ type: "webviewDidFocus" })
			view.webview.onDidReceiveMessage.mock.calls[0][0]({ type: "webviewDidFocus" })
			expect(tracker.getLastActiveProvider()).toBeUndefined()
			tracker.dispose()
			expect(disposeView).toHaveBeenCalledOnce()
		} finally {
			log.mockRestore()
		}
	})

	it("disposes all registrations and can track a new view afterward", () => {
		const first = createView()
		const second = createView()
		tracker.init(provider, first.view)
		tracker.init(provider, second.view)
		const listeners = [first, second].flatMap(({ view }) => [
			vi.spyOn(view.webview.onDidReceiveMessage.mock.results[0].value, "dispose"),
			vi.spyOn(view.onDidDispose.mock.results[0].value, "dispose"),
		])
		const queuedCallbacks = [first, second].map(({ view }) => view.webview.onDidReceiveMessage.mock.calls[0][0])
		first.messages.fire({ type: "webviewDidFocus" })

		tracker.dispose()
		tracker.dispose()
		for (const listener of listeners) {
			expect(listener).toHaveBeenCalledOnce()
		}
		first.messages.fire({ type: "webviewDidFocus" })
		second.messages.fire({ type: "webviewDidFocus" })
		for (const callback of queuedCallbacks) {
			callback({ type: "webviewDidFocus" })
		}
		expect(tracker.getLastActiveProvider()).toBeUndefined()

		const third = createView()
		const thirdProvider = {} as ClineProvider
		tracker.init(thirdProvider, third.view)
		third.messages.fire({ type: "webviewDidFocus" })
		for (const callback of queuedCallbacks) {
			callback({ type: "webviewDidFocus" })
		}
		expect(tracker.getLastActiveProvider()).toBe(thirdProvider)
	})

	it("keeps focus and disposal independent between trackers", () => {
		const otherTracker = new WebviewFocusTracker()
		const first = createView()
		const second = createView()
		tracker.init(provider, first.view)
		otherTracker.init(provider, second.view)
		first.messages.fire({ type: "webviewDidFocus" })
		second.messages.fire({ type: "webviewDidFocus" })

		tracker.dispose()
		expect(tracker.getLastActiveProvider()).toBeUndefined()
		expect(otherTracker.getLastActiveProvider()).toBe(provider)
		otherTracker.dispose()
		expect(otherTracker.getLastActiveProvider()).toBeUndefined()
	})
})
