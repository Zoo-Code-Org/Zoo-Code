// npx vitest run src/__tests__/looksLikeFilePath.spec.ts

import { looksLikeFilePath } from "../utils/looksLikeFilePath.js"

describe("looksLikeFilePath", () => {
	describe("nullish, empty, and whitespace-only input", () => {
		it.each([
			["undefined", undefined],
			["null", null],
			["empty string", ""],
			["whitespace only", "   \t\n  "],
		])("returns false for %s", (_label, value) => {
			expect(looksLikeFilePath(value)).toBe(false)
		})
	})

	describe("path-shaped input", () => {
		it.each([
			["Windows backslash path", "C:\\Users\\dev\\sa.json"],
			["Windows forward-slash path", "C:/Users/dev/sa.json"],
			["Windows drive lowercase", "d:\\creds.json"],
			["POSIX absolute path", "/home/dev/sa.json"],
			["POSIX absolute root /tmp", "/tmp/creds.json"],
			["POSIX home path", "~/sa.json"],
			["POSIX relative ./", "./sa.json"],
			["POSIX relative ../", "../secrets/sa.json"],
		])("returns true for %s", (_label, value) => {
			expect(looksLikeFilePath(value)).toBe(true)
		})

		it("returns true after trimming surrounding whitespace", () => {
			expect(looksLikeFilePath("  /tmp/creds.json  ")).toBe(true)
			expect(looksLikeFilePath("\tC:\\sa.json\n")).toBe(true)
		})
	})

	describe("JSON-shaped or bare-token input", () => {
		it.each([
			["JSON object", '{"type":"service_account","client_email":"x@y.z"}'],
			["JSON array", "[1,2,3]"],
			["JSON with leading whitespace", '   {"type":"service_account"}'],
			["bare token", "not-json-and-not-a-path"],
			["service-account-style email", "sa@project.iam.gserviceaccount.com"],
		])("returns false for %s", (_label, value) => {
			expect(looksLikeFilePath(value)).toBe(false)
		})
	})
})
