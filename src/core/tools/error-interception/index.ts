export type {
	ClassifyOptions,
	ConfidenceLevel,
	ErrorCategory,
	ErrorClassification,
	ErrorPattern,
	ErrorSeverity,
	ErrorSource,
	ErrorStage,
	ErrorType,
	GuidancePayload,
	InterceptionSignal,
	OccurrenceTemplate,
	PatternTemplate,
	RecoveryDisposition,
	RetryPolicy,
	ToolResponse,
	TransformOptions,
} from "./types.ts"

export { classifyError, classifyToolResult } from "./ErrorClassifier"
export {
	ERROR_PATTERNS,
	GUIDANCE_VERSION,
	MODEL_PAYLOAD_BYTE_LIMIT,
	NEXT_ITEM_CHAR_LIMIT,
	NEXT_ITEM_COUNT_LIMIT,
} from "./errorPatterns"
