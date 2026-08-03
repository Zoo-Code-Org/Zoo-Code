import type { HandleError, PushToolResult, ToolResponse } from "../../../shared/tools"
import { classifyError, classifyToolResult } from "./ErrorClassifier"
import { formatErrorDetails, transformErrorToMessage } from "./MessageTransformer"
import { getTaskErrorState, hasTaskErrorState } from "./TaskErrorState"
import type { ErrorCategory, ErrorClassification, ErrorSource, ErrorStage, InterceptionSignal } from "./types"

/**
 * Per-task state tracked by the ToolErrorInterceptor.
 *
 * - categoryCounts: occurrence counters keyed by category.
 * - shellCircuitOpen: once true, all SHELL_INTEGRATION signals in this task
 *   are short-circuited to a circuit-open guidance message.
 */
export interface InterceptorTaskState {
	categoryCounts: Map<ErrorCategory, number>
	shellCircuitOpen: boolean
}

/** Mutable state container keyed by Task instance using a WeakMap. */
export interface InterceptorState {
	perTask: WeakMap<object, InterceptorTaskState>
}

/** Public callback contract exposed by the adapter. */
export interface DecoratedCallbacks {
	/**
	 * Wraps the original raw handleError callback. The original callback is
	 * invoked first so UI/diagnostics receive the raw error, then a transformed
	 * model-facing result is pushed via pushToolResult.
	 */
	decoratedHandleError: HandleError

	/**
	 * Wraps the original raw pushToolResult callback. If the content is a
	 * structured error result, it is classified and transformed before the
	 * original push.
	 */
	decoratedPushToolResult: PushToolResult

	/**
	 * Raw error handler forwarded verbatim to UI/diagnostics. This is the same
	 * reference that was passed in.
	 */
	rawHandleError: HandleError

	/**
	 * Raw tool result callback forwarded verbatim. This is the same reference
	 * that was passed in.
	 */
	rawPushToolResult: PushToolResult
}

/** Options used to build a per-tool interception context. */
export interface InterceptorOptions {
	taskId: string
	toolCallId?: string
	toolName?: string
	source?: ErrorSource
	stage?: ErrorStage
	metadata?: Record<string, unknown>
}

/** Circuit-open details used when the shell integration breaker trips. */
const CIRCUIT_OPEN_DETAILS = formatErrorDetails(
	"SHELL_INTEGRATION",
	"guided_tool_error",
	"The terminal execution channel is unavailable due to repeated shell integration failures.",
	"The circuit breaker opened after three shell integration failures in this task to prevent repeated command loops.",
	[
		"Stop repeating shell commands in this task.",
		"Continue with non-shell tools where possible.",
		"Ask the user to restore the terminal environment if a shell is required.",
	],
	false,
	1,
	"EI/SHELL_INTEGRATION/CIRCUIT_OPEN",
)

/** Maximum consecutive shell integration failures before the circuit opens. */
export const SHELL_CIRCUIT_THRESHOLD = 3

export class ToolErrorInterceptor {
	private readonly state: InterceptorState

	constructor() {
		this.state = { perTask: new WeakMap() }
	}

	/**
	 * Creates or returns existing per-task state. Uses a WeakMap keyed by the
	 * Task object so state is discarded when the task is garbage collected.
	 *
	 * When `task` is null or undefined (invalid WeakMap key), returns an
	 * ephemeral default state to satisfy the fail-open philosophy rather than
	 * throwing TypeError from WeakMap.set().
	 */
	public getTaskState(task: object): InterceptorTaskState {
		// WeakMap keys must be objects; null/undefined are invalid and would
		// throw TypeError on .set(). Fail-open: return an ephemeral default
		// state so callers can proceed without crashing.
		if (!task) {
			return { categoryCounts: new Map(), shellCircuitOpen: false }
		}
		let taskState = this.state.perTask.get(task)
		if (!taskState) {
			taskState = { categoryCounts: new Map(), shellCircuitOpen: false }
			this.state.perTask.set(task, taskState)
		}
		return taskState
	}

	/**
	 * Resets counters for a single category, or all categories if omitted.
	 *
	 * This method synchronizes both state consumers:
	 * - The ToolErrorInterceptor's per-category counter (and shell circuit flag)
	 * - The corresponding TaskErrorState category (counter, fingerprint, circuit)
	 *
	 * The no-op path is preserved: if the task has no entry in the interceptor's
	 * WeakMap, the method returns early without materializing new state. This is
	 * important because getTaskErrorState() materializes state on call, so we
	 * guard with hasTaskErrorState() before touching TaskErrorState.
	 */
	public resetTaskState(task: object, category?: ErrorCategory): void {
		const taskState = this.state.perTask.get(task)
		if (!taskState) return

		if (category) {
			taskState.categoryCounts.delete(category)
			// A category-specific reset of SHELL_INTEGRATION must also close
			// its category-specific circuit so the next occurrence starts fresh.
			if (category === "SHELL_INTEGRATION") {
				taskState.shellCircuitOpen = false
			}
			// Synchronize the corresponding TaskErrorState category, but only
			// if TaskErrorState already has state for this task (avoid
			// materializing empty state as a side effect of reset).
			if (hasTaskErrorState(task)) {
				getTaskErrorState(task).reset(category)
			}
		} else {
			taskState.categoryCounts.clear()
			taskState.shellCircuitOpen = false
			if (hasTaskErrorState(task)) {
				getTaskErrorState(task).reset()
			}
		}
	}

	/**
	 * Creates a per-task interception context. The returned decorators keep
	 * existing HandleError / PushToolResult signatures so they can be dropped
	 * into existing ToolCallbacks objects without changing tool implementations.
	 */
	public createInterceptor(
		task: object,
		callbacks: { handleError: HandleError; pushToolResult: PushToolResult },
		options: InterceptorOptions,
	): DecoratedCallbacks {
		const taskState = this.getTaskState(task)
		const { handleError: rawHandleError, pushToolResult: rawPushToolResult } = callbacks

		const commonSignal = (overrides?: Partial<InterceptionSignal>): InterceptionSignal => ({
			source: options.source ?? "tool_result",
			stage: options.stage ?? "result",
			taskId: options.taskId,
			toolCallId: options.toolCallId,
			toolName: options.toolName,
			metadata: { ...(options.metadata ?? {}) },
			...overrides,
		})

		const decoratedHandleError: HandleError = async (action: string, error: Error) => {
			// Guard: partial-context callbacks should never be called, but if they
			// are, forward the raw error without transformation.
			if (!options.taskId || options.taskId === "") {
				await rawHandleError(action, error)
				return
			}

			// Extract any structured metadata attached by the tool implementation
			// (e.g. ExecuteCommandTool shell integration flags).
			const attachedMetadata = (error as { __errorMetadata?: Record<string, unknown> }).__errorMetadata

			// Push the transformed model-facing result first so the exactly-once
			// guard in the raw callback preserves the guided payload. The raw error
			// is still emitted to UI/diagnostics afterwards.
			const signal = commonSignal({
				source: "handler_exception",
				stage: "execute",
				error,
				metadata: {
					...options.metadata,
					action,
					...(error instanceof Error ? { errorName: error.name } : {}),
					...(attachedMetadata ? attachedMetadata : {}),
				},
			})

			const transformed = this.transformSignal(task, signal, taskState)
			if (transformed !== undefined) {
				rawPushToolResult(transformed)
			}

			await rawHandleError(action, error)
		}

		const decoratedPushToolResult: PushToolResult = (content: ToolResponse, ...rest: unknown[]) => {
			// If the content is not a plain error string/structured result, pass
			// it through unchanged. This preserves image results, success text,
			// and tool-specific formatted payloads. Forward any extra args (e.g.
			// MCP branch feedbackImages) verbatim.
			if (!this.isErrorResult(content)) {
				;(rawPushToolResult as (content: ToolResponse, ...rest: unknown[]) => void)(content, ...rest)
				return
			}

			// If the result is a plain error string, attempt to classify it based
			// on its text structure before deciding to transform.
			if (typeof content === "string") {
				let parsed: { status?: string; type?: string; error?: unknown } | undefined
				try {
					parsed = JSON.parse(content) as { status?: string; type?: string; error?: unknown }
				} catch {
					parsed = undefined
				}
				const signal = commonSignal({
					result: parsed ?? { text: content },
					metadata: {
						...options.metadata,
						hasErrorResult: true,
					},
				})
				const transformed = this.transformSignal(task, signal, taskState)
				if (transformed !== undefined) {
					;(rawPushToolResult as (content: ToolResponse, ...rest: unknown[]) => void)(transformed, ...rest)
					return
				}
			} else {
				const text = content
					.filter((item) => item.type === "text")
					.map((item) => (item as { text: string }).text)
					.join("\n")
				const signal = commonSignal({
					result: { text, status: this.inferStatus(text) },
					metadata: {
						...options.metadata,
						hasErrorResult: true,
					},
				})
				const transformed = this.transformSignal(task, signal, taskState)
				if (transformed !== undefined) {
					const nonTextBlocks = content.filter((item) => item.type !== "text")
					;(rawPushToolResult as (content: ToolResponse, ...rest: unknown[]) => void)(
						[{ type: "text", text: transformed } as (typeof content)[number], ...nonTextBlocks],
						...rest,
					)
					return
				}
			}

			// Fail-open: unclassified or malformed error results keep the
			// original behavior.
			;(rawPushToolResult as (content: ToolResponse, ...rest: unknown[]) => void)(content, ...rest)
		}

		return {
			decoratedHandleError,
			decoratedPushToolResult,
			rawHandleError,
			rawPushToolResult,
		}
	}

	/**
	 * Classifies a signal and returns a transformed model-facing result, or
	 * undefined when the adapter should fail-open to preserve the original result.
	 */
	private transformSignal(
		task: object,
		signal: InterceptionSignal,
		taskState: InterceptorTaskState,
	): ToolResponse | undefined {
		const classification = classifyError(signal)
		if (classification.category === "UNCLASSIFIED" || classification.patternId === "EI/UNCLASSIFIED/001") {
			console.warn(
				`[ErrorInterceptor] Unclassified error pattern — passing through without guidance. tool=${signal.toolName ?? "unknown"} patternId=${classification.patternId}`,
			)
			return undefined
		}

		// Circuit breaker: after the threshold, short-circuit shell errors.
		if (classification.category === "SHELL_INTEGRATION" && taskState.shellCircuitOpen) {
			return CIRCUIT_OPEN_DETAILS
		}

		const occurrence = this.incrementAndGetCount(task, taskState, classification.category)

		if (classification.category === "SHELL_INTEGRATION" && occurrence >= SHELL_CIRCUIT_THRESHOLD) {
			taskState.shellCircuitOpen = true
			return CIRCUIT_OPEN_DETAILS
		}

		return transformErrorToMessage(classification, { occurrence })
	}

	/**
	 * Increments the per-category counter and returns the new occurrence count.
	 */
	private incrementAndGetCount(task: object, taskState: InterceptorTaskState, category: ErrorCategory): number {
		const next = (taskState.categoryCounts.get(category) ?? 0) + 1
		taskState.categoryCounts.set(category, next)
		return next
	}

	/**
	 * Heuristic check for whether a ToolResponse content looks like an error.
	 * Success outputs, toolResult payloads, and images pass through unchanged.
	 */
	private isErrorResult(content: ToolResponse): boolean {
		if (typeof content === "string") {
			if (content.length === 0) return false
			const trimmed = content.trim()
			// Preserve explicit success JSON.
			if (trimmed.startsWith('{"status":"ok"') || trimmed.startsWith('{"status":"success"')) return false
			// Treat structured error JSON and explicit error markers as errors.
			if (trimmed.startsWith('{"status":"error"') || trimmed.startsWith('{"status":"denied"')) return true
			if (trimmed.startsWith("Error:") || trimmed.startsWith("error:") || trimmed.startsWith("ERROR")) return true
			if (trimmed.startsWith("<error_details>")) return true
			if (trimmed.startsWith("File does not exist")) return true
			if (trimmed.startsWith("cannot find path") || trimmed.startsWith("Path not found")) return true
			if (trimmed.startsWith("apply_diff failed") || trimmed.includes("no sufficiently similar match"))
				return true
			return false
		}

		if (Array.isArray(content) && content.length > 0) {
			const text = content
				.filter((item) => item.type === "text")
				.map((item) => (item as { text: string }).text)
				.join("\n")
			return text.length > 0 && this.isErrorResult(text)
		}

		return false
	}

	/**
	 * Infer a structured status from error text for classifier use.
	 */
	private inferStatus(text: string): string | undefined {
		const trimmed = text.trim()
		if (trimmed.startsWith('{"status":"error"')) return "error"
		if (trimmed.startsWith('{"status":"denied"')) return "denied"
		if (trimmed.startsWith("File does not exist")) return "file-not-found"
		if (trimmed.includes("File does not exist")) return "file-not-found"
		return undefined
	}

	/**
	 * Directly classify a structured tool result and return a transformed
	 * message, without touching per-task state. Useful for callers that already
	 * manage the interceptor lifecycle.
	 */
	public transformToolResult(
		result: InterceptionSignal["result"],
		options: { taskId: string; toolCallId?: string; occurrence?: number },
	): string | undefined {
		const classification = classifyToolResult(result, options.taskId, options.toolCallId)
		if (classification.category === "UNCLASSIFIED") {
			return undefined
		}
		return transformErrorToMessage(classification, { occurrence: options.occurrence ?? 1 })
	}

	/**
	 * Transform an arbitrary interception signal into a model-facing message.
	 * This is the preferred entry point for callers that already know the
	 * source, stage, and metadata of a failure (e.g. preflight validation).
	 */
	public transformError(task: object, signal: InterceptionSignal): string | undefined {
		const taskState = this.getTaskState(task)
		const result = this.transformSignal(task, signal, taskState)
		return typeof result === "string" ? result : undefined
	}
}

/** Shared singleton-free factory; tests create their own interceptor instances. */
export function createToolErrorInterceptor(): ToolErrorInterceptor {
	return new ToolErrorInterceptor()
}
