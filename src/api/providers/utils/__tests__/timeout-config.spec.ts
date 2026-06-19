// npx vitest run api/providers/utils/__tests__/timeout-config.spec.ts

import { getApiRequestTimeout } from "../timeout-config"
import * as vscode from "vscode"

// Mock vscode
vitest.mock("vscode", () => ({
	workspace: {
		getConfiguration: vitest.fn().mockReturnValue({
			get: vitest.fn(),
		}),
	},
}))

describe("getApiRequestTimeout", () => {
	let mockGetConfig: any

	beforeEach(() => {
		vitest.clearAllMocks()
		mockGetConfig = vitest.fn()
		;(vscode.workspace.getConfiguration as any).mockReturnValue({
			get: mockGetConfig,
		})
	})

	it("should return default timeout of 600000ms when no configuration is set", () => {
		mockGetConfig.mockReturnValue(600)

		const timeout = getApiRequestTimeout()

		expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith("zoo-code")
		expect(mockGetConfig).toHaveBeenCalledWith("apiRequestTimeout", 600)
		expect(timeout).toBe(600000) // 600 seconds in milliseconds
	})

	it("should return custom timeout in milliseconds when within allowed range", () => {
		mockGetConfig.mockReturnValue(1200) // 20 minutes

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(1200000) // 1200 seconds in milliseconds
	})

	it("should accept the minimum boundary value (1 second)", () => {
		mockGetConfig.mockReturnValue(1)

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(1000)
	})

	it("should accept the maximum boundary value (3600 seconds)", () => {
		mockGetConfig.mockReturnValue(3600)

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(3600000)
	})

	it("should fall back to default for zero (below minimum)", () => {
		mockGetConfig.mockReturnValue(0)

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(600000)
	})

	it("should fall back to default for negative values (below minimum)", () => {
		mockGetConfig.mockReturnValue(-100)

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(600000)
	})

	it("should fall back to default for fractional values below 1", () => {
		mockGetConfig.mockReturnValue(0.5)

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(600000)
	})

	it("should fall back to default for values above the maximum (>3600)", () => {
		mockGetConfig.mockReturnValue(3601)

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(600000)
	})

	it("should fall back to default for very large values", () => {
		mockGetConfig.mockReturnValue(99999)

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(600000)
	})

	it("should handle null by using default", () => {
		mockGetConfig.mockReturnValue(null)

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(600000) // Should fall back to default 600 seconds
	})

	it("should handle undefined by using default", () => {
		mockGetConfig.mockReturnValue(undefined)

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(600000) // Should fall back to default 600 seconds
	})

	it("should handle NaN by using default", () => {
		mockGetConfig.mockReturnValue(NaN)

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(600000) // Should fall back to default 600 seconds
	})

	it("should handle string values by using default", () => {
		mockGetConfig.mockReturnValue("not-a-number") // String instead of number

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(600000) // Should fall back to default since it's not a number
	})

	it("should handle boolean values by using default", () => {
		mockGetConfig.mockReturnValue(true) // Boolean instead of number

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(600000) // Should fall back to default since it's not a number
	})
})
