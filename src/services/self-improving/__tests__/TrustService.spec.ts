import { describe, it, expect, vi, beforeEach } from "vitest"
import { TrustService } from "../TrustService"

describe("TrustService", () => {
	let service: TrustService

	beforeEach(() => {
		service = new TrustService({ appendLine: vi.fn() } as any)
	})

	describe("shouldAutoApprove", () => {
		it("should return false when disabled", () => {
			const disabled = new TrustService({ appendLine: vi.fn() } as any, { enabled: false })
			expect(disabled.shouldAutoApprove("read_file")).toBe(false)
		})

		it("should auto-approve read operations when enabled", () => {
			service.updateConfig({ enabled: true, autoApproveRead: true })
			expect(service.shouldAutoApprove("read_file")).toBe(true)
			expect(service.shouldAutoApprove("search_files")).toBe(true)
			expect(service.shouldAutoApprove("list_files")).toBe(true)
		})

		it("should auto-approve write operations when enabled", () => {
			service.updateConfig({ enabled: true, autoApproveWrite: true })
			expect(service.shouldAutoApprove("write_file")).toBe(true)
			expect(service.shouldAutoApprove("edit_file")).toBe(true)
		})

		it("should auto-approve commands when enabled", () => {
			service.updateConfig({ enabled: true, autoApproveCommands: true })
			expect(service.shouldAutoApprove("execute_command")).toBe(true)
			expect(service.shouldAutoApprove("bash")).toBe(true)
		})

		it("should auto-approve MCP when enabled", () => {
			service.updateConfig({ enabled: true, autoApproveMcp: true })
			expect(service.shouldAutoApprove("use_mcp_tool")).toBe(true)
			expect(service.shouldAutoApprove("access_mcp_resource")).toBe(true)
		})

		it("should auto-approve mode switch when enabled", () => {
			service.updateConfig({ enabled: true, autoApproveModeSwitch: true })
			expect(service.shouldAutoApprove("switch_mode")).toBe(true)
		})

		it("should always auto-approve user-facing tools", () => {
			service.updateConfig({ enabled: true })
			expect(service.shouldAutoApprove("ask_followup_question")).toBe(true)
			expect(service.shouldAutoApprove("attempt_completion")).toBe(true)
		})

		it("should respect max consecutive actions limit", () => {
			service.updateConfig({ enabled: true, autoApproveRead: true, maxConsecutiveActions: 2 })
			expect(service.shouldAutoApprove("read_file")).toBe(true)
			expect(service.shouldAutoApprove("read_file")).toBe(true)
			expect(service.shouldAutoApprove("read_file")).toBe(false) // limit reached
		})

		it("should reset consecutive counter", () => {
			service.updateConfig({ enabled: true, autoApproveRead: true, maxConsecutiveActions: 2 })
			service.shouldAutoApprove("read_file")
			service.shouldAutoApprove("read_file")
			service.resetConsecutiveCounter()
			expect(service.shouldAutoApprove("read_file")).toBe(true) // counter reset
		})

		it("should check trusted commands", () => {
			service.updateConfig({
				enabled: true,
				autoApproveCommands: true,
				trustedCommands: ["npm test", "git status"],
			})
			expect(service.shouldAutoApprove("execute_command", { command: "npm test" })).toBe(true)
			expect(service.shouldAutoApprove("execute_command", { command: "rm -rf /" })).toBe(false)
		})

		it("should check trusted paths", () => {
			service.updateConfig({
				enabled: true,
				autoApproveWrite: true,
				trustedPaths: ["/home/project/src"],
			})
			expect(service.shouldAutoApprove("write_file", { path: "/home/project/src/index.ts" })).toBe(true)
			expect(service.shouldAutoApprove("write_file", { path: "/etc/passwd" })).toBe(false)
		})
	})

	describe("getStatus", () => {
		it("should return status object", () => {
			service.updateConfig({ enabled: true, autoApproveRead: true })
			const status = service.getStatus()
			expect(status.enabled).toBe(true)
			expect(status.autoApproveRead).toBe(true)
			expect(status.consecutiveActions).toBe(0)
		})
	})
})
