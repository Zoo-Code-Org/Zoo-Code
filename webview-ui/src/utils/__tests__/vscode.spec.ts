import { VSCodeAPIWrapper } from "../vscode"

const originalCrypto = globalThis.crypto
const originalLocalStorage = globalThis.localStorage

// Minimal Storage surface for VSCodeAPIWrapper browser fallback tests. Typed
// precisely (instead of casting to Storage) so each double only promises the
// members the wrapper actually touches.
interface MockStorage {
	getItem(key: string): string | null
	setItem(key: string, value: string): void
	removeItem(key: string): void
	clear(): void
}

const createMockStorage = (initialState: Record<string, string> = {}): MockStorage => {
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
	}
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
		const randomUUID = vi.fn().mockReturnValueOnce("memory-view").mockReturnValueOnce("new-memory-view")
		Object.defineProperty(globalThis, "crypto", {
			configurable: true,
			value: { randomUUID },
		})
		const storage: MockStorage = {
			getItem: vi.fn(() => {
				throw new Error("storage denied")
			}),
			setItem: vi.fn(() => {
				throw new Error("storage denied")
			}),
			removeItem: vi.fn(() => {
				throw new Error("storage denied")
			}),
			clear: vi.fn(() => {
				throw new Error("storage denied")
			}),
		}
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: storage,
		})
		const wrapper = new VSCodeAPIWrapper()

		expect(wrapper.getViewStateId()).toBe("memory-view")
		expect(wrapper.getViewStateId()).toBe("memory-view")
		expect(randomUUID).toHaveBeenCalledTimes(1)
		expect(storage.getItem).toHaveBeenCalled()
		expect(storage.setItem).toHaveBeenCalled()
	})

	it("falls back to a timestamp-random id when crypto.randomUUID is unavailable", () => {
		Object.defineProperty(globalThis, "crypto", {
			configurable: true,
			value: {},
		})
		vi.spyOn(Date, "now").mockReturnValue(1700000000000)
		vi.spyOn(Math, "random").mockReturnValue(0.987654321)
		const storage = createMockStorage()
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: storage,
		})
		const wrapper = new VSCodeAPIWrapper()

		// 1700000000000.toString(36) === "loyw3v28" and (0.987654321).toString(36) ===
		// "0.zk00000ytu", so the deterministic fallback id drops the "0." prefix.
		expect(wrapper.getViewStateId()).toBe("loyw3v28-zk00000ytu")
		expect(JSON.parse(storage.getItem("vscodeState")!)).toMatchObject({ viewStateId: "loyw3v28-zk00000ytu" })
	})

	it("falls back to a timestamp-random id when the crypto global is undefined", () => {
		Object.defineProperty(globalThis, "crypto", {
			configurable: true,
			value: undefined,
		})
		vi.spyOn(Date, "now").mockReturnValue(1700000000000)
		vi.spyOn(Math, "random").mockReturnValue(0.987654321)
		const storage = createMockStorage()
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: storage,
		})
		const wrapper = new VSCodeAPIWrapper()

		// 1700000000000.toString(36) === "loyw3v28" and (0.987654321).toString(36) ===
		// "0.zk00000ytu", so the deterministic fallback id drops the "0." prefix.
		expect(wrapper.getViewStateId()).toBe("loyw3v28-zk00000ytu")
		expect(JSON.parse(storage.getItem("vscodeState")!)).toMatchObject({ viewStateId: "loyw3v28-zk00000ytu" })
	})

	it("falls back to a timestamp-random id when the crypto object lacks randomUUID", () => {
		Object.defineProperty(globalThis, "crypto", {
			configurable: true,
			value: { "": 1 },
		})
		vi.spyOn(Date, "now").mockReturnValue(1700000000000)
		vi.spyOn(Math, "random").mockReturnValue(0.987654321)
		const storage = createMockStorage()
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: storage,
		})
		const wrapper = new VSCodeAPIWrapper()

		// A truthy crypto global without a randomUUID member must still take the
		// deterministic fallback: 1700000000000.toString(36) === "loyw3v28" and
		// (0.987654321).toString(36) === "0.zk00000ytu", so the id drops the "0." prefix.
		expect(wrapper.getViewStateId()).toBe("loyw3v28-zk00000ytu")
		expect(JSON.parse(storage.getItem("vscodeState")!)).toMatchObject({ viewStateId: "loyw3v28-zk00000ytu" })
	})

	it("creates a new viewStateId when the stored state parses to JSON null", () => {
		Object.defineProperty(globalThis, "crypto", {
			configurable: true,
			value: { randomUUID: vi.fn(() => "after-null-view") },
		})
		const storage = createMockStorage({ vscodeState: "null" })
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: storage,
		})
		const wrapper = new VSCodeAPIWrapper()

		expect(wrapper.getViewStateId()).toBe("after-null-view")
		expect(JSON.parse(storage.getItem("vscodeState")!)).toMatchObject({ viewStateId: "after-null-view" })
	})

	it("replaces an empty persisted viewStateId with a freshly created one", () => {
		Object.defineProperty(globalThis, "crypto", {
			configurable: true,
			value: { randomUUID: vi.fn(() => "refilled-view") },
		})
		const storage = createMockStorage({ vscodeState: JSON.stringify({ viewStateId: "" }) })
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: storage,
		})
		const wrapper = new VSCodeAPIWrapper()

		expect(wrapper.getViewStateId()).toBe("refilled-view")
		expect(JSON.parse(storage.getItem("vscodeState")!)).toMatchObject({ viewStateId: "refilled-view" })
	})

	it("replaces a non-object persisted state with a freshly created viewStateId", () => {
		Object.defineProperty(globalThis, "crypto", {
			configurable: true,
			value: { randomUUID: vi.fn(() => "replaced-string-view") },
		})
		// A persisted JSON string is truthy but not an object: the guard must keep it out of
		// the fresh state, so the persisted record contains only the new viewStateId.
		const storage = createMockStorage({ vscodeState: JSON.stringify("stale-string-state") })
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: storage,
		})
		const wrapper = new VSCodeAPIWrapper()

		expect(wrapper.getViewStateId()).toBe("replaced-string-view")
		expect(JSON.parse(storage.getItem("vscodeState")!)).toEqual({ viewStateId: "replaced-string-view" })
	})
})
