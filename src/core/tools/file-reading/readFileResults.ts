import type { FileResult } from "./ReadFileTool"
import type { ToolResponse } from "../../../shared/tools"
import { formatResponse } from "../../prompts/responses"

function getReadFileFeedback(results: FileResult[], didRejectTool: boolean): { message: string; images: string[] } {
	const denied = results.find((result) => result.status === "denied" && result.feedbackText)
	if (denied?.feedbackText) {
		return {
			message: formatResponse.toolDeniedWithFeedback(denied.feedbackText),
			images: denied.feedbackImages ?? [],
		}
	}
	if (didRejectTool) return { message: formatResponse.toolDenied(), images: [] }
	const approved = results.find((result) => result.status === "approved" && result.feedbackText)
	if (approved?.feedbackText) {
		return {
			message: formatResponse.toolApprovedWithFeedback(approved.feedbackText),
			images: approved.feedbackImages ?? [],
		}
	}
	return { message: "", images: [] }
}

export function formatReadFileResults(
	results: FileResult[],
	didRejectTool: boolean,
	supportsImages: boolean,
): ToolResponse {
	const content = results
		.flatMap((result) => (result.nativeContent ? [result.nativeContent] : []))
		.join("\n\n---\n\n")
	const feedback = getReadFileFeedback(results, didRejectTool)
	const images = supportsImages
		? [...feedback.images, ...results.flatMap((result) => (result.imageDataUrl ? [result.imageDataUrl] : []))]
		: []
	if (!feedback.message && !images.length) return content
	const formatted = formatResponse.toolResult(feedback.message || content, images.length ? images : undefined)
	if (!feedback.message) return formatted
	if (typeof formatted === "string") return `${formatted}\n${content}`
	return [...formatted, { type: "text", text: content }]
}
