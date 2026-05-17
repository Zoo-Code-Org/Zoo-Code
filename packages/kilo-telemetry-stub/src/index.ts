export enum TelemetryEvent {
	FEEDBACK_SUBMITTED = "Feedback Submitted",
}

export namespace Telemetry {
	export interface FeedbackProperties {
		feedbackType: string
		message?: string
		email?: string
		[key: string]: unknown
	}

	export interface LlmCompletionProperties {
		[key: string]: unknown
	}

	let enabled = false

	export async function init(_options?: unknown) {}
	export async function shutdown() {}
	export async function updateIdentity(_token: string | null, _accountId?: string | null) {}

	export function isEnabled() {
		return enabled
	}

	export function setEnabled(value: boolean) {
		enabled = value
	}

	export function track(_event: string | TelemetryEvent, _properties?: Record<string, unknown>) {}
	export function trackCliStart() {}
	export function trackCliExit(_exitCode?: number) {}
	export function trackAuthSuccess(_providerID: string) {}
	export function trackAuthLogout(_providerID: string) {}
	export function trackRemoteConnectionOpened() {}
	export function trackLlmCompletion(_properties: LlmCompletionProperties) {}
	export function trackPlanFollowup(_sessionID: string, _action: string) {}
	export function trackFeedback(_properties: FeedbackProperties) {}
}
