import type { ClineAskUseMcpServer, McpExecutionStatus } from "@roo-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { t } from "../../i18n"
import { resolveRef } from "./ref/index"
import type { ContentRefParams, ContentSource, ToolUse } from "../../shared/tools"
import { toolNamesMatch } from "../../utils/mcp-name"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface UseMcpToolParams {
	server_name: string
	tool_name: string
	arguments?: Record<string, unknown>
}

type ValidationResult =
	| { isValid: false }
	| {
			isValid: true
			serverName: string
			toolName: string
			parsedArguments?: Record<string, unknown>
	  }

export class UseMcpToolTool extends BaseTool<"use_mcp_tool"> {
	readonly name = "use_mcp_tool" as const

	/**
	 * Scan string arguments for {{ref:...}} markers and resolve them inline.
	 * This enables CRT for MCP tools whose schemas we don't control.
	 */
	private async injectRefsIntoArgs(args: Record<string, unknown>, task: Task): Promise<Record<string, unknown>> {
		const resolved: Record<string, unknown> = {}

		for (const [key, value] of Object.entries(args)) {
			if (typeof value === "string") {
				resolved[key] = await this.resolveInlineRefs(value, task)
			} else if (value !== null && typeof value === "object") {
				// Recursively process nested objects
				resolved[key] = await this.injectRefsIntoArgs(value as Record<string, unknown>, task)
			} else {
				resolved[key] = value
			}
		}

		return resolved
	}

	/**
	 * Resolve all {{ref:...}} markers within a single string.
	 * Pattern: {{ref:source=chat,ref=-1,startAnchor=...,endAnchor=...}}
	 */
	private readonly REF_PATTERN = /\{\{ref:(.*?)\}\}/

	private async resolveInlineRefs(text: string, task: Task): Promise<string> {
		if (!this.REF_PATTERN.test(text)) {
			return text
		}

		let result = text
		let match: RegExpExecArray | null

		// Reset lastIndex
		this.REF_PATTERN.lastIndex = 0

		while ((match = this.REF_PATTERN.exec(result)) !== null) {
			const fullMatch = match[0]
			const paramsStr = match[1]

			// Parse key=value pairs from the ref string
			const params: Record<string, string> = {}
			for (const part of paramsStr.split(",")) {
				const eqIdx = part.indexOf("=")
				if (eqIdx === -1) continue
				const k = part.slice(0, eqIdx).trim()
				const v = part.slice(eqIdx + 1).trim()
				params[k] = v
			}

			try {
				const content = await resolveRef(
					{
						ref: {
							source: (params.source || "chat") as ContentSource,
							ref: params.ref || "-1",
							startAnchor: params.startAnchor,
							endAnchor: params.endAnchor,
							selector: params.selector,
						},
					},
					task,
				)

				result = result.replace(fullMatch, content.content)
			} catch (error) {
				// Graceful fallback: keep the ref marker as-is so model sees failure
				console.error(`[CRT] Failed to resolve inline ref: ${fullMatch}`, error)
			}
		}

		return result
	}

	async execute(params: UseMcpToolParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			// Validate parameters
			const validation = await this.validateParams(task, params, pushToolResult)
			if (!validation.isValid) {
				return
			}

			const { serverName, toolName, parsedArguments } = validation

			// Validate that the tool exists on the server
			const toolValidation = await this.validateToolExists(task, serverName, toolName, pushToolResult)
			if (!toolValidation.isValid) {
				return
			}

			// Use the resolved tool name (original name from the server) for MCP calls
			// This handles cases where models mangle hyphens to underscores
			const resolvedToolName = toolValidation.resolvedToolName ?? toolName

			// Reset mistake count on successful validation
			task.consecutiveMistakeCount = 0

			// Get user approval
			const completeMessage = JSON.stringify({
				type: "use_mcp_tool",
				serverName,
				toolName: resolvedToolName,
				arguments: params.arguments ? JSON.stringify(params.arguments) : undefined,
			} satisfies ClineAskUseMcpServer)

			const executionId = task.lastMessageTs?.toString() ?? Date.now().toString()
			const didApprove = await askApproval("use_mcp_server", completeMessage)

			if (!didApprove) {
				return
			}

			// Execute the tool and process results
			await this.executeToolAndProcessResult(
				task,
				serverName,
				resolvedToolName,
				parsedArguments,
				executionId,
				pushToolResult,
			)
		} catch (error) {
			await handleError("executing MCP tool", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"use_mcp_tool">): Promise<void> {
		const params = block.params
		const partialMessage = JSON.stringify({
			type: "use_mcp_tool",
			serverName: params.server_name ?? "",
			toolName: params.tool_name ?? "",
			arguments: params.arguments,
		} satisfies ClineAskUseMcpServer)

		await task.ask("use_mcp_server", partialMessage, true).catch(() => {})
	}

	private async validateParams(
		task: Task,
		params: UseMcpToolParams,
		pushToolResult: (content: string) => void,
	): Promise<ValidationResult> {
		if (!params.server_name) {
			task.consecutiveMistakeCount++
			task.recordToolError("use_mcp_tool")
			pushToolResult(await task.sayAndCreateMissingParamError("use_mcp_tool", "server_name"))
			return { isValid: false }
		}

		if (!params.tool_name) {
			task.consecutiveMistakeCount++
			task.recordToolError("use_mcp_tool")
			pushToolResult(await task.sayAndCreateMissingParamError("use_mcp_tool", "tool_name"))
			return { isValid: false }
		}

		// Native-only: arguments are already a structured object.
		let parsedArguments: Record<string, unknown> | undefined
		if (params.arguments !== undefined) {
			if (typeof params.arguments !== "object" || params.arguments === null || Array.isArray(params.arguments)) {
				task.consecutiveMistakeCount++
				task.recordToolError("use_mcp_tool")
				await task.say("error", t("mcp:errors.invalidJsonArgument", { toolName: params.tool_name }))
				task.didToolFailInCurrentTurn = true
				pushToolResult(
					formatResponse.toolError(
						formatResponse.invalidMcpToolArgumentError(params.server_name, params.tool_name),
					),
				)
				return { isValid: false }
			}
			parsedArguments = params.arguments
		}

		return {
			isValid: true,
			serverName: params.server_name,
			toolName: params.tool_name,
			parsedArguments,
		}
	}

	private async validateToolExists(
		task: Task,
		serverName: string,
		toolName: string,
		pushToolResult: (content: string) => void,
	): Promise<{ isValid: boolean; availableTools?: string[]; resolvedToolName?: string }> {
		try {
			// Get the MCP hub to access server information
			const provider = task.providerRef.deref()
			const mcpHub = provider?.getMcpHub()

			if (!mcpHub) {
				// If we can't get the MCP hub, we can't validate, so proceed with caution
				return { isValid: true }
			}

			// Get all servers to find the specific one
			const servers = mcpHub.getAllServers()
			const server = servers.find((s) => s.name === serverName)

			if (!server) {
				// Fail fast when server is unknown
				const availableServersArray = servers.map((s) => s.name)
				const availableServers =
					availableServersArray.length > 0 ? availableServersArray.join(", ") : "No servers available"

				task.consecutiveMistakeCount++
				task.recordToolError("use_mcp_tool")
				await task.say("error", t("mcp:errors.serverNotFound", { serverName, availableServers }))
				task.didToolFailInCurrentTurn = true

				pushToolResult(formatResponse.unknownMcpServerError(serverName, availableServersArray))
				return { isValid: false, availableTools: [] }
			}

			// Check if the server has tools defined
			if (!server.tools || server.tools.length === 0) {
				// No tools available on this server
				task.consecutiveMistakeCount++
				task.recordToolError("use_mcp_tool")
				await task.say(
					"error",
					t("mcp:errors.toolNotFound", {
						toolName,
						serverName,
						availableTools: "No tools available",
					}),
				)
				task.didToolFailInCurrentTurn = true

				pushToolResult(formatResponse.unknownMcpToolError(serverName, toolName, []))
				return { isValid: false, availableTools: [] }
			}

			// Check if the requested tool exists (using fuzzy matching to handle model mangling of hyphens)
			const tool = server.tools.find((t) => toolNamesMatch(t.name, toolName))

			if (!tool) {
				// Tool not found - provide list of available tools
				const availableToolNames = server.tools.map((tool) => tool.name)

				task.consecutiveMistakeCount++
				task.recordToolError("use_mcp_tool")
				await task.say(
					"error",
					t("mcp:errors.toolNotFound", {
						toolName,
						serverName,
						availableTools: availableToolNames.join(", "),
					}),
				)
				task.didToolFailInCurrentTurn = true

				pushToolResult(formatResponse.unknownMcpToolError(serverName, toolName, availableToolNames))
				return { isValid: false, availableTools: availableToolNames }
			}

			// Check if the tool is disabled (enabledForPrompt is false)
			if (tool.enabledForPrompt === false) {
				// Tool is disabled - only show enabled tools
				const enabledTools = server.tools.filter((t) => t.enabledForPrompt !== false)
				const enabledToolNames = enabledTools.map((t) => t.name)

				task.consecutiveMistakeCount++
				task.recordToolError("use_mcp_tool")
				await task.say(
					"error",
					t("mcp:errors.toolDisabled", {
						toolName,
						serverName,
						availableTools:
							enabledToolNames.length > 0 ? enabledToolNames.join(", ") : "No enabled tools available",
					}),
				)
				task.didToolFailInCurrentTurn = true

				pushToolResult(formatResponse.unknownMcpToolError(serverName, toolName, enabledToolNames))
				return { isValid: false, availableTools: enabledToolNames }
			}

			// Tool exists and is enabled - return the original tool name for use with the MCP server
			return { isValid: true, availableTools: server.tools.map((t) => t.name), resolvedToolName: tool.name }
		} catch (error) {
			// If there's an error during validation, log it but don't block the tool execution
			// The actual tool call might still fail with a proper error
			console.error("Error validating MCP tool existence:", error)
			return { isValid: true }
		}
	}

	private async sendExecutionStatus(task: Task, status: McpExecutionStatus): Promise<void> {
		const clineProvider = await task.providerRef.deref()
		clineProvider?.postMessageToWebview({
			type: "mcpExecutionStatus",
			text: JSON.stringify(status),
		})
	}

	private processToolContent(toolResult: any): { text: string; images: string[] } {
		if (!toolResult?.content || toolResult.content.length === 0) {
			return { text: "", images: [] }
		}

		const images: string[] = []

		const textContent = toolResult.content
			.map((item: any) => {
				if (item.type === "text") {
					return item.text
				}
				if (item.type === "resource") {
					const { blob: _, ...rest } = item.resource
					return JSON.stringify(rest, null, 2)
				}
				if (item.type === "image") {
					// Handle image content (MCP image content has mimeType and data properties)
					if (item.mimeType && item.data) {
						if (item.data.startsWith("data:")) {
							images.push(item.data)
						} else {
							images.push(`data:${item.mimeType};base64,${item.data}`)
						}
					}
					return ""
				}
				return ""
			})
			.filter(Boolean)
			.join("\n\n")

		return { text: textContent, images }
	}

	private async executeToolAndProcessResult(
		task: Task,
		serverName: string,
		toolName: string,
		parsedArguments: Record<string, unknown> | undefined,
		executionId: string,
		pushToolResult: (content: string | Array<any>) => void,
	): Promise<void> {
		await task.say("mcp_server_request_started")

		// Send started status
		await this.sendExecutionStatus(task, {
			executionId,
			status: "started",
			serverName,
			toolName,
		})

		// Resolve inline {{ref:...}} markers in MCP arguments before sending
		const resolvedArgs = parsedArguments ? await this.injectRefsIntoArgs(parsedArguments, task) : undefined

		const toolResult = await task.providerRef.deref()?.getMcpHub()?.callTool(serverName, toolName, resolvedArgs)

		let toolResultPretty = "(No response)"
		let images: string[] = []

		if (toolResult) {
			const { text: outputText, images: extractedImages } = this.processToolContent(toolResult)
			images = extractedImages

			if (outputText || images.length > 0) {
				await this.sendExecutionStatus(task, {
					executionId,
					status: "output",
					response: outputText || (images.length > 0 ? `[${images.length} image(s)]` : ""),
				})

				toolResultPretty =
					(toolResult.isError ? "Error:\n" : "") +
					(outputText || (images.length > 0 ? `[${images.length} image(s) received]` : ""))
			}

			// Send completion status
			await this.sendExecutionStatus(task, {
				executionId,
				status: toolResult.isError ? "error" : "completed",
				response: toolResultPretty,
				error: toolResult.isError ? "Error executing MCP tool" : undefined,
			})
		} else {
			// Send error status if no result
			await this.sendExecutionStatus(task, {
				executionId,
				status: "error",
				error: "No response from MCP server",
			})
		}

		await task.say("mcp_server_response", toolResultPretty, images)
		pushToolResult(formatResponse.toolResult(toolResultPretty, images))
	}
}

export const useMcpToolTool = new UseMcpToolTool()
