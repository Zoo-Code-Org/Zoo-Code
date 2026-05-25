import * as fs from "fs/promises"
import * as path from "path"
import { stdin, stdout, stderr } from "process"

type JsonRpcMessage = {
	jsonrpc: "2.0"
	id?: string | number
	method?: string
	params?: {
		name?: string
		arguments?: Record<string, unknown>
	}
}

const workspaceDir = process.argv[2]
const readyFile = process.env.MCP_TEST_READY_FILE

if (!workspaceDir) {
	stderr.write("Missing workspace directory argument\n")
	process.exit(1)
}

let buffer = ""

stdin.setEncoding("utf8")
stdin.on("data", (chunk) => {
	buffer += chunk
	processBuffer().catch((error) => {
		stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
	})
})

async function processBuffer() {
	let newlineIndex = buffer.indexOf("\n")
	while (newlineIndex !== -1) {
		const line = buffer.slice(0, newlineIndex).trim()
		buffer = buffer.slice(newlineIndex + 1)

		if (line) {
			await handleMessage(JSON.parse(line) as JsonRpcMessage)
		}

		newlineIndex = buffer.indexOf("\n")
	}
}

async function handleMessage(message: JsonRpcMessage) {
	if (message.id === undefined) {
		return
	}

	try {
		switch (message.method) {
			case "initialize":
				sendResult(message.id, {
					protocolVersion: "2024-11-05",
					capabilities: { tools: {} },
					serverInfo: { name: "test-filesystem-server", version: "1.0.0" },
				})
				break
			case "tools/list":
				await markReady()
				sendResult(message.id, { tools: getTools() })
				break
			case "resources/list":
				sendResult(message.id, { resources: [] })
				break
			case "resources/templates/list":
				sendResult(message.id, { resourceTemplates: [] })
				break
			case "tools/call":
				sendResult(message.id, await callTool(message.params?.name, message.params?.arguments ?? {}))
				break
			default:
				sendResult(message.id, {})
		}
	} catch (error) {
		sendError(message.id, error instanceof Error ? error.message : String(error))
	}
}

function sendResult(id: string | number, result: unknown) {
	stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
}

function sendError(id: string | number, message: string) {
	stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } })}\n`)
}

async function markReady() {
	if (!readyFile) {
		return
	}

	await fs.mkdir(path.dirname(readyFile), { recursive: true })
	await fs.writeFile(readyFile, "ready")
}

function getTools() {
	const pathInputSchema = {
		type: "object",
		properties: {
			path: { type: "string" },
		},
		required: ["path"],
	}

	return [
		{
			name: "read_file",
			description: "Read a file from the test workspace.",
			inputSchema: pathInputSchema,
		},
		{
			name: "write_file",
			description: "Write a file in the test workspace.",
			inputSchema: {
				type: "object",
				properties: {
					path: { type: "string" },
					content: { type: "string" },
				},
				required: ["path", "content"],
			},
		},
		{
			name: "list_directory",
			description: "List a directory in the test workspace.",
			inputSchema: pathInputSchema,
		},
		{
			name: "directory_tree",
			description: "Return a JSON directory tree for a test workspace path.",
			inputSchema: pathInputSchema,
		},
		{
			name: "get_file_info",
			description: "Return basic metadata for a file in the test workspace.",
			inputSchema: pathInputSchema,
		},
	]
}

async function callTool(name: string | undefined, args: Record<string, unknown>) {
	const requestedPath = typeof args.path === "string" ? args.path : ""

	switch (name) {
		case "read_file": {
			const filePath = resolveWorkspacePath(requestedPath)
			return textResult(await fs.readFile(filePath, "utf8"))
		}
		case "write_file": {
			const filePath = resolveWorkspacePath(requestedPath)
			const content = typeof args.content === "string" ? args.content : ""
			await fs.mkdir(path.dirname(filePath), { recursive: true })
			await fs.writeFile(filePath, content)
			return textResult(`Successfully wrote to ${requestedPath}`)
		}
		case "list_directory": {
			const directoryPath = resolveWorkspacePath(requestedPath)
			const entries = await fs.readdir(directoryPath, { withFileTypes: true })
			const listing = entries
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((entry) => `${entry.isDirectory() ? "[DIR]" : "[FILE]"} ${entry.name}`)
				.join("\n")
			return textResult(listing)
		}
		case "directory_tree": {
			const directoryPath = resolveWorkspacePath(requestedPath)
			return textResult(JSON.stringify(await buildDirectoryTree(directoryPath), null, 2))
		}
		case "get_file_info": {
			const filePath = resolveWorkspacePath(requestedPath)
			const stats = await fs.stat(filePath)
			return textResult(
				[
					`size: ${stats.size}`,
					`isFile: ${stats.isFile()}`,
					`isDirectory: ${stats.isDirectory()}`,
					`permissions: ${stats.mode.toString(8)}`,
				].join("\n"),
			)
		}
		default:
			throw new Error(`Unknown tool: ${name}`)
	}
}

function textResult(text: string) {
	return {
		content: [{ type: "text", text }],
	}
}

function resolveWorkspacePath(requestedPath: string) {
	const resolvedPath = path.resolve(workspaceDir!, requestedPath)
	const workspaceRoot = path.resolve(workspaceDir!)

	if (resolvedPath !== workspaceRoot && !resolvedPath.startsWith(`${workspaceRoot}${path.sep}`)) {
		throw new Error(`Path is outside the test workspace: ${requestedPath}`)
	}

	return resolvedPath
}

async function buildDirectoryTree(
	directoryPath: string,
): Promise<{ name: string; type: string; children?: unknown[] }> {
	const stats = await fs.stat(directoryPath)
	const node: { name: string; type: string; children?: unknown[] } = {
		name: path.basename(directoryPath),
		type: stats.isDirectory() ? "directory" : "file",
	}

	if (!stats.isDirectory()) {
		return node
	}

	const entries = await fs.readdir(directoryPath, { withFileTypes: true })
	node.children = await Promise.all(
		entries
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((entry) => buildDirectoryTree(path.join(directoryPath, entry.name))),
	)

	return node
}
