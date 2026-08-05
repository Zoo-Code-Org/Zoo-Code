/**
 * Tests for ghost tool call quarantine logic.
 *
 * These tests verify the ghost quarantine paths in Task.ts that silently drop
 * "ghost" tool calls — calls with no resolved tool name and no non-whitespace
 * argument bytes at stream completion. Ghosts are transport artifacts, not
 * model intent, and must be removed before insertion into conversation history.
 *
 * The ghost quarantine logic lives in three code paths in Task.ts:
 * - Lines 2937-3009: streaming `tool_call_end` handler (ghostPolicy1)
 * - Lines 3062-3098: legacy `tool_call` chunk handler (ghostPolicy2)
 * - Lines 3449-3499: finalize-raw-chunks handler (ghostPolicy3)
 *
 * Since Task.ts is a massive orchestrator (~5000 lines) requiring extensive
 * VS Code / terminal / filesystem mocking, these tests simulate the quarantine
 * logic in isolation — the same pattern used by `duplicate-tool-use-ids.spec.ts`.
 * The core classification functions (`classifyStreamedCall`,
 * `isProvablyEmptyGhost`) are tested in `ToolCallRetentionPolicy.spec.ts`.
 */

import { classifyStreamedCall, isProvablyEmptyGhost } from "../../assistant-message/ToolCallRetentionPolicy"
import { resolveToolCallPolicy } from "../../../api"
import { mimoModels } from "@roo-code/types"
import type { ModelInfo } from "@roo-code/types"

// Type for the streaming tool call state that Task.ts reads from
// NativeToolCallParser.getStreamingToolCallState()
interface StreamingToolCallState {
	name: string | undefined
	argumentsAccumulator: string
}

// Type for assistant message content blocks
interface AssistantMessageContent {
	type: string
	id?: string
	name?: string
	partial?: boolean
}

// Type for ghost drop telemetry payload
interface GhostDropTelemetry {
	taskId: string
	provider: string
	model: string
	policySource: string
	maxCallsPerTurn: number | string
	enforcement: string
	callCount: number
	ghostDroppedCount: number
	errorResultCount: number
	parallelToolCallsRequested: boolean
}

/**
 * Simulates the ghost quarantine logic from Task.ts lines 2937-3009
 * (streaming tool_call_end handler).
 *
 * This is the first quarantine path: when a `tool_call_end` event arrives,
 * the handler inspects the streaming state BEFORE finalizeStreamingToolCall()
 * deletes it. If the call is a provably empty ghost, it is silently dropped.
 */
function handleStreamingToolCallEnd(
	event: { type: "tool_call_end"; id: string },
	streamingToolCallState: Map<string, StreamingToolCallState>,
	streamingToolCallIndices: Map<string, number>,
	assistantMessageContent: AssistantMessageContent[],
	telemetryLog: GhostDropTelemetry[],
	telemetryContext: { taskId: string; provider: string; model: string; modelInfo: ModelInfo },
): { dropped: boolean; policyLabel: string } {
	const preFinalizeState = streamingToolCallState.get(event.id)
	const ghostDisposition = preFinalizeState
		? classifyStreamedCall({
				callId: event.id,
				toolName: preFinalizeState.name,
				argumentsAccumulator: preFinalizeState.argumentsAccumulator,
				streamEnded: true,
			})
		: undefined

	if (ghostDisposition && isProvablyEmptyGhost(ghostDisposition)) {
		const ghostIndex = streamingToolCallIndices.get(event.id)
		if (ghostIndex !== undefined) {
			assistantMessageContent.splice(ghostIndex, 1)
			for (const [cid, idx] of streamingToolCallIndices.entries()) {
				if (idx > ghostIndex) {
					streamingToolCallIndices.set(cid, idx - 1)
				}
			}
			streamingToolCallIndices.delete(event.id)
		}
		streamingToolCallState.delete(event.id)

		const ghostPolicy1 = resolveToolCallPolicy(telemetryContext.modelInfo, telemetryContext.provider)
		telemetryLog.push({
			taskId: telemetryContext.taskId,
			provider: telemetryContext.provider,
			model: telemetryContext.model,
			policySource: ghostPolicy1.source,
			maxCallsPerTurn: ghostPolicy1.maxCallsPerTurn,
			enforcement: ghostPolicy1.enforcement,
			callCount: assistantMessageContent.filter((b) => b.type === "tool_use").length,
			ghostDroppedCount: 1,
			errorResultCount: 0,
			parallelToolCallsRequested: ghostPolicy1.generation === "parallel",
		})

		return { dropped: true, policyLabel: "ghostPolicy1" }
	}

	return { dropped: false, policyLabel: "none" }
}

/**
 * Simulates the ghost quarantine logic from Task.ts lines 3062-3098
 * (legacy tool_call chunk handler).
 *
 * This is the second quarantine path: when a complete `tool_call` chunk
 * arrives (legacy non-streaming format), the handler classifies it before
 * any history insertion.
 */
function handleLegacyToolCall(
	chunk: { type: "tool_call"; id?: string; name?: string; arguments?: string },
	telemetryLog: GhostDropTelemetry[],
	telemetryContext: { taskId: string; provider: string; model: string; modelInfo: ModelInfo },
): { dropped: boolean; policyLabel: string } {
	const legacyDisposition = classifyStreamedCall({
		callId: chunk.id ?? "",
		toolName: chunk.name,
		argumentsAccumulator: chunk.arguments ?? "",
		streamEnded: true,
	})

	if (isProvablyEmptyGhost(legacyDisposition)) {
		const ghostPolicy2 = resolveToolCallPolicy(telemetryContext.modelInfo, telemetryContext.provider)
		telemetryLog.push({
			taskId: telemetryContext.taskId,
			provider: telemetryContext.provider,
			model: telemetryContext.model,
			policySource: ghostPolicy2.source,
			maxCallsPerTurn: ghostPolicy2.maxCallsPerTurn,
			enforcement: ghostPolicy2.enforcement,
			callCount: 0,
			ghostDroppedCount: 1,
			errorResultCount: 0,
			parallelToolCallsRequested: ghostPolicy2.generation === "parallel",
		})

		return { dropped: true, policyLabel: "ghostPolicy2" }
	}

	return { dropped: false, policyLabel: "none" }
}

/**
 * Simulates the ghost quarantine logic from Task.ts lines 3449-3499
 * (finalize-raw-chunks handler).
 *
 * This is the third quarantine path: when the stream ends, any remaining
 * streaming tool calls are finalized via finalizeRawChunks(). Each resulting
 * `tool_call_end` event goes through the same ghost quarantine as path 1.
 */
function handleFinalizeRawChunks(
	finalizeEvents: Array<{ type: "tool_call_end"; id: string }>,
	streamingToolCallState: Map<string, StreamingToolCallState>,
	streamingToolCallIndices: Map<string, number>,
	assistantMessageContent: AssistantMessageContent[],
	telemetryLog: GhostDropTelemetry[],
	telemetryContext: { taskId: string; provider: string; model: string; modelInfo: ModelInfo },
): { dropped: boolean; policyLabel: string }[] {
	const results: { dropped: boolean; policyLabel: string }[] = []

	for (const event of finalizeEvents) {
		if (event.type === "tool_call_end") {
			const preFinalizeState = streamingToolCallState.get(event.id)
			const ghostDisposition = preFinalizeState
				? classifyStreamedCall({
						callId: event.id,
						toolName: preFinalizeState.name,
						argumentsAccumulator: preFinalizeState.argumentsAccumulator,
						streamEnded: true,
					})
				: undefined

			if (ghostDisposition && isProvablyEmptyGhost(ghostDisposition)) {
				const ghostIndex = streamingToolCallIndices.get(event.id)
				if (ghostIndex !== undefined) {
					assistantMessageContent.splice(ghostIndex, 1)
					for (const [cid, idx] of streamingToolCallIndices.entries()) {
						if (idx > ghostIndex) {
							streamingToolCallIndices.set(cid, idx - 1)
						}
					}
					streamingToolCallIndices.delete(event.id)
				}
				streamingToolCallState.delete(event.id)

				const ghostPolicy3 = resolveToolCallPolicy(telemetryContext.modelInfo, telemetryContext.provider)
				telemetryLog.push({
					taskId: telemetryContext.taskId,
					provider: telemetryContext.provider,
					model: telemetryContext.model,
					policySource: ghostPolicy3.source,
					maxCallsPerTurn: ghostPolicy3.maxCallsPerTurn,
					enforcement: ghostPolicy3.enforcement,
					callCount: assistantMessageContent.filter((b) => b.type === "tool_use").length,
					ghostDroppedCount: 1,
					errorResultCount: 0,
					parallelToolCallsRequested: ghostPolicy3.generation === "parallel",
				})

				results.push({ dropped: true, policyLabel: "ghostPolicy3" })
			} else {
				results.push({ dropped: false, policyLabel: "none" })
			}
		}
	}

	return results
}

describe("Ghost Tool Call Quarantine", () => {
	const telemetryContext = {
		taskId: "test-task-001",
		provider: "mimo",
		model: "mimo-v2.5-pro",
		modelInfo: mimoModels["mimo-v2.5-pro"] as ModelInfo,
	}

	describe("Path 1: Streaming tool_call_end handler (ghostPolicy1)", () => {
		it("should drop a ghost with no name and no arguments", () => {
			const streamingToolCallState = new Map<string, StreamingToolCallState>([
				["call_ghost_1", { name: "", argumentsAccumulator: "" }],
			])
			const streamingToolCallIndices = new Map<string, number>([["call_ghost_1", 0]])
			const assistantMessageContent: AssistantMessageContent[] = [
				{ type: "tool_use", id: "call_ghost_1", name: "", partial: true },
			]
			const telemetryLog: GhostDropTelemetry[] = []

			const result = handleStreamingToolCallEnd(
				{ type: "tool_call_end", id: "call_ghost_1" },
				streamingToolCallState,
				streamingToolCallIndices,
				assistantMessageContent,
				telemetryLog,
				telemetryContext,
			)

			expect(result.dropped).toBe(true)
			expect(result.policyLabel).toBe("ghostPolicy1")

			// Ghost should be removed from assistantMessageContent
			expect(assistantMessageContent).toHaveLength(0)

			// Streaming state should be cleaned up
			expect(streamingToolCallState.has("call_ghost_1")).toBe(false)
			expect(streamingToolCallIndices.has("call_ghost_1")).toBe(false)

			// Telemetry should be emitted
			expect(telemetryLog).toHaveLength(1)
			expect(telemetryLog[0].ghostDroppedCount).toBe(1)
			expect(telemetryLog[0].taskId).toBe("test-task-001")
			expect(telemetryLog[0].provider).toBe("mimo")
			expect(telemetryLog[0].model).toBe("mimo-v2.5-pro")
		})

		it("should drop a ghost with whitespace-only name and arguments", () => {
			const streamingToolCallState = new Map<string, StreamingToolCallState>([
				["call_ghost_2", { name: "   ", argumentsAccumulator: "  \n\t " }],
			])
			const streamingToolCallIndices = new Map<string, number>([["call_ghost_2", 0]])
			const assistantMessageContent: AssistantMessageContent[] = [
				{ type: "tool_use", id: "call_ghost_2", name: "   ", partial: true },
			]
			const telemetryLog: GhostDropTelemetry[] = []

			const result = handleStreamingToolCallEnd(
				{ type: "tool_call_end", id: "call_ghost_2" },
				streamingToolCallState,
				streamingToolCallIndices,
				assistantMessageContent,
				telemetryLog,
				telemetryContext,
			)

			expect(result.dropped).toBe(true)
			expect(assistantMessageContent).toHaveLength(0)
			expect(telemetryLog).toHaveLength(1)
		})

		it("should drop a ghost with undefined name and empty arguments", () => {
			const streamingToolCallState = new Map<string, StreamingToolCallState>([
				["call_ghost_3", { name: undefined, argumentsAccumulator: "" }],
			])
			const streamingToolCallIndices = new Map<string, number>([["call_ghost_3", 0]])
			const assistantMessageContent: AssistantMessageContent[] = [
				{ type: "tool_use", id: "call_ghost_3", name: undefined, partial: true },
			]
			const telemetryLog: GhostDropTelemetry[] = []

			const result = handleStreamingToolCallEnd(
				{ type: "tool_call_end", id: "call_ghost_3" },
				streamingToolCallState,
				streamingToolCallIndices,
				assistantMessageContent,
				telemetryLog,
				telemetryContext,
			)

			expect(result.dropped).toBe(true)
			expect(assistantMessageContent).toHaveLength(0)
		})

		it("should NOT drop a named call with empty arguments (not a ghost)", () => {
			const streamingToolCallState = new Map<string, StreamingToolCallState>([
				["call_named", { name: "read_file", argumentsAccumulator: "{}" }],
			])
			const streamingToolCallIndices = new Map<string, number>([["call_named", 0]])
			const assistantMessageContent: AssistantMessageContent[] = [
				{ type: "tool_use", id: "call_named", name: "read_file", partial: true },
			]
			const telemetryLog: GhostDropTelemetry[] = []

			const result = handleStreamingToolCallEnd(
				{ type: "tool_call_end", id: "call_named" },
				streamingToolCallState,
				streamingToolCallIndices,
				assistantMessageContent,
				telemetryLog,
				telemetryContext,
			)

			expect(result.dropped).toBe(false)
			expect(assistantMessageContent).toHaveLength(1)
			expect(telemetryLog).toHaveLength(0)
		})

		it("should NOT drop a call with argument bytes even without a name", () => {
			const streamingToolCallState = new Map<string, StreamingToolCallState>([
				["call_args", { name: "", argumentsAccumulator: '{"path":"test.ts"}' }],
			])
			const streamingToolCallIndices = new Map<string, number>([["call_args", 0]])
			const assistantMessageContent: AssistantMessageContent[] = [
				{ type: "tool_use", id: "call_args", name: "", partial: true },
			]
			const telemetryLog: GhostDropTelemetry[] = []

			const result = handleStreamingToolCallEnd(
				{ type: "tool_call_end", id: "call_args" },
				streamingToolCallState,
				streamingToolCallIndices,
				assistantMessageContent,
				telemetryLog,
				telemetryContext,
			)

			expect(result.dropped).toBe(false)
			expect(assistantMessageContent).toHaveLength(1)
		})

		it("should re-index remaining streaming tool call indices after ghost removal", () => {
			// Ghost is at index 0, a real call is at index 1.
			// After removing the ghost, the real call should be re-indexed to 0.
			const streamingToolCallState = new Map<string, StreamingToolCallState>([
				["call_ghost", { name: "", argumentsAccumulator: "" }],
				["call_real", { name: "read_file", argumentsAccumulator: '{"path":"a.ts"}' }],
			])
			const streamingToolCallIndices = new Map<string, number>([
				["call_ghost", 0],
				["call_real", 1],
			])
			const assistantMessageContent: AssistantMessageContent[] = [
				{ type: "tool_use", id: "call_ghost", name: "", partial: true },
				{ type: "tool_use", id: "call_real", name: "read_file", partial: true },
			]
			const telemetryLog: GhostDropTelemetry[] = []

			const result = handleStreamingToolCallEnd(
				{ type: "tool_call_end", id: "call_ghost" },
				streamingToolCallState,
				streamingToolCallIndices,
				assistantMessageContent,
				telemetryLog,
				telemetryContext,
			)

			expect(result.dropped).toBe(true)
			expect(assistantMessageContent).toHaveLength(1)
			expect(assistantMessageContent[0].id).toBe("call_real")

			// The real call's index should be decremented from 1 to 0
			expect(streamingToolCallIndices.get("call_real")).toBe(0)
			expect(streamingToolCallIndices.has("call_ghost")).toBe(false)
		})

		it("should handle ghost when streaming state is undefined (preFinalizeState is undefined)", () => {
			// When getStreamingToolCallState returns undefined (already cleaned up),
			// ghostDisposition is undefined and the call is NOT dropped.
			const streamingToolCallState = new Map<string, StreamingToolCallState>()
			const streamingToolCallIndices = new Map<string, number>([["call_missing", 0]])
			const assistantMessageContent: AssistantMessageContent[] = [
				{ type: "tool_use", id: "call_missing", name: "read_file", partial: true },
			]
			const telemetryLog: GhostDropTelemetry[] = []

			const result = handleStreamingToolCallEnd(
				{ type: "tool_call_end", id: "call_missing" },
				streamingToolCallState,
				streamingToolCallIndices,
				assistantMessageContent,
				telemetryLog,
				telemetryContext,
			)

			// No state → no disposition → not dropped
			expect(result.dropped).toBe(false)
			expect(telemetryLog).toHaveLength(0)
		})

		it("should handle ghost when streamingToolCallIndices has no entry for the id", () => {
			// Ghost is detected but ghostIndex is undefined — the splice/index
			// cleanup is skipped, but discardStreamingToolCall still runs.
			const streamingToolCallState = new Map<string, StreamingToolCallState>([
				["call_ghost_no_idx", { name: "", argumentsAccumulator: "" }],
			])
			const streamingToolCallIndices = new Map<string, number>()
			const assistantMessageContent: AssistantMessageContent[] = []
			const telemetryLog: GhostDropTelemetry[] = []

			const result = handleStreamingToolCallEnd(
				{ type: "tool_call_end", id: "call_ghost_no_idx" },
				streamingToolCallState,
				streamingToolCallIndices,
				assistantMessageContent,
				telemetryLog,
				telemetryContext,
			)

			expect(result.dropped).toBe(true)
			// assistantMessageContent is unchanged (no index to splice)
			expect(assistantMessageContent).toHaveLength(0)
			// But streaming state is still cleaned up
			expect(streamingToolCallState.has("call_ghost_no_idx")).toBe(false)
			// Telemetry is still emitted
			expect(telemetryLog).toHaveLength(1)
		})
	})

	describe("Path 2: Legacy tool_call chunk handler (ghostPolicy2)", () => {
		it("should drop a ghost with no name and no arguments", () => {
			const telemetryLog: GhostDropTelemetry[] = []

			const result = handleLegacyToolCall(
				{ type: "tool_call", id: "call_legacy_ghost", name: "", arguments: "" },
				telemetryLog,
				telemetryContext,
			)

			expect(result.dropped).toBe(true)
			expect(result.policyLabel).toBe("ghostPolicy2")
			expect(telemetryLog).toHaveLength(1)
			expect(telemetryLog[0].ghostDroppedCount).toBe(1)
		})

		it("should drop a ghost with undefined name and undefined arguments", () => {
			const telemetryLog: GhostDropTelemetry[] = []

			const result = handleLegacyToolCall(
				{ type: "tool_call", id: "call_legacy_undef" },
				telemetryLog,
				telemetryContext,
			)

			expect(result.dropped).toBe(true)
			expect(telemetryLog).toHaveLength(1)
		})

		it("should drop a ghost with whitespace-only name and arguments", () => {
			const telemetryLog: GhostDropTelemetry[] = []

			const result = handleLegacyToolCall(
				{ type: "tool_call", id: "call_legacy_ws", name: "  ", arguments: " \n " },
				telemetryLog,
				telemetryContext,
			)

			expect(result.dropped).toBe(true)
			expect(telemetryLog).toHaveLength(1)
		})

		it("should NOT drop a named call with empty arguments", () => {
			const telemetryLog: GhostDropTelemetry[] = []

			const result = handleLegacyToolCall(
				{ type: "tool_call", id: "call_legacy_named", name: "read_file", arguments: "{}" },
				telemetryLog,
				telemetryContext,
			)

			expect(result.dropped).toBe(false)
			expect(telemetryLog).toHaveLength(0)
		})

		it("should NOT drop a call with argument bytes even without a name", () => {
			const telemetryLog: GhostDropTelemetry[] = []

			const result = handleLegacyToolCall(
				{ type: "tool_call", id: "call_legacy_args", name: "", arguments: '{"path":"x"}' },
				telemetryLog,
				telemetryContext,
			)

			expect(result.dropped).toBe(false)
			expect(telemetryLog).toHaveLength(0)
		})
	})

	describe("Path 3: Finalize-raw-chunks handler (ghostPolicy3)", () => {
		it("should drop a ghost from finalizeRawChunks output", () => {
			const streamingToolCallState = new Map<string, StreamingToolCallState>([
				["call_fin_ghost", { name: "", argumentsAccumulator: "" }],
			])
			const streamingToolCallIndices = new Map<string, number>([["call_fin_ghost", 0]])
			const assistantMessageContent: AssistantMessageContent[] = [
				{ type: "tool_use", id: "call_fin_ghost", name: "", partial: true },
			]
			const telemetryLog: GhostDropTelemetry[] = []

			const results = handleFinalizeRawChunks(
				[{ type: "tool_call_end", id: "call_fin_ghost" }],
				streamingToolCallState,
				streamingToolCallIndices,
				assistantMessageContent,
				telemetryLog,
				telemetryContext,
			)

			expect(results).toHaveLength(1)
			expect(results[0].dropped).toBe(true)
			expect(results[0].policyLabel).toBe("ghostPolicy3")
			expect(assistantMessageContent).toHaveLength(0)
			expect(telemetryLog).toHaveLength(1)
			expect(telemetryLog[0].ghostDroppedCount).toBe(1)
		})

		it("should drop multiple ghosts from finalizeRawChunks", () => {
			const streamingToolCallState = new Map<string, StreamingToolCallState>([
				["call_fin_ghost1", { name: "", argumentsAccumulator: "" }],
				["call_fin_ghost2", { name: "  ", argumentsAccumulator: " " }],
			])
			const streamingToolCallIndices = new Map<string, number>([
				["call_fin_ghost1", 0],
				["call_fin_ghost2", 1],
			])
			const assistantMessageContent: AssistantMessageContent[] = [
				{ type: "tool_use", id: "call_fin_ghost1", name: "", partial: true },
				{ type: "tool_use", id: "call_fin_ghost2", name: "  ", partial: true },
			]
			const telemetryLog: GhostDropTelemetry[] = []

			const results = handleFinalizeRawChunks(
				[
					{ type: "tool_call_end", id: "call_fin_ghost1" },
					{ type: "tool_call_end", id: "call_fin_ghost2" },
				],
				streamingToolCallState,
				streamingToolCallIndices,
				assistantMessageContent,
				telemetryLog,
				telemetryContext,
			)

			expect(results).toHaveLength(2)
			expect(results.every((r) => r.dropped)).toBe(true)
			expect(assistantMessageContent).toHaveLength(0)
			expect(telemetryLog).toHaveLength(2)
		})

		it("should NOT drop a named call from finalizeRawChunks", () => {
			const streamingToolCallState = new Map<string, StreamingToolCallState>([
				["call_fin_named", { name: "read_file", argumentsAccumulator: '{"path":"x"}' }],
			])
			const streamingToolCallIndices = new Map<string, number>([["call_fin_named", 0]])
			const assistantMessageContent: AssistantMessageContent[] = [
				{ type: "tool_use", id: "call_fin_named", name: "read_file", partial: true },
			]
			const telemetryLog: GhostDropTelemetry[] = []

			const results = handleFinalizeRawChunks(
				[{ type: "tool_call_end", id: "call_fin_named" }],
				streamingToolCallState,
				streamingToolCallIndices,
				assistantMessageContent,
				telemetryLog,
				telemetryContext,
			)

			expect(results).toHaveLength(1)
			expect(results[0].dropped).toBe(false)
			expect(assistantMessageContent).toHaveLength(1)
			expect(telemetryLog).toHaveLength(0)
		})

		it("should handle mixed ghosts and real calls in finalizeRawChunks", () => {
			const streamingToolCallState = new Map<string, StreamingToolCallState>([
				["call_fin_ghost", { name: "", argumentsAccumulator: "" }],
				["call_fin_real", { name: "write_to_file", argumentsAccumulator: '{"path":"a"}' }],
			])
			const streamingToolCallIndices = new Map<string, number>([
				["call_fin_ghost", 0],
				["call_fin_real", 1],
			])
			const assistantMessageContent: AssistantMessageContent[] = [
				{ type: "tool_use", id: "call_fin_ghost", name: "", partial: true },
				{ type: "tool_use", id: "call_fin_real", name: "write_to_file", partial: true },
			]
			const telemetryLog: GhostDropTelemetry[] = []

			const results = handleFinalizeRawChunks(
				[
					{ type: "tool_call_end", id: "call_fin_ghost" },
					{ type: "tool_call_end", id: "call_fin_real" },
				],
				streamingToolCallState,
				streamingToolCallIndices,
				assistantMessageContent,
				telemetryLog,
				telemetryContext,
			)

			expect(results).toHaveLength(2)
			expect(results[0].dropped).toBe(true)
			expect(results[1].dropped).toBe(false)

			// Only the real call should remain
			expect(assistantMessageContent).toHaveLength(1)
			expect(assistantMessageContent[0].id).toBe("call_fin_real")

			// Real call should be re-indexed to 0
			expect(streamingToolCallIndices.get("call_fin_real")).toBe(0)

			// Only one telemetry entry (for the ghost)
			expect(telemetryLog).toHaveLength(1)
		})

		it("should handle empty finalizeEvents array", () => {
			const streamingToolCallState = new Map<string, StreamingToolCallState>()
			const streamingToolCallIndices = new Map<string, number>()
			const assistantMessageContent: AssistantMessageContent[] = []
			const telemetryLog: GhostDropTelemetry[] = []

			const results = handleFinalizeRawChunks(
				[],
				streamingToolCallState,
				streamingToolCallIndices,
				assistantMessageContent,
				telemetryLog,
				telemetryContext,
			)

			expect(results).toHaveLength(0)
			expect(telemetryLog).toHaveLength(0)
		})
	})

	describe("Telemetry payload correctness", () => {
		it("should emit correct telemetry for MiMo provider (single generation)", () => {
			const streamingToolCallState = new Map<string, StreamingToolCallState>([
				["call_telemetry", { name: "", argumentsAccumulator: "" }],
			])
			const streamingToolCallIndices = new Map<string, number>([["call_telemetry", 0]])
			const assistantMessageContent: AssistantMessageContent[] = [
				{ type: "tool_use", id: "call_telemetry", name: "", partial: true },
			]
			const telemetryLog: GhostDropTelemetry[] = []

			handleStreamingToolCallEnd(
				{ type: "tool_call_end", id: "call_telemetry" },
				streamingToolCallState,
				streamingToolCallIndices,
				assistantMessageContent,
				telemetryLog,
				telemetryContext,
			)

			expect(telemetryLog).toHaveLength(1)
			const t = telemetryLog[0]
			expect(t.taskId).toBe("test-task-001")
			expect(t.provider).toBe("mimo")
			expect(t.model).toBe("mimo-v2.5-pro")
			expect(t.policySource).toBe("model-capability")
			expect(t.maxCallsPerTurn).toBe(1)
			expect(t.enforcement).toBe("local")
			expect(t.ghostDroppedCount).toBe(1)
			expect(t.errorResultCount).toBe(0)
			expect(t.parallelToolCallsRequested).toBe(false)
		})

		it("should count remaining tool_use blocks in callCount", () => {
			const streamingToolCallState = new Map<string, StreamingToolCallState>([
				["call_ghost_count", { name: "", argumentsAccumulator: "" }],
			])
			const streamingToolCallIndices = new Map<string, number>([["call_ghost_count", 1]])
			const assistantMessageContent: AssistantMessageContent[] = [
				{ type: "text", id: "text_block" }, // not a tool_use
				{ type: "tool_use", id: "call_ghost_count", name: "", partial: true },
				{ type: "tool_use", id: "call_other", name: "read_file", partial: false },
			]
			const telemetryLog: GhostDropTelemetry[] = []

			handleStreamingToolCallEnd(
				{ type: "tool_call_end", id: "call_ghost_count" },
				streamingToolCallState,
				streamingToolCallIndices,
				assistantMessageContent,
				telemetryLog,
				telemetryContext,
			)

			// After splice, assistantMessageContent has text + one tool_use
			// callCount is computed AFTER the splice, so it should be 1
			expect(telemetryLog[0].callCount).toBe(1)
		})
	})

	describe("Integration scenario: Ghost among real calls", () => {
		it("should drop only the ghost and preserve real calls in correct order", () => {
			// Simulate a stream that produced: real call, ghost, real call
			const streamingToolCallState = new Map<string, StreamingToolCallState>([
				["call_real1", { name: "read_file", argumentsAccumulator: '{"path":"a.ts"}' }],
				["call_ghost_mid", { name: "", argumentsAccumulator: "" }],
				["call_real2", { name: "write_to_file", argumentsAccumulator: '{"path":"b.ts"}' }],
			])
			const streamingToolCallIndices = new Map<string, number>([
				["call_real1", 0],
				["call_ghost_mid", 1],
				["call_real2", 2],
			])
			const assistantMessageContent: AssistantMessageContent[] = [
				{ type: "tool_use", id: "call_real1", name: "read_file", partial: true },
				{ type: "tool_use", id: "call_ghost_mid", name: "", partial: true },
				{ type: "tool_use", id: "call_real2", name: "write_to_file", partial: true },
			]
			const telemetryLog: GhostDropTelemetry[] = []

			// Process the ghost's tool_call_end
			const result = handleStreamingToolCallEnd(
				{ type: "tool_call_end", id: "call_ghost_mid" },
				streamingToolCallState,
				streamingToolCallIndices,
				assistantMessageContent,
				telemetryLog,
				telemetryContext,
			)

			expect(result.dropped).toBe(true)

			// Only the ghost should be removed
			expect(assistantMessageContent).toHaveLength(2)
			expect(assistantMessageContent[0].id).toBe("call_real1")
			expect(assistantMessageContent[1].id).toBe("call_real2")

			// Indices should be re-indexed: call_real1 stays at 0, call_real2 moves from 2 to 1
			expect(streamingToolCallIndices.get("call_real1")).toBe(0)
			expect(streamingToolCallIndices.get("call_real2")).toBe(1)
			expect(streamingToolCallIndices.has("call_ghost_mid")).toBe(false)

			// Telemetry should record 1 ghost drop with callCount=2 (after splice)
			expect(telemetryLog).toHaveLength(1)
			expect(telemetryLog[0].ghostDroppedCount).toBe(1)
			expect(telemetryLog[0].callCount).toBe(2)
		})
	})
})
