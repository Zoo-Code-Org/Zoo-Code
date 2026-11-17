import { setupNativePickerFocus } from "./pickerTestFocus"

describe("setupNativePickerFocus", () => {
	let setup: () => void
	let teardown: () => void
	let original: PropertyDescriptor | undefined

	beforeEach(() => {
		original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "focus")
		vi.stubGlobal("beforeAll", (callback: () => void) => {
			setup = callback
		})
		vi.stubGlobal("afterAll", (callback: () => void) => {
			teardown = callback
		})
		setupNativePickerFocus()
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
		if (original) Object.defineProperty(HTMLElement.prototype, "focus", original)
		document.querySelectorAll("iframe").forEach((frame) => frame.remove())
	})

	it("installs native focus and restores the exact original descriptor", () => {
		setup()
		const frame = document.querySelector("iframe")
		expect(frame).toBeInTheDocument()
		expect(HTMLElement.prototype.focus).toBe(frame?.contentDocument?.createElement("button").focus)
		expect(HTMLElement.prototype.focus).not.toBe(original?.value)
		teardown()
		expect(Object.getOwnPropertyDescriptor(HTMLElement.prototype, "focus")).toEqual(original)
		expect(frame).not.toBeInTheDocument()
	})

	it("reports an unavailable iframe document", () => {
		vi.spyOn(HTMLIFrameElement.prototype, "contentDocument", "get").mockReturnValue(null)
		expect(setup).toThrow("Native DOM focus is unavailable")
		expect(Object.getOwnPropertyDescriptor(HTMLElement.prototype, "focus")).toEqual(original)
	})

	it("reports an unavailable original focus descriptor", () => {
		const getDescriptor = Object.getOwnPropertyDescriptor
		vi.spyOn(Object, "getOwnPropertyDescriptor").mockImplementation((object: object, property: PropertyKey) =>
			object === HTMLElement.prototype && property === "focus" ? undefined : getDescriptor(object, property),
		)
		expect(setup).toThrow("Native DOM focus is unavailable")
		vi.restoreAllMocks()
		expect(Object.getOwnPropertyDescriptor(HTMLElement.prototype, "focus")).toEqual(original)
	})
})
