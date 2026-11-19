// vitest core/config/__tests__/ContextProxy.globalStateRestore.spec.ts

import * as vscode from "vscode"

import { makeEventEmitter, makeExtensionContext, makeUri } from "../../../test-utils/vscode"
import { ContextProxy, isPassThroughStateKey } from "../ContextProxy"

vi.mock("vscode", () => ({
	Uri: {
		file: vi.fn((path: string) => ({ path })),
	},
	ExtensionMode: {
		Development: 1,
		Production: 2,
		Test: 3,
	},
}))

// Storage failures are correlated in the real world - a full disk or an unavailable store makes
// every write fail at once - so the interesting case is two writes in flight together, where the
// value an older write would restore is itself something storage never accepted.
describe("ContextProxy globalState cache restore", () => {
	const KEY = "currentApiConfigName"

	const setup = (persisted: string, failOnValues: readonly string[] = [], deferredUpdates = false) => {
		const store = new Map<string, unknown>([[KEY, persisted]])
		let storageWorks = true

		// Deferred mode for the two overlapping-write cases below: each update parks in this list instead
		// of rejecting at once, so the test - not the fixture - decides whose rejection handler runs first.
		const pending: { value: unknown; resolve: () => void; reject: (error: Error) => void }[] = []

		// Plain functions rather than vi.fn for the memento doubles: vitest's Mock wrapper
		// instantiates a generic signature at its call-site type, which drops the genericity
		// Memento.get and Secrets.get are declared with, and nothing here asserts on spies.
		// The store read carries one widening cast to come back as T, the same shape
		// makeWorkspaceConfiguration uses for its own generic get.
		const mockGlobalState = {
			get<T>(key: string, defaultValue?: T): T | undefined {
				return (store.get(key) as T | undefined) ?? defaultValue
			},
			keys(): string[] {
				return [...store.keys()]
			},
			setKeysForSync(_keys: readonly string[]): void {},
			async update(key: string, value: unknown): Promise<void> {
				if (deferredUpdates) {
					return new Promise<void>((resolve, reject) => {
						pending.push({ value, resolve, reject })
					})
				}
				if (failOnValues.includes(value as string)) {
					throw new Error("storage unavailable")
				}
				if (!storageWorks) {
					throw new Error("storage unavailable")
				}
				store.set(key, value)
			},
		}
		const mockSecrets = {
			async get(key: string): Promise<string | undefined> {
				return key === KEY ? undefined : "test-secret"
			},
			async store(_key: string, _value: string): Promise<void> {},
			async delete(_key: string): Promise<void> {},
			onDidChange: makeEventEmitter<{ key: string }>().event,
		}
		// The assembled context carries one double assertion: the fixture supplies the storage and
		// log URIs and a packageJSON shim that a real extension context carries as class-backed
		// members, and no typed shape in the vscode module describes this fixture in full.
		// AGENTS.md allows a double assertion as a last resort when a comment explains why, and
		// makeExtensionContext assembles its own return value the same way.
		const context = {
			...makeExtensionContext({
				globalState: mockGlobalState,
				secrets: mockSecrets,
				extensionUri: makeUri("/test/extension"),
				extensionPath: "/test/extension",
				extensionMode: vscode.ExtensionMode.Development,
			}),
			globalStorageUri: makeUri("/test/storage"),
			logUri: makeUri("/test/logs"),
			extension: { packageJSON: { version: "1.0.0" } },
		} as unknown as vscode.ExtensionContext
		return {
			proxy: new ContextProxy(context),
			store,
			setStorageWorks: (works: boolean) => (storageWorks = works),
			pending,
		}
	}
	it("only restores for keys the cache actually owns", () => {
		// Guards the tests below: if this key were passed straight through to storage, the cache
		// would never participate in a rejection and a restore assertion would pass for the wrong
		// reason.
		expect(isPassThroughStateKey(KEY)).toBe(false)
	})

	it.each(["A rejects first", "B rejects first"])(
		"keeps the cache on the persisted value when two overlapping writes both reject (%s)",
		async (_order: string) => {
			const { proxy, store, pending } = setup("X", [], true)
			await proxy.initialize()

			const writeA = Promise.resolve(proxy.updateGlobalState(KEY, "a"))
			const writeB = Promise.resolve(proxy.updateGlobalState(KEY, "b"))

			// Both writes park in the memento, so nothing has rejected yet and the case really does
			// choose whose rejection handler runs first. Rejecting at once, as this fixture used to,
			// made the handlers run in creation order whatever the case awaited first, so the two
			// cases were the same scenario and a B-before-A break could not show up.
			expect(pending.map((p) => p.value)).toEqual(["a", "b"])
			const [a, b] = pending

			if (_order === "A rejects first") {
				a.reject(new Error("storage unavailable"))
				await expect(writeA).rejects.toThrow("storage unavailable")
				b.reject(new Error("storage unavailable"))
				await expect(writeB).rejects.toThrow("storage unavailable")
			} else {
				b.reject(new Error("storage unavailable"))
				await expect(writeB).rejects.toThrow("storage unavailable")
				a.reject(new Error("storage unavailable"))
				await expect(writeA).rejects.toThrow("storage unavailable")
			}

			// Write B owns the key: it started last, so B is the only write allowed to correct the
			// cache, and it reads the value back from the store. Under A rejects first the older write
			// A has already failed and its handler has already run, so it must leave the cache alone
			// even though it ran before the owner. Restoring each write's own pre-write cache value
			// instead - the generation-map design this guard replaced - splits the two cases: measured on
			// that design, A rejects first is the case that ends with the cache advertising 'a', a value
			// the store never accepted, while B rejects first happens to land back on 'X'.
			expect(proxy.getGlobalState(KEY)).toBe("X")
			expect(store.get(KEY)).toBe("X")
		},
	)

	it("keeps the value an older write confirmed when a newer write rejects", async () => {
		// rt4474947849: write A starts, write B starts, A resolves, B rejects. Storage ends
		// holding A's value, so after B's rejection the cache has to report the same thing
		// rather than the value it held before A was confirmed.
		const { proxy, store } = setup("X", ["b"])
		const writeA = proxy.updateGlobalState(KEY, "a")
		const writeB = proxy.updateGlobalState(KEY, "b")

		await expect(Promise.resolve(writeA)).resolves.toBeUndefined()
		await expect(Promise.resolve(writeB)).rejects.toThrow("storage unavailable")

		expect(proxy.getGlobalState(KEY)).toBe("a")
		expect(store.get(KEY)).toBe("a")
	})
	it("restores the value storage last confirmed rather than the value before the failed write", async () => {
		const { proxy, store, setStorageWorks } = setup("X")
		await proxy.initialize()

		await Promise.resolve(proxy.updateGlobalState(KEY, "confirmed"))
		expect(store.get(KEY)).toBe("confirmed")

		setStorageWorks(false)
		const failing = Promise.resolve(proxy.updateGlobalState(KEY, "rejected"))
		await expect(failing).rejects.toThrow("storage unavailable")

		expect(proxy.getGlobalState(KEY)).toBe("confirmed")
		expect(store.get(KEY)).toBe("confirmed")
	})
})
