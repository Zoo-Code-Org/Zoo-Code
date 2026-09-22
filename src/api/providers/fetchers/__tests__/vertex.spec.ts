// Mocks must come first, before imports

const { mockList, mockConstruct } = vi.hoisted(() => ({
	mockList: vi.fn(),
	mockConstruct: vi.fn(),
}))

vi.mock("@google/genai", () => ({
	GoogleGenAI: class {
		constructor(options: unknown) {
			mockConstruct(options)
		}
		models = { list: mockList }
	},
}))

import { getVertexModels } from "../vertex"
import { vertexModels } from "@roo-code/types"

// Builds the async-iterable pager that client.models.list() resolves to. The
// fetcher only iterates it, so a plain async iterable of minimal Model-likes
// (name only) is sufficient — no real SDK Pager is constructed.
function fakePager(names: Array<string | undefined>) {
	const models = names.map((name) => ({ name }))
	return {
		[Symbol.asyncIterator]() {
			let index = 0
			return {
				next(): Promise<IteratorResult<{ name?: string }>> {
					if (index < models.length) {
						return Promise.resolve({ value: models[index++], done: false })
					}
					return Promise.resolve({ value: undefined, done: true })
				},
			}
		},
	}
}

const PROJECT = "test-project"
const REGION = "us-central1"
const RESOURCE_PREFIX = `projects/${PROJECT}/locations/${REGION}/publishers/google`

const SERVICE_ACCOUNT_JSON = JSON.stringify({
	type: "service_account",
	project_id: PROJECT,
	client_email: "sa@example.iam.gserviceaccount.com",
	private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
})

describe("getVertexModels", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockList.mockResolvedValue(fakePager([`${RESOURCE_PREFIX}/models/gemini-3.7-flash`]))
	})

	it("strips everything up to and including the last /models/ segment", async () => {
		mockList.mockResolvedValue(
			fakePager([
				`${RESOURCE_PREFIX}/models/gemini-3.7-flash`,
				`projects/${PROJECT}/locations/${REGION}/models/gemini-2.5-flash-custom`,
			]),
		)

		const models = await getVertexModels(PROJECT, REGION)

		expect(Object.keys(models).sort()).toEqual(["gemini-2.5-flash-custom", "gemini-3.7-flash"])
		expect(Object.getPrototypeOf(models)).toBeNull()
	})

	it("copies static specs from vertexModels for known model IDs", async () => {
		mockList.mockResolvedValue(fakePager([`${RESOURCE_PREFIX}/models/gemini-2.5-flash`]))

		const models = await getVertexModels(PROJECT, REGION)

		expect(models["gemini-2.5-flash"]).toEqual(vertexModels["gemini-2.5-flash"])
		// Known pricing must survive the merge so cost reporting stays accurate.
		expect(models["gemini-2.5-flash"].inputPrice).toBe(vertexModels["gemini-2.5-flash"].inputPrice)
	})

	it("applies Gemini-family defaults without pricing for unknown model IDs", async () => {
		mockList.mockResolvedValue(fakePager([`${RESOURCE_PREFIX}/models/gemini-9.9-future`]))

		const models = await getVertexModels(PROJECT, REGION)

		expect(models["gemini-9.9-future"]).toEqual({
			maxTokens: 65_536,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: true,
			description: "Vertex Gemini model: gemini-9.9-future",
		})
		// No pricing fields: cost must show "unknown", not charge Claude rates.
		expect(models["gemini-9.9-future"].inputPrice).toBeUndefined()
		expect(models["gemini-9.9-future"].outputPrice).toBeUndefined()
	})

	it("excludes Model Garden partner models and non-generative families", async () => {
		mockList.mockResolvedValue(
			fakePager([
				`${RESOURCE_PREFIX}/models/gemini-3.7-flash`,
				`${RESOURCE_PREFIX}/models/claude-sonnet-4-5@20250929`,
				`${RESOURCE_PREFIX}/models/llama-4-maverick-17b-128e-instruct-maas`,
				`${RESOURCE_PREFIX}/models/gemini-embedding-001`,
				`${RESOURCE_PREFIX}/models/gemini-2.5-flash-preview-tts`,
				`${RESOURCE_PREFIX}/models/imagen-3.0-generate-002`,
			]),
		)

		const models = await getVertexModels(PROJECT, REGION)

		// VertexHandler calls publishers/google/models/{id}, so partner models and
		// non-generative families would 404 or fail at request time (issue #785).
		expect(Object.keys(models)).toEqual(["gemini-3.7-flash"])
	})

	it("skips entries without a /models/ segment in the resource name", async () => {
		mockList.mockResolvedValue(fakePager([`projects/${PROJECT}/locations/${REGION}/publishers/google`, undefined]))

		const models = await getVertexModels(PROJECT, REGION)

		expect(Object.keys(models)).toEqual([])
	})

	it("throws a clear error when no project ID is provided", async () => {
		await expect(getVertexModels()).rejects.toThrow("Failed to fetch Vertex models: project ID is required.")
		expect(mockList).not.toHaveBeenCalled()
	})

	it("prefers raw JSON credentials over key file and ADC", async () => {
		await getVertexModels(PROJECT, REGION, "/keys/sa.json", SERVICE_ACCOUNT_JSON)

		expect(mockConstruct).toHaveBeenCalledWith({
			vertexai: true,
			project: PROJECT,
			location: REGION,
			googleAuthOptions: {
				credentials: expect.objectContaining({ client_email: "sa@example.iam.gserviceaccount.com" }),
			},
		})
	})

	it("falls back to the key file when JSON credentials are absent", async () => {
		await getVertexModels(PROJECT, REGION, "/keys/sa.json")

		expect(mockConstruct).toHaveBeenCalledWith({
			vertexai: true,
			project: PROJECT,
			location: REGION,
			googleAuthOptions: { keyFile: "/keys/sa.json" },
		})
	})

	it("treats a file-path-shaped JSON credentials value as absent and uses the key file", async () => {
		await getVertexModels(PROJECT, REGION, "/keys/sa.json", "/keys/other-sa.json")

		expect(mockConstruct).toHaveBeenCalledWith({
			vertexai: true,
			project: PROJECT,
			location: REGION,
			googleAuthOptions: { keyFile: "/keys/sa.json" },
		})
	})

	it("falls back to Application Default Credentials when no credential signal is given", async () => {
		await getVertexModels(PROJECT, REGION)

		expect(mockConstruct).toHaveBeenCalledWith({
			vertexai: true,
			project: PROJECT,
			location: REGION,
		})
	})

	it("omits the location so the SDK default applies when no region is given", async () => {
		await getVertexModels(PROJECT)

		expect(mockConstruct).toHaveBeenCalledWith({
			vertexai: true,
			project: PROJECT,
			location: undefined,
		})
	})

	it("passes the caller's abort signal to the request", async () => {
		const controller = new AbortController()

		await getVertexModels(PROJECT, REGION, undefined, undefined, { signal: controller.signal })

		expect(mockList).toHaveBeenCalledWith({
			config: expect.objectContaining({
				abortSignal: controller.signal,
			}),
		})
	})
})
