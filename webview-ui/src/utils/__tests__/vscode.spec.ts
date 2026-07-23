import { VSCodeAPIWrapper } from "../vscode"

const originalCrypto = globalThis.crypto
const originalLocalStorage = globalThis.localStorage

const createMockStorage = (initialState: Record<string, string> = {}) => {
	const state = { ...initialState }
	return {
		getItem: vi.fn((key: string) => state[key] ?? null),
		setItem: vi.fn((key: string, value: string) => {
			state[key] = value
		}),
		removeItem: vi.fn((key: string) => {
			delete state[key]
		}),
		clear: vi.fn(() => {
			for (const key of Object.keys(state)) {
				delete state[key]
			}
		}),
	} as unknown as Storage
}

describe("VSCodeAPIWrapper", () => {
	afterEach(() => {
		vi.restoreAllMocks()
		Object.defineProperty(globalThis, "crypto", {
			configurable: true,
			value: originalCrypto,
		})
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: originalLocalStorage,
		})
	})

	it("reuses the persisted webview viewStateId when browser storage is available", () => {
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: createMockStorage({ vscodeState: JSON.stringify({ viewStateId: "persisted-view" }) }),
		})
		const wrapper = new VSCodeAPIWrapper()

		expect(wrapper.getViewStateId()).toBe("persisted-view")
	})

	it("creates and persists a new viewStateId when storage has been cleared", () => {
		Object.defineProperty(globalThis, "crypto", {
			configurable: true,
			value: { randomUUID: vi.fn(() => "generated-view") },
		})
		const storage = createMockStorage()
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: storage,
		})
		const wrapper = new VSCodeAPIWrapper()

		expect(wrapper.getViewStateId()).toBe("generated-view")
		expect(JSON.parse(storage.getItem("vscodeState")!)).toMatchObject({ viewStateId: "generated-view" })
	})

	it("falls back to in-memory state when browser storage access is restricted", () => {
		Object.defineProperty(globalThis, "crypto", {
			configurable: true,
			value: { randomUUID: vi.fn(() => "memory-view") },
		})
		const storage = {
			getItem: vi.fn(() => {
				throw new Error("storage denied")
			}),
			setItem: vi.fn(() => {
				throw new Error("storage denied")
			}),
		} as unknown as Storage
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: storage,
		})
		const wrapper = new VSCodeAPIWrapper()

		expect(wrapper.getViewStateId()).toBe("memory-view")
		expect(wrapper.getViewStateId()).toBe("memory-view")
		expect(storage.getItem).toHaveBeenCalled()
		expect(storage.setItem).toHaveBeenCalled()
	})
})
