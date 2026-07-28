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

export { classifyError, classifyToolResult, isValidIdentifier } from "./ErrorClassifier"
export {
	encodeUtf8Bytes,
	extractCategoryFromGuided,
	formatErrorDetails,
	getCategoryTitle,
	getErrorTitleFromGuided,
	getPayloadByteLength,
	transformErrorToMessage,
} from "./MessageTransformer"
export {
	ERROR_PATTERNS,
	GUIDANCE_VERSION,
	MODEL_PAYLOAD_BYTE_LIMIT,
	NEXT_ITEM_CHAR_LIMIT,
	NEXT_ITEM_COUNT_LIMIT,
} from "./errorPatterns"
export { createToolErrorInterceptor, SHELL_CIRCUIT_THRESHOLD, ToolErrorInterceptor } from "./ToolErrorInterceptor"
export type {
	DecoratedCallbacks,
	InterceptorOptions,
	InterceptorState,
	InterceptorTaskState,
} from "./ToolErrorInterceptor"
export { getTaskErrorState, hasTaskErrorState, STUCK_LOOP_THRESHOLD, TaskErrorState } from "./TaskErrorState"
export {
	NESTED_DETECTION_MAX_DEPTH,
	NESTED_DETECTION_MAX_NODES,
	validateCwdParameter,
	validateNestedParams,
	VARIANT_CWD_OBJECT_MISUSE,
	VARIANT_NESTED_PARAM_OVERFLOW,
} from "./StructuralValidator"
