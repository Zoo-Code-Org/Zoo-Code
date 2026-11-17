/** Restore real DOM focus locally: the shared FAST setup otherwise replaces it with a no-op. */
export function setupNativePickerFocus() {
	let frame: HTMLIFrameElement
	let original: PropertyDescriptor
	beforeAll(() => {
		frame = document.createElement("iframe")
		document.body.append(frame)
		const nativeFocus = frame.contentDocument?.createElement("button").focus
		const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "focus")
		if (!nativeFocus || !descriptor) throw new Error("Native DOM focus is unavailable")
		original = descriptor
		Object.defineProperty(HTMLElement.prototype, "focus", {
			configurable: true,
			value: nativeFocus,
			writable: true,
		})
	})
	afterAll(() => {
		Object.defineProperty(HTMLElement.prototype, "focus", original)
		frame.remove()
	})
}
