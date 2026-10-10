import type { Anthropic } from "@anthropic-ai/sdk"
import type { FileResult } from "./types"
import { formatResponse } from "../../prompts/responses"

type ReadFileResponse = Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>

export class ReadFileResultFormatter {
	format(result: FileResult, supportsImages: boolean): ReadFileResponse {
		let feedbackMessage: string | undefined
		const approvalStatus = result.approvalStatus ?? result.status
		switch (approvalStatus) {
			case "denied":
				feedbackMessage = result.feedbackText
					? formatResponse.toolDeniedWithFeedback(result.feedbackText)
					: formatResponse.toolDenied()
				break
			case "blocked":
			case "error":
			case "cancelled":
			case "unsupported":
			case "pending":
				feedbackMessage = undefined
				break
			case "approved":
				feedbackMessage = result.feedbackText
					? formatResponse.toolApprovedWithFeedback(result.feedbackText)
					: undefined
				break
			default: {
				const unhandledStatus: never = approvalStatus
				throw new Error(`Unhandled read file status: ${unhandledStatus}`)
			}
		}

		const content = result.nativeContent
		const imageBlocks = supportsImages ? this.getReadFileImageBlocks(result) : undefined
		return [
			...(feedbackMessage ? [{ type: "text" as const, text: feedbackMessage }] : []),
			...(imageBlocks ?? []),
			...(content ? [{ type: "text" as const, text: content }] : []),
		]
	}

	private getReadFileImageBlocks(result: FileResult): Anthropic.ImageBlockParam[] {
		const images = [...(result.feedbackImages ?? [])]
		if (result.status === "approved" && result.imageDataUrl) images.push(result.imageDataUrl)
		return formatResponse.imageBlocks(images)
	}
}
