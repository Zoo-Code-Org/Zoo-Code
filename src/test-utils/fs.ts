import { vi, type Mock } from "vitest"

export type FsPromisesMock = {
	readFile: Mock
	writeFile: Mock
	access: Mock
}

function createDefaultFsPromisesMock(): FsPromisesMock {
	return {
		readFile: vi.fn().mockResolvedValue(""),
		writeFile: vi.fn().mockResolvedValue(undefined),
		access: vi.fn().mockResolvedValue(undefined),
	}
}

export function mockFsPromises(overrides: Partial<FsPromisesMock> = {}): FsPromisesMock {
	return {
		...createDefaultFsPromisesMock(),
		...overrides,
	}
}

export function resetFsPromises(mock: FsPromisesMock): void {
	mock.readFile.mockReset().mockResolvedValue("")
	mock.writeFile.mockReset().mockResolvedValue(undefined)
	mock.access.mockReset().mockResolvedValue(undefined)
}
