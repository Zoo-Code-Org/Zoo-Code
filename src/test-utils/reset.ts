import nock from "nock"
import { vi } from "vitest"

export function clearAllMocks(): void {
	vi.clearAllMocks()
}

export function restoreGlobals(): void {
	vi.restoreAllMocks()
}

export function deleteGlobalFetch(): void {
	Reflect.deleteProperty(globalThis, "fetch")
}

export function resetNock(): void {
	nock.cleanAll()
	nock.abortPendingRequests()
}
