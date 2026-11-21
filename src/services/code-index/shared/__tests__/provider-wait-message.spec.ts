import { formatProviderWaitMessage } from "../provider-wait-message"
import { t } from "../../../../i18n"
import { clearAllMocks } from "../../../../test-utils/reset"

vi.mock("../../../../i18n", () => ({ t: vi.fn((key: string) => key) }))

describe("formatProviderWaitMessage", () => {
	beforeEach(() => clearAllMocks())

	it.each([undefined, 123_000])("formats a provider wait with resume time %s", (resumeAt) => {
		const key =
			resumeAt === undefined
				? "embeddings:orchestrator.providerWaiting"
				: "embeddings:orchestrator.providerWaitingUntil"
		expect(formatProviderWaitMessage([{ service: "embedding", resumeAt, waitingFiles: ["waiting.ts"] }])).toBe(key)
		expect(t).toHaveBeenCalledExactlyOnceWith(key, {
			service: "embedding",
			time: resumeAt === undefined ? undefined : new Date(resumeAt).toISOString(),
		})
	})

	it("joins separate provider messages and accepts no waits", () => {
		expect(formatProviderWaitMessage([])).toBe("")
		expect(
			formatProviderWaitMessage([
				{ service: "embedding", waitingFiles: [] },
				{ service: "qdrant", resumeAt: 123_000, waitingFiles: ["waiting.ts"] },
			]),
		).toBe("embeddings:orchestrator.providerWaiting\nembeddings:orchestrator.providerWaitingUntil")
	})
})
