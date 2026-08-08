const vscode = require("vscode")
const fs = require("fs")
const path = require("path")

// Absolute: the extension host's cwd is not the repo, so a relative path would scatter output.
const OUT_DIR = process.env.LM_PROBE_OUT_DIR || "c:\\git\\<repo>\\.tmp\\transcripts"

function write(name, data) {
	fs.mkdirSync(OUT_DIR, { recursive: true })
	fs.writeFileSync(path.join(OUT_DIR, name), typeof data === "string" ? data : JSON.stringify(data, null, 2))
}

const READ_TOOL = {
	name: "read_file",
	description: "Read the contents of a file at the given path.",
	inputSchema: {
		type: "object",
		properties: { path: { type: "string", description: "File path to read" } },
		required: ["path"],
	},
}

const TOOL_SYSTEM_PROMPT = [
	"You are Zoo Code, an autonomous coding agent.",
	"You accomplish tasks by calling the tools provided to you.",
	"You MUST call exactly one tool per message. Never ask the user a question.",
	"Do not answer from memory; always read the file first using the read_file tool.",
].join("\n")

async function runOnce(model, scenario) {
	const record = {
		scenario: scenario.name,
		modelId: model.id,
		modelFamily: model.family,
		modelVendor: model.vendor,
		modelVersion: model.version,
		maxInputTokens: model.maxInputTokens,
		parts: [],
		concatenatedText: "",
		toolCallParts: [],
		error: null,
	}
	const messages = []
	if (scenario.system) {
		messages.push(vscode.LanguageModelChatMessage.Assistant(scenario.system))
	}
	for (const userText of scenario.userMessages) {
		messages.push(vscode.LanguageModelChatMessage.User(userText))
	}
	const options = { justification: "Empirical probe of leaked tool-call formatting." }
	if (scenario.tools) {
		options.tools = [READ_TOOL]
	}
	try {
		const source = new vscode.CancellationTokenSource()
		const response = await model.sendRequest(messages, options, source.token)
		for await (const chunk of response.stream) {
			const typeName = chunk && chunk.constructor ? chunk.constructor.name : typeof chunk
			if (chunk instanceof vscode.LanguageModelTextPart) {
				record.parts.push({ type: typeName, value: chunk.value })
				record.concatenatedText += chunk.value
			} else if (chunk instanceof vscode.LanguageModelToolCallPart) {
				const call = { type: typeName, name: chunk.name, callId: chunk.callId, input: chunk.input }
				record.parts.push(call)
				record.toolCallParts.push(call)
			} else {
				record.parts.push({ type: typeName, raw: String(chunk) })
			}
		}
	} catch (error) {
		record.error = { name: error && error.name, message: error && error.message, stack: error && error.stack }
	}

	const text = record.concatenatedText
	record.markers = {
		hasInvoke: /<(?:antml:)?invoke\b/i.test(text),
		hasFunctionCalls: /<(?:antml:)?function_calls\b/i.test(text),
		hasAntmlNamespace: /antml:/i.test(text),
		invokeWrappedInFunctionCalls: /<(?:antml:)?function_calls\s*>[\s\S]*?<(?:antml:)?invoke\b/i.test(text),
		bareInvokeWithoutWrapper: /<(?:antml:)?invoke\b/i.test(text) && !/<(?:antml:)?function_calls\b/i.test(text),
		insideFencedCodeBlock: /```[\s\S]*?<(?:antml:)?invoke\b/i.test(text),
	}
	return record
}

function buildScenarios() {
	const longFiller = "This is filler context line used to grow the prompt toward the context window. ".repeat(4000)
	return [
		{
			name: "A_tools_declared_compelling_prompt",
			tools: true,
			system: TOOL_SYSTEM_PROMPT,
			userMessages: ["Read the file c:/git/Zoo-Code/package.json and tell me the version field."],
		},
		{
			name: "B_tools_declared_no_system_prompt",
			tools: true,
			userMessages: ["Read the file c:/git/Zoo-Code/package.json and tell me the version field."],
		},
		{
			name: "C_tools_declared_long_context",
			tools: true,
			system: TOOL_SYSTEM_PROMPT,
			userMessages: [longFiller, "Now read the file c:/git/Zoo-Code/package.json and tell me the version field."],
		},
		{
			name: "D_no_tools_asked_to_emit_markup",
			tools: false,
			system: TOOL_SYSTEM_PROMPT,
			userMessages: [
				"You have a tool named read_file that takes a path. Emit the tool invocation using Anthropic's internal function-call XML format, exactly as you would internally, to read c:/git/Zoo-Code/package.json. Output only the markup.",
			],
		},
		{
			name: "E_quoted_markup_in_prose_false_positive_check",
			tools: true,
			system: TOOL_SYSTEM_PROMPT,
			userMessages: [
				'Do NOT call any tool. Instead, explain in prose what an invoke block looks like, and include a literal example using the tag name "invoke" with a name attribute of read_file and a parameter named path, written as plain text in your answer.',
			],
		},
		{
			name: "F_quoted_markup_in_fenced_code_block",
			tools: true,
			system: TOOL_SYSTEM_PROMPT,
			userMessages: [
				"Do NOT call any tool. Show me, inside a fenced markdown code block, an example of an invoke block naming the tool read_file with a parameter named path set to /etc/passwd. Only output the fenced code block.",
			],
		},
	]
}

async function run() {
	const summary = { startedAt: new Date().toISOString(), vscodeVersion: vscode.version, models: [], runs: [] }
	let models = []
	let selectError = null
	try {
		models = (await vscode.lm.selectChatModels({ vendor: "copilot" })) || []
	} catch (error) {
		selectError = { name: error && error.name, message: error && error.message }
	}
	summary.selectError = selectError
	summary.allModels = models.map((model) => ({
		id: model.id,
		family: model.family,
		vendor: model.vendor,
		version: model.version,
		maxInputTokens: model.maxInputTokens,
	}))

	const claudeModels = models.filter((model) => /claude/i.test(model.id) || /claude/i.test(model.family))
	summary.claudeModelIds = claudeModels.map((model) => model.id)

	if (claudeModels.length === 0) {
		write("summary.json", summary)
		vscode.window.showErrorMessage(
			`LM Probe: no Claude models. selectChatModels returned ${models.length}. ${selectError ? selectError.message : ""}`,
		)
		return
	}

	const scenarios = buildScenarios()
	const REPEATS = 5
	for (const model of claudeModels) {
		for (const scenario of scenarios) {
			for (let iter = 1; iter <= REPEATS; iter++) {
				const record = await runOnce(model, scenario)
				record.iteration = iter
				summary.runs.push({
					scenario: scenario.name,
					modelId: model.id,
					iteration: iter,
					markers: record.markers,
					toolCallPartCount: record.toolCallParts.length,
					textLength: record.concatenatedText.length,
					error: record.error ? record.error.message : null,
				})
				write(`${model.id}__${scenario.name}__run${iter}.json`, record)
				write(`${model.id}__${scenario.name}__run${iter}.txt`, record.concatenatedText)
			}
		}
	}

	summary.finishedAt = new Date().toISOString()
	write("summary.json", summary)
	vscode.window.showInformationMessage(`LM Probe complete: ${summary.runs.length} runs written to ${OUT_DIR}`)
}

function activate(context) {
	// MUST be user-initiated: vscode.lm consent is only granted from a real user gesture, so an
	// activation-time sendRequest is auto-denied with "cannot be used by 'scratch.lmprobe'".
	context.subscriptions.push(
		vscode.commands.registerCommand("lmprobe.run", () =>
			run().catch((error) => {
				write("fatal.json", { message: String(error && error.message), stack: String(error && error.stack) })
			}),
		),
	)
	vscode.window.showInformationMessage("LM Probe ready", "Run probe").then((choice) => {
		if (choice === "Run probe") {
			vscode.commands.executeCommand("lmprobe.run")
		}
	})
}

module.exports = { activate, deactivate() {} }
