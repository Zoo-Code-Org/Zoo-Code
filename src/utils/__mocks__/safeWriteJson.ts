import { vi } from "vitest"

const actual = await vi.importActual<typeof import("../safeWriteJson")>("../safeWriteJson")

// Mock filesystem operations, but keep error classification shared with the real reader.
export const getErrorCode = actual.getErrorCode
export const safeWriteJson = vi.fn<typeof actual.safeWriteJson>()
export const recoverJsonFile = vi.fn<typeof actual.recoverJsonFile>()
export const removeJsonBackups = vi.fn<typeof actual.removeJsonBackups>()
