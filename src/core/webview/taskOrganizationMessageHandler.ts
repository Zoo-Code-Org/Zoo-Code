/* eslint-disable @typescript-eslint/no-explicit-any */
import {
	type WebviewMessage,
	type ExtensionMessage,
	type TaskOrganizationMutationRequestV1,
	type TaskOrganizationMutationResultV1,
	taskOrganizationMutationRequestSchema,
} from "@roo-code/types"

import type { ClineProvider } from "./ClineProvider"

/**
 * Handles the `taskOrganizationMutation` webview message.
 *
 * Validates the incoming payload with Zod, applies it through the provider's
 * TaskOrganizationStore, and posts a typed result back to the webview. The
 * result is correlated to the original request by `requestId`. Errors are
 * sanitized and contain no stack trace, disk path, task text, or folder name.
 */
export async function handleTaskOrganizationMessage(provider: ClineProvider, message: WebviewMessage): Promise<void> {
	const rawRequest = message.taskOrganizationMutation

	const parseResult = taskOrganizationMutationRequestSchema.safeParse(rawRequest)

	if (!parseResult.success) {
		const sanitized = parseResult.error.issues
			.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
			.join("; ")

		await provider.postMessageToWebview({
			type: "taskOrganizationMutationResult",
			requestId: typeof rawRequest?.requestId === "string" ? rawRequest.requestId : "",
			taskOrganizationMutationResult: {
				requestId: typeof rawRequest?.requestId === "string" ? rawRequest.requestId : "",
				success: false,
				committedRevision: provider.getTaskOrganizationStore().getState().revision,
				error: {
					code: "TASK_ORG/VALIDATION/001",
					message: `Invalid mutation request: ${sanitized}`,
				},
			},
		} satisfies Partial<ExtensionMessage>)

		return
	}

	const request: TaskOrganizationMutationRequestV1 = parseResult.data

	try {
		const store = provider.getTaskOrganizationStore()
		const result: TaskOrganizationMutationResultV1 = await store.mutate(request.mutation, request.baseRevision)

		await provider.postMessageToWebview({
			type: "taskOrganizationMutationResult",
			requestId: request.requestId,
			taskOrganizationMutationResult: result,
		} satisfies Partial<ExtensionMessage>)
	} catch (error) {
		const messageText = error instanceof Error ? error.message : String(error)

		provider.log(`[TASK_ORG/HANDLER/001] Unexpected error handling task organization mutation: ${messageText}`)

		await provider.postMessageToWebview({
			type: "taskOrganizationMutationResult",
			requestId: request.requestId,
			taskOrganizationMutationResult: {
				requestId: request.requestId,
				success: false,
				committedRevision: provider.getTaskOrganizationStore().getState().revision,
				error: {
					code: "TASK_ORG/PERSISTENCE/005",
					message: "Organization data could not be saved.",
				},
			},
		} satisfies Partial<ExtensionMessage>)
	}
}
