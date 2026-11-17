import { describe, it, expect, beforeEach, vi } from "vitest"
import { webviewMessageHandler } from "../webviewMessageHandler"
import type { ClineProvider } from "../ClineProvider"
import type { MentionSegment } from "@roo-code/types"
import type { WebviewMessage } from "../../../shared/WebviewMessage"

vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string) => key),
	changeLanguage: vi.fn(),
}))

vi.mock("vscode", () => ({
	window: {
		showErrorMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showInformationMessage: vi.fn(),
	},
	workspace: {
		workspaceFolders: undefined,
		getConfiguration: vi.fn(() => ({
			get: vi.fn(),
			update: vi.fn(),
		})),
	},
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
	Uri: {
		parse: vi.fn((str: string) => ({ toString: () => str })),
		file: vi.fn((path: string) => ({ fsPath: path })),
	},
	env: { openExternal: vi.fn() },
	commands: { executeCommand: vi.fn() },
}))

const { resolveImageMentions } = vi.hoisted(() => ({
	resolveImageMentions: vi.fn(async ({ images }: { images?: string[] }) => ({ text: "", images: images ?? [] })),
}))
vi.mock("../../mentions/resolveImageMentions", () => ({ resolveImageMentions }))

vi.mock("../../task-persistence", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../task-persistence")>()),
	saveTaskMessages: vi.fn(),
}))

const generated = (text: string): MentionSegment => ({ text, source: "generated" })
const user = (text: string): MentionSegment => ({ text, source: "user" })

describe("webviewMessageHandler mention segment forwarding", () => {
	// Narrow double: the handler under test only touches these members.
	// The single cast at construction keeps every use site type-checked.
	let provider: {
		createTask: ReturnType<typeof vi.fn>
		postMessageToWebview: ReturnType<typeof vi.fn>
		getCurrentTask: ReturnType<typeof vi.fn>
		getState: ReturnType<typeof vi.fn>
		postStateToWebview: ReturnType<typeof vi.fn>
		contextProxy: { globalStorageUri: { fsPath: string } }
	}
	let providerAsClineProvider: ClineProvider
	let currentTask: {
		handleWebviewAskResponse: ReturnType<typeof vi.fn>
		messageQueueService: { addMessage: ReturnType<typeof vi.fn>; updateMessage: ReturnType<typeof vi.fn> }
	}

	beforeEach(() => {
		vi.clearAllMocks()
		currentTask = {
			handleWebviewAskResponse: vi.fn(),
			messageQueueService: { addMessage: vi.fn(), updateMessage: vi.fn() },
		}
		provider = {
			createTask: vi.fn().mockResolvedValue({ taskId: "task-1" }),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			getCurrentTask: vi.fn(() => currentTask),
			getState: vi.fn().mockResolvedValue({ maxImageFileSize: 5, maxTotalImageSize: 20 }),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			contextProxy: { globalStorageUri: { fsPath: "/tmp/storage" } },
		}
		providerAsClineProvider = provider as unknown as ClineProvider
	})

	const text = "context @/secret\nuser line"
	const segments = [generated("context @/secret\n"), user("user line")]
	// Segments that the handler must replace with all generated text.
	const rejected = [
		{ label: "omitted", segments: undefined },
		{ label: "not matching the text", segments: [user("other")] },
		{ label: "invalid", segments: [{ text, source: "system" }] },
	]

	describe.each([
		{
			type: "newTask" as const,
			read: () => provider.createTask.mock.calls[0],
			segmentsOf: (call: unknown[]) => (call[3] as { segments: MentionSegment[] }).segments,
		},
		{
			type: "askResponse" as const,
			read: () => currentTask.handleWebviewAskResponse.mock.calls[0],
			segmentsOf: (call: unknown[]) => call[3] as MentionSegment[],
		},
		{
			type: "queueMessage" as const,
			read: () => currentTask.messageQueueService.addMessage.mock.calls[0],
			segmentsOf: (call: unknown[]) => call[2] as MentionSegment[],
		},
	])("$type", ({ type, read, segmentsOf }) => {
		const send = (extra: Record<string, unknown>) =>
			webviewMessageHandler(providerAsClineProvider, {
				type,
				askResponse: "messageResponse",
				...extra,
			} as WebviewMessage)

		it("forwards matching segments", async () => {
			await send({ text, segments })
			expect(segmentsOf(read()!)).toEqual(segments)
		})

		it.each(rejected)("treats segments that are $label as all generated", async ({ segments: bad }) => {
			await send({ text, segments: bad })
			expect(segmentsOf(read()!)).toEqual([generated(text)])
		})

		it.each([
			{ label: "user segment", segments: [user("see @/a.png")], expected: "see @/a.png" },
			{ label: "generated segment", segments: [generated("see @/a.png")], expected: "" },
		])("scans only user text for images with a $label", async ({ segments: given, expected }) => {
			await send({ text: "see @/a.png", segments: given })
			expect(resolveImageMentions).toHaveBeenCalledWith(expect.objectContaining({ text: expected }))
		})
	})

	it("keeps the original text and images when it forwards", async () => {
		const message: WebviewMessage = { type: "newTask", text, segments }
		await webviewMessageHandler(providerAsClineProvider, message)

		expect(provider.createTask).toHaveBeenCalledWith(text, [], undefined, expect.anything(), undefined)
	})

	it("authorizes nothing in an edited message", async () => {
		const submitUserMessage = vi.fn()
		const editTask = {
			taskId: "task-1",
			clineMessages: [{ ts: 1, type: "say", say: "user_feedback", text: "old" }],
			apiConversationHistory: [],
			overwriteClineMessages: vi.fn(),
			overwriteApiConversationHistory: vi.fn(),
			submitUserMessage,
			messageManager: { rewindToTimestamp: vi.fn() },
		}
		provider.getCurrentTask.mockReturnValue(editTask)
		const message: WebviewMessage = { type: "editMessageConfirm", messageTs: 1, text: "see @/a.png" }
		await webviewMessageHandler(providerAsClineProvider, message)

		expect(resolveImageMentions).toHaveBeenCalledWith(expect.objectContaining({ text: "" }))
		expect(submitUserMessage).toHaveBeenCalledWith("see @/a.png", expect.anything(), undefined, undefined, [
			generated("see @/a.png"),
		])
	})

	describe("editQueuedMessage", () => {
		const edit = (payload: unknown) =>
			webviewMessageHandler(providerAsClineProvider, { type: "editQueuedMessage", payload } as WebviewMessage)

		it("forwards a valid edit with its segments", async () => {
			await edit({ id: "q1", text, images: ["data:image/png;base64,AA"], segments })
			expect(currentTask.messageQueueService.updateMessage).toHaveBeenCalledWith(
				"q1",
				text,
				["data:image/png;base64,AA"],
				segments,
			)
		})

		it.each([
			{ label: "user segment", segs: [user("see @/a.png")], scanned: "see @/a.png" },
			{ label: "generated segment", segs: [generated("see @/a.png")], scanned: "" },
		])("scans only user text for images in an edit with a $label", async ({ segs, scanned }) => {
			await edit({ id: "q1", text: "see @/a.png", segments: segs })
			expect(resolveImageMentions).toHaveBeenCalledWith(expect.objectContaining({ text: scanned }))
		})

		it("stores a resolved image once when the edit keeps its mention", async () => {
			resolveImageMentions.mockResolvedValueOnce({ text: "", images: ["data:a", "data:a", "data:b"] })
			await edit({ id: "q1", text: "see @/a.png", images: ["data:a"], segments: [user("see @/a.png")] })
			expect(currentTask.messageQueueService.updateMessage).toHaveBeenCalledWith(
				"q1",
				"see @/a.png",
				["data:a", "data:b"],
				[user("see @/a.png")],
			)
		})

		it.each([
			{ label: "missing", payload: undefined },
			{ label: "not an object", payload: "q1" },
			{ label: "missing an id", payload: { text } },
			{ label: "a non-string text", payload: { id: "q1", text: 1 } },
			{ label: "a non-list images field", payload: { id: "q1", text, images: "x" } },
		])("ignores a payload that is $label", async ({ payload }) => {
			await edit(payload)
			expect(currentTask.messageQueueService.updateMessage).not.toHaveBeenCalled()
		})
	})
})
