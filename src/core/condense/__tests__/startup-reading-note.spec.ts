import Anthropic from "@anthropic-ai/sdk"
import * as fs from "fs"
import * as fileSystem from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import { TelemetryService } from "@roo-code/telemetry"

import type { ApiHandler } from "../../../api"
import { convertToOpenAiMessages } from "../../../api/transform/openai-format"
import { convertAnthropicMessageToGemini } from "../../../api/transform/gemini-format"
import { convertToVsCodeLmMessages } from "../../../api/transform/vscode-lm-format"
import { manageContext } from "../../context-management"
import { readApiMessages, saveApiMessages, type ApiMessage } from "../../task-persistence/apiMessages"
import { getEffectiveApiHistory, STARTUP_READING_NOTE, summarizeConversation } from "../index"

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return { ...actual, readFile: vi.fn(actual.readFile) }
})
vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>()
	return { ...actual, readFile: vi.fn(actual.readFile), readFileSync: vi.fn(actual.readFileSync) }
})
vi.mock("vscode", async (importOriginal) => {
	const actual = await importOriginal<typeof import("vscode")>()
	class LanguageModelTextPart {
		constructor(public value: string) {}
	}
	return {
		...actual,
		LanguageModelTextPart,
		LanguageModelChatMessage: {
			User: (content: string | LanguageModelTextPart[]) => ({
				role: "user",
				content: typeof content === "string" ? [new LanguageModelTextPart(content)] : content,
			}),
			Assistant: (content: string | LanguageModelTextPart[]) => ({
				role: "assistant",
				content: typeof content === "string" ? [new LanguageModelTextPart(content)] : content,
			}),
		},
	}
})

const expectedNote = `<system-reminder>
## Startup Reading
Context was condensed. Rule files and skills you read earlier are no longer in context.
Before continuing the task, redo the startup reading your current mode's instructions require,
as you would at mode start, using your usual tools. If they require none, continue the task.
</system-reminder>`
const summaryText = "Startup reading was already completed; continue implementing the task."
const environmentDetails = "<environment_details>Current workspace</environment_details>"
const noteBlock = { type: "text", text: STARTUP_READING_NOTE }

function initialHistory(): ApiMessage[] {
	return [
		{ role: "user", content: '<command name="workflow">Continue workflow</command>', ts: 1 },
		{ role: "assistant", content: "Working on the task", ts: 2 },
		{ role: "user", content: "Continue", ts: 3 },
		{ role: "assistant", content: "Made progress", ts: 4 },
		{ role: "user", content: "Next step", ts: 5 },
	]
}

function createProvider(text = summaryText) {
	const createMessage = vi.fn<ApiHandler["createMessage"]>(() =>
		(async function* () {
			yield { type: "text" as const, text }
			yield { type: "usage" as const, inputTokens: 10, outputTokens: 20, totalCost: 0.01 }
		})(),
	)
	const countTokens = vi.fn(async () => 100)
	// Partial double: provides createMessage, countTokens, and getModel.
	const apiHandler = {
		createMessage,
		countTokens,
		getModel: () => ({ id: "test-model", info: { contextWindow: 100000, supportsImages: false } }),
	} as unknown as ApiHandler
	return { apiHandler, createMessage, countTokens }
}

function noteBlocks(messages: ApiMessage[]) {
	return messages.flatMap((message) =>
		Array.isArray(message.content)
			? message.content.filter((block) => block.type === "text" && block.text === STARTUP_READING_NOTE)
			: [],
	)
}

async function condense(messages = initialHistory(), provider = createProvider()) {
	const result = await summarizeConversation({
		messages,
		apiHandler: provider.apiHandler,
		systemPrompt: "Current mode instructions",
		taskId: "startup-reading",
	})
	expect(result.error).toBeUndefined()
	expect(result.summary).toBe(summaryText)
	return result
}

describe("startup-reading note", () => {
	beforeEach(() => {
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}
		vi.clearAllMocks()
	})

	it.each([false, true])(
		"appends the exact last block, automatic=%s, without reading sources",
		async (isAutomaticTrigger) => {
			const readFile = vi.mocked(fileSystem.readFile)
			const readFileCallback = vi.mocked(fs.readFile)
			const readFileSync = vi.mocked(fs.readFileSync)
			const readWorkspaceFile = vi.spyOn(vscode.workspace.fs, "readFile")
			const executeCommand = vi.spyOn(vscode.commands, "executeCommand")
			const provider = createProvider()
			const result = await summarizeConversation({
				messages: initialHistory(),
				apiHandler: provider.apiHandler,
				systemPrompt: "Current mode instructions require reading rules and an applicable skill",
				taskId: "startup-reading",
				isAutomaticTrigger,
				environmentDetails,
				cwd: "/workspace",
			})
			expect(result.error).toBeUndefined()
			expect(STARTUP_READING_NOTE).toBe(expectedNote)
			const summary = getEffectiveApiHistory(result.messages)[0]
			const content = summary.content as Anthropic.Messages.TextBlockParam[]
			expect(content).toHaveLength(isAutomaticTrigger ? 4 : 3)
			expect(content[0].text).toBe(`## Conversation Summary\n${summaryText}`)
			expect(content[1].text).toContain("## Active Workflows")
			if (isAutomaticTrigger) expect(content[2].text).toBe(environmentDetails)
			expect(content.at(-1)).toEqual(noteBlock)
			expect(noteBlocks(result.messages)).toHaveLength(1)
			expect(result.summary).toBe(summaryText)
			expect(provider.countTokens).toHaveBeenCalledWith([
				{ type: "text", text: "Current mode instructions require reading rules and an applicable skill" },
				...content,
			])
			for (const reader of [readFile, readFileCallback, readFileSync, readWorkspaceFile, executeCommand]) {
				expect(reader).not.toHaveBeenCalled()
			}
			expect(provider.createMessage).toHaveBeenCalledTimes(1)
			expect(provider.createMessage.mock.calls[0][2]).toBeUndefined()
		},
	)

	it("creates the note without file reads or tool execution", async () => {
		const readFile = vi.mocked(fileSystem.readFile)
		const executeCommand = vi.spyOn(vscode.commands, "executeCommand")
		const result = await condense()
		expect(noteBlocks(result.messages)).toHaveLength(1)
		expect(readFile).not.toHaveBeenCalled()
		expect(executeCommand).not.toHaveBeenCalled()
	})

	it.each(["failed", "empty", "skipped"])("%s condensation adds no note", async (outcome) => {
		const provider = createProvider(outcome === "empty" ? " \n " : summaryText)
		if (outcome === "failed") {
			provider.createMessage.mockImplementation(() =>
				(async function* () {
					yield { type: "text" as const, text: "Partial summary" }
					throw new Error("Provider failed")
				})(),
			)
		}
		const messages = outcome === "skipped" ? initialHistory().slice(0, 1) : initialHistory()
		const result = await summarizeConversation({
			messages,
			apiHandler: provider.apiHandler,
			systemPrompt: "Current mode instructions",
			taskId: "startup-reading",
		})
		expect(result.messages).toEqual(messages)
		expect(result.error).toBeTruthy()
		expect(result.summary).toBe("")
		expect(noteBlocks(result.messages)).toHaveLength(0)
		if (outcome === "skipped") expect(provider.createMessage).not.toHaveBeenCalled()
	})

	it("real truncation-only context management adds no note", async () => {
		const provider = createProvider()
		const result = await manageContext({
			messages: initialHistory(),
			totalTokens: 95000,
			contextWindow: 100000,
			maxTokens: 1000,
			apiHandler: provider.apiHandler,
			autoCondenseContext: false,
			autoCondenseContextPercent: 75,
			systemPrompt: "Current mode instructions",
			taskId: "startup-reading",
			profileThresholds: {},
			currentProfileId: "default",
		})
		expect(result.truncationId).toBeDefined()
		expect(result.messagesRemoved).toBeGreaterThan(0)
		expect(result.summary).toBe("")
		expect(noteBlocks(result.messages)).toHaveLength(0)
		expect(provider.createMessage).not.toHaveBeenCalled()
	})

	it("two real consecutive summarizer calls leave one current note", async () => {
		const provider = createProvider()
		const first = await condense(initialHistory(), provider)
		const second = await condense(
			[
				...first.messages,
				{ role: "assistant", content: "Progress after condensation", ts: 7 },
				{ role: "user", content: "Continue again", ts: 8 },
			],
			provider,
		)
		expect(provider.createMessage).toHaveBeenCalledTimes(2)
		expect(noteBlocks(first.messages)).toHaveLength(1)
		expect(noteBlocks(second.messages)).toHaveLength(2)
		const effective = getEffectiveApiHistory(second.messages)
		expect(effective).toHaveLength(1)
		expect(effective[0].condenseId).toBe(second.condenseId)
		expect(second.condenseId).not.toBe(first.condenseId)
		expect(noteBlocks(effective)).toHaveLength(1)
	})

	it("preserves one note through real history save/resume and provider transforms with later user content", async () => {
		const globalStoragePath = await fileSystem.mkdtemp(path.join(os.tmpdir(), "roo-startup-note-"))
		try {
			const result = await condense()
			const history = structuredClone(result.messages)
			const summary = history.at(-1)!
			;(summary.content as Anthropic.Messages.ContentBlockParam[]).push({
				type: "text",
				text: "Delegated task completed; continue the parent task.",
			})
			const storage = { taskId: "startup-reading", globalStoragePath }
			await saveApiMessages({ ...storage, messages: history })
			const resumed = await readApiMessages(storage)
			expect(resumed).toEqual(history)
			const effective = getEffectiveApiHistory(resumed)
			expect(noteBlocks(effective)).toHaveLength(1)
			const openAi = convertToOpenAiMessages(effective)
			const gemini = effective.flatMap((message) => convertAnthropicMessageToGemini(message))
			const vsCode = convertToVsCodeLmMessages(effective, false)
			const providerTexts = [
				openAi.flatMap((message) =>
					typeof message.content === "string"
						? [message.content]
						: (message.content ?? []).flatMap((block) => (block.type === "text" ? [block.text] : [])),
				),
				gemini.flatMap((message) =>
					(message.parts ?? []).flatMap((part: { text?: string }) => (part.text ? [part.text] : [])),
				),
				vsCode.flatMap((message) =>
					message.content.flatMap((part) =>
						part instanceof vscode.LanguageModelTextPart ? [part.value] : [],
					),
				),
			]
			for (const texts of providerTexts) {
				expect(texts.join("\n").split(STARTUP_READING_NOTE).length - 1).toBe(1)
				expect(texts.join("\n")).toContain("Delegated task completed; continue the parent task.")
			}
		} finally {
			await fileSystem.rm(globalStoragePath, { recursive: true, force: true })
		}
	})
})
