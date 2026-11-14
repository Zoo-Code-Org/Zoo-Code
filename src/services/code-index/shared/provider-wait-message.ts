import type { ProviderWaitStatus } from "@roo-code/types"
import { t } from "../../../i18n"

export function formatProviderWaitMessage(waits: readonly ProviderWaitStatus[]): string {
	return waits
		.map((wait) =>
			t(
				wait.resumeAt === undefined
					? "embeddings:orchestrator.providerWaiting"
					: "embeddings:orchestrator.providerWaitingUntil",
				{
					service: wait.service,
					time: wait.resumeAt === undefined ? undefined : new Date(wait.resumeAt).toISOString(),
				},
			),
		)
		.join("\n")
}
