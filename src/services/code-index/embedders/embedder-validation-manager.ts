import { TelemetryService } from "@roo-code/telemetry"
import { TelemetryEventName } from "@roo-code/types"
import type { IEmbedder } from "../interfaces"

export class EmbedderValidationManager {
	public async validateEmbedder(embedder: IEmbedder): Promise<{ valid: boolean; error?: string }> {
		try {
			return await embedder.validateConfiguration()
		} catch (error) {
			TelemetryService.instance.captureEvent(TelemetryEventName.CODE_INDEX_ERROR, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				location: "validateEmbedder",
			})

			return {
				valid: false,
				error: error instanceof Error ? error.message : "embeddings:validation.configurationError",
			}
		}
	}
}
