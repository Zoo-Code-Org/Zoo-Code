// npx vitest core/assistant-message/__tests__/ToolCallRetentionPolicy.spec.ts

import { describe, it, expect } from "vitest"

import type { NativeToolParseFailure } from "../NativeToolCallParser"
import {
	classifyStreamedCall,
	isProvablyEmptyGhost,
	selectExecutableCall,
	type StreamedCallDisposition,
} from "../ToolCallRetentionPolicy"

describe("ToolCallRetentionPolicy", () => {
	describe("classifyStreamedCall", () => {
		it("drops a call with no name and no arguments after stream end", () => {
			const disposition = classifyStreamedCall({
				callId: "call_ghost_001",
				toolName: "",
				argumentsAccumulator: "",
				streamEnded: true,
			})

			expect(disposition.kind).toBe("drop-provably-empty")
			if (disposition.kind === "drop-provably-empty") {
				expect(disposition.callId).toBe("call_ghost_001")
				expect(disposition.reason).toBe("no-name-and-no-arguments")
			}
		})

		it("drops a call with whitespace-only name and whitespace-only arguments", () => {
			const disposition = classifyStreamedCall({
				callId: "call_ghost_002",
				toolName: "   ",
				argumentsAccumulator: "  \n\t ",
				streamEnded: true,
			})

			expect(disposition.kind).toBe("drop-provably-empty")
		})

		it("drops a call with undefined name and empty arguments", () => {
			const disposition = classifyStreamedCall({
				callId: "call_ghost_003",
				toolName: undefined,
				argumentsAccumulator: "",
				streamEnded: true,
			})

			expect(disposition.kind).toBe("drop-provably-empty")
		})

		it("does NOT drop when stream has not ended (even if name and args are empty)", () => {
			const disposition = classifyStreamedCall({
				callId: "call_streaming_004",
				toolName: "",
				argumentsAccumulator: "",
				streamEnded: false,
			})

			expect(disposition.kind).toBe("retain")
		})

		it("retains a named call even with empty arguments (not a ghost)", () => {
			const disposition = classifyStreamedCall({
				callId: "call_named_empty_005",
				toolName: "search_files",
				argumentsAccumulator: "{}",
				streamEnded: true,
			})

			// A named call with {} is a malformed named call, NOT a ghost.
			expect(disposition.kind).toBe("retain")
		})

		it("retains a call with argument bytes even without a name", () => {
			const disposition = classifyStreamedCall({
				callId: "call_args_no_name_006",
				toolName: "",
				argumentsAccumulator: '{"path":"src"}',
				streamEnded: true,
			})

			// Has argument bytes → carries partial model intent → NOT a ghost.
			expect(disposition.kind).toBe("retain")
		})

		it("retains as error when a parse failure is present", () => {
			const failure: NativeToolParseFailure = {
				kind: "json_syntax",
			}

			const disposition = classifyStreamedCall({
				callId: "call_parse_failure_007",
				toolName: "search_files",
				argumentsAccumulator: '{"path":"src" broken}',
				streamEnded: true,
				parseFailure: failure,
			})

			expect(disposition.kind).toBe("retain-as-error")
			if (disposition.kind === "retain-as-error") {
				expect(disposition.callId).toBe("call_parse_failure_007")
				expect(disposition.failure).toBe(failure)
			}
		})

		it("retains as error when parse failure is present even without a name", () => {
			const failure: NativeToolParseFailure = {
				kind: "missing_required_arguments",
				emptyArguments: true,
			}

			const disposition = classifyStreamedCall({
				callId: "call_failure_no_name_008",
				toolName: "",
				argumentsAccumulator: "",
				streamEnded: true,
				parseFailure: failure,
			})

			// If the parser already classified a failure, the call had enough
			// structure to be classified — it is NOT a ghost.
			expect(disposition.kind).toBe("retain-as-error")
		})
	})

	describe("isProvablyEmptyGhost", () => {
		it("returns true for drop-provably-empty disposition", () => {
			const disposition: StreamedCallDisposition = {
				kind: "drop-provably-empty",
				callId: "call_009",
				reason: "no-name-and-no-arguments",
			}

			expect(isProvablyEmptyGhost(disposition)).toBe(true)
		})

		it("returns false for retain disposition", () => {
			const disposition: StreamedCallDisposition = {
				kind: "retain",
				callId: "call_010",
			}

			expect(isProvablyEmptyGhost(disposition)).toBe(false)
		})

		it("returns false for retain-as-error disposition", () => {
			const disposition: StreamedCallDisposition = {
				kind: "retain-as-error",
				callId: "call_011",
				failure: { kind: "json_syntax" },
			}

			expect(isProvablyEmptyGhost(disposition)).toBe(false)
		})
	})

	describe("selectExecutableCall", () => {
		it("selects the single valid candidate under single-call policy", () => {
			const result = selectExecutableCall({
				calls: [
					{
						callId: "call_valid_012",
						toolName: "search_files",
						hasNativeArgs: true,
						isPartial: false,
					},
				],
				maxCallsPerTurn: 1,
			})

			expect(result.executableCallId).toBe("call_valid_012")
			expect(result.rejectedCallIds).toEqual([])
			expect(result.reason).toBe("single-valid-candidate")
		})

		it("rejects all valid candidates when two arrive under single-call policy", () => {
			const result = selectExecutableCall({
				calls: [
					{
						callId: "call_valid_a_013",
						toolName: "search_files",
						hasNativeArgs: true,
						isPartial: false,
					},
					{
						callId: "call_valid_b_013",
						toolName: "read_file",
						hasNativeArgs: true,
						isPartial: false,
					},
				],
				maxCallsPerTurn: 1,
			})

			expect(result.executableCallId).toBeUndefined()
			expect(result.rejectedCallIds).toContain("call_valid_a_013")
			expect(result.rejectedCallIds).toContain("call_valid_b_013")
			expect(result.reason).toBe("multiple-valid-calls-under-single-policy")
		})

		it("selects the valid call when first is malformed and second is valid", () => {
			const result = selectExecutableCall({
				calls: [
					{
						callId: "call_malformed_014",
						toolName: "search_files",
						hasNativeArgs: false,
						isPartial: false,
					},
					{
						callId: "call_valid_014",
						toolName: "search_files",
						hasNativeArgs: true,
						isPartial: false,
					},
				],
				maxCallsPerTurn: 1,
			})

			// Only one valid candidate → it may execute.
			expect(result.executableCallId).toBe("call_valid_014")
			expect(result.rejectedCallIds).toEqual([])
		})

		it("selects the valid call when first is valid and second is malformed", () => {
			const result = selectExecutableCall({
				calls: [
					{
						callId: "call_valid_015",
						toolName: "search_files",
						hasNativeArgs: true,
						isPartial: false,
					},
					{
						callId: "call_malformed_015",
						toolName: "search_files",
						hasNativeArgs: false,
						isPartial: false,
					},
				],
				maxCallsPerTurn: 1,
			})

			expect(result.executableCallId).toBe("call_valid_015")
			expect(result.rejectedCallIds).toEqual([])
		})

		it("returns no executable when no valid candidates exist", () => {
			const result = selectExecutableCall({
				calls: [
					{
						callId: "call_malformed_016",
						toolName: "search_files",
						hasNativeArgs: false,
						isPartial: false,
					},
				],
				maxCallsPerTurn: 1,
			})

			expect(result.executableCallId).toBeUndefined()
			expect(result.rejectedCallIds).toEqual([])
			expect(result.reason).toBe("no-valid-candidates")
		})

		it("ignores partial calls when selecting under single-call policy", () => {
			const result = selectExecutableCall({
				calls: [
					{
						callId: "call_partial_017",
						toolName: "search_files",
						hasNativeArgs: true,
						isPartial: true,
					},
				],
				maxCallsPerTurn: 1,
			})

			// Partial calls are not candidates.
			expect(result.executableCallId).toBeUndefined()
			expect(result.reason).toBe("no-valid-candidates")
		})

		it("returns first valid call under unbounded policy with no rejections", () => {
			const result = selectExecutableCall({
				calls: [
					{
						callId: "call_valid_a_018",
						toolName: "search_files",
						hasNativeArgs: true,
						isPartial: false,
					},
					{
						callId: "call_valid_b_018",
						toolName: "read_file",
						hasNativeArgs: true,
						isPartial: false,
					},
				],
				maxCallsPerTurn: "unbounded",
			})

			// Unbounded policy: no local enforcement, all valid calls may execute.
			expect(result.executableCallId).toBe("call_valid_a_018")
			expect(result.rejectedCallIds).toEqual([])
			expect(result.reason).toBe("unbounded-policy")
		})

		it("rejects three valid calls under single-call policy", () => {
			const result = selectExecutableCall({
				calls: [
					{
						callId: "call_a_019",
						toolName: "search_files",
						hasNativeArgs: true,
						isPartial: false,
					},
					{
						callId: "call_b_019",
						toolName: "read_file",
						hasNativeArgs: true,
						isPartial: false,
					},
					{
						callId: "call_c_019",
						toolName: "list_files",
						hasNativeArgs: true,
						isPartial: false,
					},
				],
				maxCallsPerTurn: 1,
			})

			expect(result.executableCallId).toBeUndefined()
			expect(result.rejectedCallIds).toHaveLength(3)
			expect(result.rejectedCallIds).toContain("call_a_019")
			expect(result.rejectedCallIds).toContain("call_b_019")
			expect(result.rejectedCallIds).toContain("call_c_019")
		})
	})
})
