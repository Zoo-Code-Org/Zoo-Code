import { describe, expect, test } from "bun:test"
import { ZooClient, type ZooTransport } from "../src/index.js"

const projectFixture = {
	id: "proj_1",
	worktree: "/repo/root",
	vcs: "git",
	name: "Zoo Project",
	icon: { color: "blue" },
	commands: { start: "bun dev" },
	time: { created: 1, updated: 2 },
	sandboxes: ["/repo/root"],
}

function transport(): ZooTransport & { requests: any[] } {
	const requests: any[] = []
	return {
		requests,
		async request(input) {
			requests.push(input)
			if (input.path === "/question") {
				return {
					data: [
						{
							id: "que_1",
							sessionID: "ses_1",
							questions: [
								{
									question: "Continue?",
									header: "Confirm",
									options: [{ label: "Yes", description: "Continue" }],
								},
							],
						},
					],
				}
			}
			if (input.path === "/question/que_1/reply?directory=%2Frepo%2Froot&workspace=workspace-1") {
				return { data: true }
			}
			if (input.path === "/question/que_1/reject") return { data: true }
			if (input.path === "/permission")
				return { data: [{ id: "perm_1", sessionID: "ses_1", permission: "bash" }] }
			if (input.path === "/permission/perm_1/always-rules") return { data: true }
			if (input.path === "/session?directory=%2Frepo%2Froot&workspace=workspace-1")
				return input.method === "POST" ? { data: { id: "ses_1" } } : { data: [{ id: "ses_1" }] }
			if (input.path === "/session")
				return input.method === "POST" ? { data: { id: "ses_1" } } : { data: [{ id: "ses_1" }] }
			if (input.path === "/session/status") return { data: { ses_1: { type: "idle" } } }
			if (input.path === "/session/ses_1/children") return { data: [{ id: "ses_child", parentID: "ses_1" }] }
			if (input.path === "/session/ses_1/todo")
				return { data: [{ content: "Plan", status: "pending", priority: "high" }] }
			if (input.path === "/session/ses_1" && input.method === "PATCH")
				return { data: { id: "ses_1", ...input.body } }
			if (input.path === "/session/ses_1" && input.method === "DELETE") return { data: true }
			if (input.path === "/session/viewed") return { data: true }
			if (input.path === "/session/ses_1/fork") return { data: { id: "ses_fork", parentID: "ses_1" } }
			if (input.path === "/session/ses_1/share" && input.method === "POST") {
				return { data: { id: "ses_1", share: { url: "https://share.example/ses_1" } } }
			}
			if (input.path === "/session/ses_1/share" && input.method === "DELETE") return { data: { id: "ses_1" } }
			if (input.path === "/session/ses_1/revert") return { data: { id: "ses_1", revert: input.body } }
			if (input.path === "/session/ses_1/unrevert") return { data: { id: "ses_1" } }
			if (input.path === "/session/ses_1/diff?messageID=msg_1") {
				return {
					data: [
						{
							file: "src/app.ts",
							before: "old\n",
							after: "new\n",
							additions: 1,
							deletions: 1,
						},
					],
				}
			}
			if (
				input.path === "/session/ses_1" ||
				input.path === "/session/ses_1?directory=%2Frepo%2Froot&workspace=workspace-1"
			)
				return { data: { id: "ses_1" } }
			if (input.path.startsWith("/session/ses_1/prompt_async")) return { data: undefined }
			if (input.path === "/session/ses_1/message?limit=2&before=cursor+1") {
				return {
					data: [
						{
							info: { id: "msg_1", sessionID: "ses_1", role: "user", text: "hello" },
							parts: [
								{ id: "part_1", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "hello" },
							],
						},
					],
				}
			}
			if (input.path === "/session/ses_1/message/msg_1" && input.method === "DELETE") return { data: true }
			if (input.path === "/session/ses_1/message/msg_1") {
				return {
					data: {
						info: { id: "msg_1", sessionID: "ses_1", role: "user", text: "hello" },
						parts: [{ id: "part_1", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "hello" }],
					},
				}
			}
			if (input.path === "/session/ses_1/message/msg_1/part/part_1" && input.method === "PATCH")
				return { data: input.body }
			if (input.path === "/session/ses_1/message/msg_1/part/part_1" && input.method === "DELETE")
				return { data: true }
			if (input.path === "/path?directory=%2Frepo%2Froot&workspace=workspace-1") {
				return {
					data: {
						home: "/home/user",
						state: "/home/user/.local/share/kilo",
						config: "/home/user/.config/kilo",
						worktree: "/repo/root",
						directory: "/repo/root",
					},
				}
			}
			if (input.path === "/vcs?directory=%2Frepo%2Froot&workspace=workspace-1") {
				return { data: { branch: "feature", default_branch: "main" } }
			}
			if (input.path === "/vcs/diff?directory=%2Frepo%2Froot&workspace=workspace-1&mode=branch") {
				return {
					data: [{ file: "src/app.ts", patch: "patch", additions: 1, deletions: 1, status: "modified" }],
				}
			}
			if (input.path === "/command?directory=%2Frepo%2Froot&workspace=workspace-1") {
				return {
					data: [
						{
							name: "review",
							description: "review changes",
							source: "command",
							template: "Review",
							hints: [],
						},
					],
				}
			}
			if (input.path === "/skill?directory=%2Frepo%2Froot&workspace=workspace-1") {
				return {
					data: [{ name: "review", description: "Review", location: "builtin", content: "Review changes" }],
				}
			}
			if (input.path === "/lsp?directory=%2Frepo%2Froot&workspace=workspace-1") {
				return { data: [{ id: "ts", name: "TypeScript", root: "/repo/root", status: "connected" }] }
			}
			if (input.path === "/formatter?directory=%2Frepo%2Froot&workspace=workspace-1") {
				return { data: [{ name: "prettier", extensions: ["ts"], enabled: true }] }
			}
			if (input.path === "/experimental/tool/ids?directory=%2Frepo%2Froot&workspace=workspace-1") {
				return { data: ["bash"] }
			}
			if (input.path === "/pty/shells?directory=%2Frepo%2Froot&workspace=workspace-1") {
				return { data: [{ path: "/bin/bash", name: "bash", acceptable: true }] }
			}
			if (input.path === "/pty?directory=%2Frepo%2Froot&workspace=workspace-1") {
				return {
					data: [
						{
							id: "pty_1",
							title: "Terminal",
							command: "bash",
							args: ["-l"],
							cwd: "/repo/root",
							status: "running",
							pid: 1234,
						},
					],
				}
			}
			if (input.path?.startsWith("/tui/")) return { data: true }
			if (input.path === "/sync/history?directory=%2Frepo%2Froot&workspace=workspace-1") {
				return {
					data: [
						{
							id: "evt_sync_history_1",
							aggregate_id: "agg_sync_history",
							seq: 1,
							type: "session.updated",
							data: { title: "Synced" },
						},
					],
				}
			}
			if (
				input.path ===
				"/experimental/session?directory=%2Frepo%2Froot&workspace=workspace-1&projectID=proj_1&worktrees=true&roots=false&limit=10&archived=false"
			) {
				return { data: [{ id: "ses_1", title: "Session", project: projectFixture, worktreeName: "root" }] }
			}
			if (input.path === "/experimental/resource?directory=%2Frepo%2Froot&workspace=workspace-1") {
				return { data: { docs: { name: "Docs", uri: "file://docs", client: "demo" } } }
			}
			if (input.path === "/experimental/workspace/adapter?directory=%2Frepo%2Froot&workspace=workspace-1") {
				return { data: [{ type: "worktree", name: "Worktree", description: "Git worktree" }] }
			}
			if (input.path === "/experimental/workspace?directory=%2Frepo%2Froot&workspace=workspace-1") {
				return {
					data: [
						{
							id: "ws_1",
							type: "worktree",
							name: "root",
							branch: "main",
							directory: "/repo/root",
							extra: null,
							projectID: "proj_1",
						},
					],
				}
			}
			if (input.path === "/experimental/workspace/status?directory=%2Frepo%2Froot&workspace=workspace-1") {
				return { data: [{ workspaceID: "ws_1", status: "connected" }] }
			}
			if (input.path === "/file/content?directory=%2Frepo%2Froot&workspace=workspace-1&path=hello.txt") {
				return { data: { type: "text", content: "hello" } }
			}
			if (input.path === "/file?directory=%2Frepo%2Froot&workspace=workspace-1&path=.") {
				return {
					data: [
						{
							name: "hello.txt",
							path: "hello.txt",
							absolute: "/repo/root/hello.txt",
							type: "file",
							ignored: false,
						},
					],
				}
			}
			if (input.path === "/file/status?directory=%2Frepo%2Froot&workspace=workspace-1") {
				return { data: [{ path: "hello.txt", added: 1, removed: 0, status: "modified" }] }
			}
			if (input.path === "/find/file?directory=%2Frepo%2Froot&workspace=workspace-1&query=hello&limit=10") {
				return { data: ["hello.txt"] }
			}
			if (input.path === "/find/symbol?directory=%2Frepo%2Froot&workspace=workspace-1&query=hello") {
				return { data: [{ name: "hello", kind: "function", location: { path: "hello.ts" } }] }
			}
			if (input.path === "/find?directory=%2Frepo%2Froot&workspace=workspace-1&pattern=sdk-parity") {
				return { data: [{ path: { text: "hello.txt" }, lines: { text: "sdk-parity" }, line_number: 1 }] }
			}
			if (input.path === "/project?directory=%2Frepo%2Froot&workspace=workspace-1") {
				return { data: [projectFixture] }
			}
			if (input.path === "/project/current?directory=%2Frepo%2Froot&workspace=workspace-1") {
				return { data: projectFixture }
			}
			if (input.path === "/project/git/init?directory=%2Frepo%2Froot&workspace=workspace-1") {
				return { data: { ...projectFixture, vcs: "git", worktree: "/repo/root" } }
			}
			if (
				input.path === "/project/proj_1?directory=%2Frepo%2Froot&workspace=workspace-1" &&
				input.method === "PATCH"
			) {
				return { data: { ...projectFixture, ...input.body } }
			}
			if (input.path === "/agent") {
				return { data: [{ name: "code", displayName: "Code", description: "Code mode", mode: "primary" }] }
			}
			if (
				input.path === "/config/warnings" ||
				input.path === "/config/warnings?directory=%2Frepo%2Froot&workspace=workspace-1"
			)
				return { data: [{ path: "zoo.jsonc", message: "Invalid config" }] }
			if (input.path === "/config" && input.method === "PATCH") return { data: input.body }
			if (input.path === "/config" || input.path === "/config?directory=%2Frepo%2Froot&workspace=workspace-1")
				return { data: { model: "anthropic/claude" } }
			if (
				input.path === "/config/providers" ||
				input.path === "/config/providers?directory=%2Frepo%2Froot&workspace=workspace-1"
			)
				return { data: { default: "anthropic", providers: [] } }
			if (input.path === "/mcp") return { data: { demo: { status: "disabled" } } }
			if (input.path === "/global/dispose") return { data: true }
			if (input.path === "/provider") {
				return {
					data: {
						all: [{ id: "anthropic", name: "Anthropic", source: "api", env: [], options: {}, models: {} }],
						default: { anthropic: "claude-sonnet-4" },
						connected: ["anthropic"],
						failed: [],
					},
				}
			}
			if (input.path === "/provider/auth") {
				return {
					data: {
						anthropic: [
							{ type: "oauth", label: "Anthropic OAuth" },
							{
								type: "api",
								label: "API key",
								prompts: [{ type: "text", key: "apiKey", message: "API key" }],
							},
						],
					},
				}
			}
			if (input.path === "/provider/anthropic/oauth/authorize") {
				return {
					data: { url: "https://auth.example/authorize", method: "code", instructions: "Paste the code" },
				}
			}
			if (input.path === "/provider/anthropic/oauth/callback") return { data: true }
			if (input.path === "/experimental/worktree" && input.method === "POST") {
				return { data: { name: "feature", branch: "opencode/feature", directory: "/tmp/repo-feature" } }
			}
			if (input.path === "/experimental/worktree" && input.method === "DELETE") return { data: true }
			if (input.path === "/experimental/worktree") return { data: ["/tmp/repo-feature"] }
			if (input.path === "/experimental/worktree/reset") return { data: true }
			if (input.path === "/experimental/worktree/diff?base=main") {
				return {
					data: [
						{
							file: "src/app.ts",
							before: "old\n",
							after: "new\n",
							additions: 1,
							deletions: 1,
							status: "modified",
						},
					],
				}
			}
			if (input.path === "/experimental/worktree/diff/summary?base=main") {
				return {
					data: [
						{
							file: "src/app.ts",
							patch: "",
							before: "",
							after: "",
							additions: 1,
							deletions: 1,
							status: "modified",
							tracked: true,
							generatedLike: false,
							summarized: true,
							stamp: "7:1",
						},
					],
				}
			}
			if (input.path === "/experimental/worktree/diff/file?base=main&file=src%2Fapp.ts") {
				return {
					data: {
						file: "src/app.ts",
						patch: "patch",
						before: "old\n",
						after: "new\n",
						additions: 1,
						deletions: 1,
						status: "modified",
						tracked: true,
						generatedLike: false,
						summarized: false,
						stamp: "7:1",
					},
				}
			}
			return { data: undefined }
		},
		async *stream(input) {
			requests.push(input)
			if (input.path === "/event") {
				yield {
					type: "permission.asked",
					properties: { id: "perm_1", sessionID: "ses_1", permission: "bash" },
				}
				return
			}
			yield { type: "text", sessionID: "ses_1", text: "hello" }
			yield { type: "done", sessionID: "ses_1" }
		},
	}
}

describe("ZooClient", () => {
	test("constructs session requests", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })

		expect(await client.createSession({ title: "Smoke" })).toEqual({ id: "ses_1" })
		expect(await client.listSessions()).toEqual([{ id: "ses_1" }])
		expect(await client.getSession("ses_1")).toEqual({ id: "ses_1" })
		await client.abortSession("ses_1")

		expect(mock.requests.map((item) => [item.method ?? "GET", item.path])).toEqual([
			["POST", "/session"],
			["GET", "/session"],
			["GET", "/session/ses_1"],
			["POST", "/session/ses_1/abort"],
		])
	})

	test("constructs scoped session requests", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })
		const scope = { directory: "/repo/root", workspace: "workspace-1" }

		expect(await client.createSession({ title: "Smoke", ...scope })).toEqual({ id: "ses_1" })
		expect(await client.listSessions(scope)).toEqual([{ id: "ses_1" }])
		expect(await client.getSession("ses_1", scope)).toEqual({ id: "ses_1" })

		expect(mock.requests.slice(-3)).toEqual([
			{
				method: "POST",
				path: "/session?directory=%2Frepo%2Froot&workspace=workspace-1",
				body: { title: "Smoke" },
			},
			{ path: "/session?directory=%2Frepo%2Froot&workspace=workspace-1" },
			{ path: "/session/ses_1?directory=%2Frepo%2Froot&workspace=workspace-1" },
		])
	})

	test("wraps session maintenance routes", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })

		await expect(client.getSessionStatus()).resolves.toEqual({ ses_1: { type: "idle" } })
		await expect(client.listSessionChildren("ses_1")).resolves.toEqual([{ id: "ses_child", parentID: "ses_1" }])
		await expect(client.listSessionTodos("ses_1")).resolves.toEqual([
			{ content: "Plan", status: "pending", priority: "high" },
		])
		await expect(client.updateSession("ses_1", { title: "Renamed", time: { archived: 1 } })).resolves.toEqual({
			id: "ses_1",
			title: "Renamed",
			time: { archived: 1 },
		})
		await expect(client.deleteSession("ses_1")).resolves.toBe(true)

		expect(mock.requests.slice(-5)).toEqual([
			{ path: "/session/status" },
			{ path: "/session/ses_1/children" },
			{ path: "/session/ses_1/todo" },
			{ method: "PATCH", path: "/session/ses_1", body: { title: "Renamed", time: { archived: 1 } } },
			{ method: "DELETE", path: "/session/ses_1" },
		])
	})

	test("wraps additional safe session action routes", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })

		await expect(client.setViewedSessions({ focused: ["ses_1"], open: ["ses_1", "ses_2"] })).resolves.toBe(true)
		await expect(client.forkSession("ses_1", { messageID: "msg_1" })).resolves.toEqual({
			id: "ses_fork",
			parentID: "ses_1",
		})
		await expect(client.shareSession("ses_1")).resolves.toEqual({
			id: "ses_1",
			share: { url: "https://share.example/ses_1" },
		})
		await expect(client.unshareSession("ses_1")).resolves.toEqual({ id: "ses_1" })
		await expect(client.revertSession("ses_1", { messageID: "msg_1", partID: "part_1" })).resolves.toEqual({
			id: "ses_1",
			revert: { messageID: "msg_1", partID: "part_1" },
		})
		await expect(client.unrevertSession("ses_1")).resolves.toEqual({ id: "ses_1" })
		await expect(client.getSessionDiff("ses_1", { messageID: "msg_1" })).resolves.toEqual([
			{ file: "src/app.ts", before: "old\n", after: "new\n", additions: 1, deletions: 1 },
		])

		expect(mock.requests.slice(-7)).toEqual([
			{ method: "POST", path: "/session/viewed", body: { focused: ["ses_1"], open: ["ses_1", "ses_2"] } },
			{ method: "POST", path: "/session/ses_1/fork", body: { messageID: "msg_1" } },
			{ method: "POST", path: "/session/ses_1/share" },
			{ method: "DELETE", path: "/session/ses_1/share" },
			{ method: "POST", path: "/session/ses_1/revert", body: { messageID: "msg_1", partID: "part_1" } },
			{ method: "POST", path: "/session/ses_1/unrevert" },
			{ path: "/session/ses_1/diff?messageID=msg_1" },
		])
	})

	test("streams message chunks and emits subscribed events", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })
		const seen: string[] = []
		client.on("text", (event) => seen.push(String(event.text)))

		const chunks = []
		for await (const chunk of client.sendMessage("ses_1", "hi", { mode: "code" })) chunks.push(chunk)

		expect(chunks).toEqual([
			{ type: "text", sessionID: "ses_1", text: "hello" },
			{ type: "done", sessionID: "ses_1" },
		])
		expect(seen).toEqual(["hello"])
		expect(mock.requests.at(-1)).toMatchObject({
			method: "POST",
			path: "/session/ses_1/message",
			body: { agent: "code", message: "hi", parts: [{ type: "text", text: "hi" }] },
		})
	})

	test("queues async prompts with safe no-reply defaults", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })

		await client.promptAsync("ses_1", "summarize", {
			mode: "code",
			directory: "/repo/root",
			workspace: "workspace-1",
			parts: [{ type: "file", url: "file:///repo/root/src/app.ts", mime: "text/plain" }],
		})

		expect(mock.requests.at(-1)).toEqual({
			method: "POST",
			path: "/session/ses_1/prompt_async?directory=%2Frepo%2Froot&workspace=workspace-1",
			body: {
				agent: "code",
				noReply: true,
				parts: [
					{ type: "text", text: "summarize" },
					{ type: "file", url: "file:///repo/root/src/app.ts", mime: "text/plain" },
				],
			},
		})
	})

	test("wraps persisted message and part routes", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })
		const part = { id: "part_1", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "updated" }

		await expect(client.listMessages("ses_1", { limit: 2, before: "cursor 1" })).resolves.toEqual([
			{
				info: { id: "msg_1", sessionID: "ses_1", role: "user", text: "hello" },
				parts: [{ id: "part_1", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "hello" }],
			},
		])
		await expect(client.getMessage("ses_1", "msg_1")).resolves.toEqual({
			info: { id: "msg_1", sessionID: "ses_1", role: "user", text: "hello" },
			parts: [{ id: "part_1", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "hello" }],
		})
		await expect(client.deleteMessage("ses_1", "msg_1")).resolves.toBe(true)
		await expect(client.updateMessagePart("ses_1", "msg_1", "part_1", part)).resolves.toEqual(part)
		await expect(client.deleteMessagePart("ses_1", "msg_1", "part_1")).resolves.toBe(true)

		expect(mock.requests.slice(-5)).toEqual([
			{ path: "/session/ses_1/message?limit=2&before=cursor+1" },
			{ path: "/session/ses_1/message/msg_1" },
			{ method: "DELETE", path: "/session/ses_1/message/msg_1" },
			{ method: "PATCH", path: "/session/ses_1/message/msg_1/part/part_1", body: part },
			{ method: "DELETE", path: "/session/ses_1/message/msg_1/part/part_1" },
		])
	})

	test("subscribes to server events and replies to permission requests", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })
		const events = []

		for await (const event of client.subscribeEvents()) events.push(event)
		await client.replyPermission("perm_1", { reply: "reject", message: "No thanks" })

		expect(events).toEqual([
			{
				type: "permission.asked",
				properties: { id: "perm_1", sessionID: "ses_1", permission: "bash" },
			},
		])
		expect(mock.requests.at(-2)).toMatchObject({ path: "/event" })
		expect(mock.requests.at(-1)).toEqual({
			method: "POST",
			path: "/permission/perm_1/reply",
			body: { reply: "reject", message: "No thanks" },
		})
	})

	test("lists permissions and saves always rules", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })

		await expect(client.listPermissions()).resolves.toEqual([
			{ id: "perm_1", sessionID: "ses_1", permission: "bash" },
		])
		await expect(
			client.savePermissionAlwaysRules("perm_1", { approvedAlways: ["npm test"], deniedAlways: ["rm -rf *"] }),
		).resolves.toBe(true)
		expect(mock.requests.slice(-2)).toEqual([
			{ path: "/permission" },
			{
				method: "POST",
				path: "/permission/perm_1/always-rules",
				body: { approvedAlways: ["npm test"], deniedAlways: ["rm -rf *"] },
			},
		])
	})

	test("lists and answers question requests", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })

		await expect(client.listQuestions()).resolves.toEqual([
			{
				id: "que_1",
				sessionID: "ses_1",
				questions: [
					{
						question: "Continue?",
						header: "Confirm",
						options: [{ label: "Yes", description: "Continue" }],
					},
				],
			},
		])
		await expect(
			client.replyQuestion("que_1", [["Yes"]], { directory: "/repo/root", workspace: "workspace-1" }),
		).resolves.toBe(true)
		await expect(client.rejectQuestion("que_1")).resolves.toBe(true)

		expect(mock.requests.slice(-3)).toEqual([
			{ path: "/question" },
			{
				method: "POST",
				path: "/question/que_1/reply?directory=%2Frepo%2Froot&workspace=workspace-1",
				body: { answers: [["Yes"]] },
			},
			{ method: "POST", path: "/question/que_1/reject" },
		])
	})

	test("lists portable core modes from agents", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })

		await expect(client.listModes()).resolves.toEqual([
			{ id: "code", name: "Code", description: "Code mode", primary: true },
		])
		expect(mock.requests.at(-1)).toEqual({ path: "/agent" })
	})

	test("wraps instance read routes", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })
		const scope = { directory: "/repo/root", workspace: "workspace-1" }

		await expect(client.getPaths(scope)).resolves.toEqual({
			home: "/home/user",
			state: "/home/user/.local/share/kilo",
			config: "/home/user/.config/kilo",
			worktree: "/repo/root",
			directory: "/repo/root",
		})
		await expect(client.getVcsInfo(scope)).resolves.toEqual({ branch: "feature", default_branch: "main" })
		await expect(client.getVcsDiff({ ...scope, mode: "branch" })).resolves.toEqual([
			{ file: "src/app.ts", patch: "patch", additions: 1, deletions: 1, status: "modified" },
		])
		await expect(client.listCommands(scope)).resolves.toEqual([
			{ name: "review", description: "review changes", source: "command", template: "Review", hints: [] },
		])
		await expect(client.listSkills(scope)).resolves.toEqual([
			{ name: "review", description: "Review", location: "builtin", content: "Review changes" },
		])
		await expect(client.getLspStatus(scope)).resolves.toEqual([
			{ id: "ts", name: "TypeScript", root: "/repo/root", status: "connected" },
		])
		await expect(client.getFormatterStatus(scope)).resolves.toEqual([
			{ name: "prettier", extensions: ["ts"], enabled: true },
		])
		await expect(client.listToolIDs(scope)).resolves.toEqual(["bash"])
		await expect(client.listPtyShells(scope)).resolves.toEqual([
			{ path: "/bin/bash", name: "bash", acceptable: true },
		])
		await expect(client.listPtySessions(scope)).resolves.toEqual([
			{
				id: "pty_1",
				title: "Terminal",
				command: "bash",
				args: ["-l"],
				cwd: "/repo/root",
				status: "running",
				pid: 1234,
			},
		])

		expect(mock.requests.slice(-10)).toEqual([
			{ path: "/path?directory=%2Frepo%2Froot&workspace=workspace-1" },
			{ path: "/vcs?directory=%2Frepo%2Froot&workspace=workspace-1" },
			{ path: "/vcs/diff?directory=%2Frepo%2Froot&workspace=workspace-1&mode=branch" },
			{ path: "/command?directory=%2Frepo%2Froot&workspace=workspace-1" },
			{ path: "/skill?directory=%2Frepo%2Froot&workspace=workspace-1" },
			{ path: "/lsp?directory=%2Frepo%2Froot&workspace=workspace-1" },
			{ path: "/formatter?directory=%2Frepo%2Froot&workspace=workspace-1" },
			{ path: "/experimental/tool/ids?directory=%2Frepo%2Froot&workspace=workspace-1" },
			{ path: "/pty/shells?directory=%2Frepo%2Froot&workspace=workspace-1" },
			{ path: "/pty?directory=%2Frepo%2Froot&workspace=workspace-1" },
		])
	})

	test("wraps file and find read routes", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })
		const scope = { directory: "/repo/root", workspace: "workspace-1" }

		await expect(client.readFile({ ...scope, path: "hello.txt" })).resolves.toEqual({
			type: "text",
			content: "hello",
		})
		await expect(client.listFiles({ ...scope, path: "." })).resolves.toEqual([
			{ name: "hello.txt", path: "hello.txt", absolute: "/repo/root/hello.txt", type: "file", ignored: false },
		])
		await expect(client.getFileStatus(scope)).resolves.toEqual([
			{ path: "hello.txt", added: 1, removed: 0, status: "modified" },
		])
		await expect(client.findFiles({ ...scope, query: "hello", limit: 10 })).resolves.toEqual(["hello.txt"])
		await expect(client.findSymbols({ ...scope, query: "hello" })).resolves.toEqual([
			{ name: "hello", kind: "function", location: { path: "hello.ts" } },
		])
		await expect(client.findText({ ...scope, pattern: "sdk-parity" })).resolves.toEqual([
			{ path: { text: "hello.txt" }, lines: { text: "sdk-parity" }, line_number: 1 },
		])

		expect(mock.requests.slice(-6)).toEqual([
			{ path: "/file/content?directory=%2Frepo%2Froot&workspace=workspace-1&path=hello.txt" },
			{ path: "/file?directory=%2Frepo%2Froot&workspace=workspace-1&path=." },
			{ path: "/file/status?directory=%2Frepo%2Froot&workspace=workspace-1" },
			{ path: "/find/file?directory=%2Frepo%2Froot&workspace=workspace-1&query=hello&limit=10" },
			{ path: "/find/symbol?directory=%2Frepo%2Froot&workspace=workspace-1&query=hello" },
			{ path: "/find?directory=%2Frepo%2Froot&workspace=workspace-1&pattern=sdk-parity" },
		])
	})

	test("wraps TUI command routes", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })
		const scope = { directory: "/repo/root", workspace: "workspace-1" }

		await expect(client.appendTuiPrompt({ ...scope, text: "hello" })).resolves.toBe(true)
		await expect(client.openTuiHelp(scope)).resolves.toBe(true)
		await expect(client.openTuiSessions(scope)).resolves.toBe(true)
		await expect(client.openTuiThemes(scope)).resolves.toBe(true)
		await expect(client.openTuiModels(scope)).resolves.toBe(true)
		await expect(client.submitTuiPrompt(scope)).resolves.toBe(true)
		await expect(client.clearTuiPrompt(scope)).resolves.toBe(true)
		await expect(client.executeTuiCommand({ ...scope, command: "session_new" })).resolves.toBe(true)
		await expect(client.showTuiToast({ ...scope, title: "SDK", message: "hello", variant: "info" })).resolves.toBe(
			true,
		)
		await expect(client.selectTuiSession({ ...scope, sessionID: "ses_test" })).resolves.toBe(true)

		expect(mock.requests.slice(-10)).toEqual([
			{
				method: "POST",
				path: "/tui/append-prompt?directory=%2Frepo%2Froot&workspace=workspace-1",
				body: { text: "hello" },
			},
			{ method: "POST", path: "/tui/open-help?directory=%2Frepo%2Froot&workspace=workspace-1" },
			{ method: "POST", path: "/tui/open-sessions?directory=%2Frepo%2Froot&workspace=workspace-1" },
			{ method: "POST", path: "/tui/open-themes?directory=%2Frepo%2Froot&workspace=workspace-1" },
			{ method: "POST", path: "/tui/open-models?directory=%2Frepo%2Froot&workspace=workspace-1" },
			{ method: "POST", path: "/tui/submit-prompt?directory=%2Frepo%2Froot&workspace=workspace-1" },
			{ method: "POST", path: "/tui/clear-prompt?directory=%2Frepo%2Froot&workspace=workspace-1" },
			{
				method: "POST",
				path: "/tui/execute-command?directory=%2Frepo%2Froot&workspace=workspace-1",
				body: { command: "session_new" },
			},
			{
				method: "POST",
				path: "/tui/show-toast?directory=%2Frepo%2Froot&workspace=workspace-1",
				body: { title: "SDK", message: "hello", variant: "info" },
			},
			{
				method: "POST",
				path: "/tui/select-session?directory=%2Frepo%2Froot&workspace=workspace-1",
				body: { sessionID: "ses_test" },
			},
		])
	})

	test("wraps sync history read route", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })

		await expect(
			client.listSyncHistory({
				directory: "/repo/root",
				workspace: "workspace-1",
				body: { agg_sync_history: 0 },
			}),
		).resolves.toEqual([
			{
				id: "evt_sync_history_1",
				aggregate_id: "agg_sync_history",
				seq: 1,
				type: "session.updated",
				data: { title: "Synced" },
			},
		])

		expect(mock.requests.at(-1)).toEqual({
			method: "POST",
			path: "/sync/history?directory=%2Frepo%2Froot&workspace=workspace-1",
			body: { agg_sync_history: 0 },
		})
	})

	test("does not wrap side-effecting sync operations", async () => {
		const client = await ZooClient.connect({ transport: transport() })
		const syncClient = client as unknown as Record<string, unknown>

		expect(syncClient.startSync).toBeUndefined()
		expect(syncClient.replaySync).toBeUndefined()
	})

	test("wraps experimental read routes", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })
		const scope = { directory: "/repo/root", workspace: "workspace-1" }

		await expect(
			client.listExperimentalSessions({
				...scope,
				projectID: "proj_1",
				worktrees: true,
				roots: false,
				limit: 10,
				archived: false,
			}),
		).resolves.toEqual([{ id: "ses_1", title: "Session", project: projectFixture, worktreeName: "root" }])
		await expect(client.listResources(scope)).resolves.toEqual({
			docs: { name: "Docs", uri: "file://docs", client: "demo" },
		})
		await expect(client.listWorkspaceAdapters(scope)).resolves.toEqual([
			{ type: "worktree", name: "Worktree", description: "Git worktree" },
		])
		await expect(client.listWorkspaces(scope)).resolves.toEqual([
			{
				id: "ws_1",
				type: "worktree",
				name: "root",
				branch: "main",
				directory: "/repo/root",
				extra: null,
				projectID: "proj_1",
			},
		])
		await expect(client.getWorkspaceStatus(scope)).resolves.toEqual([{ workspaceID: "ws_1", status: "connected" }])

		expect(mock.requests.slice(-5)).toEqual([
			{
				path: "/experimental/session?directory=%2Frepo%2Froot&workspace=workspace-1&projectID=proj_1&worktrees=true&roots=false&limit=10&archived=false",
			},
			{ path: "/experimental/resource?directory=%2Frepo%2Froot&workspace=workspace-1" },
			{ path: "/experimental/workspace/adapter?directory=%2Frepo%2Froot&workspace=workspace-1" },
			{ path: "/experimental/workspace?directory=%2Frepo%2Froot&workspace=workspace-1" },
			{ path: "/experimental/workspace/status?directory=%2Frepo%2Froot&workspace=workspace-1" },
		])
	})

	test("wraps project routes", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })
		const scope = { directory: "/repo/root", workspace: "workspace-1" }

		await expect(client.listProjects(scope)).resolves.toEqual([projectFixture])
		await expect(client.getCurrentProject(scope)).resolves.toEqual(projectFixture)
		await expect(client.initProjectGit(scope)).resolves.toEqual({
			...projectFixture,
			vcs: "git",
			worktree: "/repo/root",
		})
		await expect(
			client.updateProject("proj_1", {
				...scope,
				name: "Renamed",
				commands: { start: "bun dev" },
			}),
		).resolves.toMatchObject({
			id: "proj_1",
			name: "Renamed",
			commands: { start: "bun dev" },
		})

		expect(mock.requests.slice(-4)).toEqual([
			{ path: "/project?directory=%2Frepo%2Froot&workspace=workspace-1" },
			{ path: "/project/current?directory=%2Frepo%2Froot&workspace=workspace-1" },
			{ method: "POST", path: "/project/git/init?directory=%2Frepo%2Froot&workspace=workspace-1" },
			{
				method: "PATCH",
				path: "/project/proj_1?directory=%2Frepo%2Froot&workspace=workspace-1",
				body: { name: "Renamed", commands: { start: "bun dev" } },
			},
		])
	})

	test("reads portable core config and configured providers", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })

		await expect(client.getConfig()).resolves.toEqual({ model: "anthropic/claude" })
		await expect(client.getConfigProviders()).resolves.toEqual({ default: "anthropic", providers: [] })
		expect(mock.requests.slice(-2)).toEqual([{ path: "/config" }, { path: "/config/providers" }])
	})

	test("reads scoped portable core config", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })
		const scope = { directory: "/repo/root", workspace: "workspace-1" }

		await expect(client.getConfig(scope)).resolves.toEqual({ model: "anthropic/claude" })
		await expect(client.getConfigProviders(scope)).resolves.toEqual({ default: "anthropic", providers: [] })
		await expect(client.getConfigWarnings(scope)).resolves.toEqual([
			{ path: "zoo.jsonc", message: "Invalid config" },
		])

		expect(mock.requests.slice(-3)).toEqual([
			{ path: "/config?directory=%2Frepo%2Froot&workspace=workspace-1" },
			{ path: "/config/providers?directory=%2Frepo%2Froot&workspace=workspace-1" },
			{ path: "/config/warnings?directory=%2Frepo%2Froot&workspace=workspace-1" },
		])
	})

	test("reads MCP status", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })

		await expect(client.getMcpStatus()).resolves.toEqual({ demo: { status: "disabled" } })
		expect(mock.requests.at(-1)).toEqual({ path: "/mcp" })
	})

	test("updates config and reads config warnings", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })

		await expect(client.updateConfig({ model: "openai/gpt-5" })).resolves.toEqual({ model: "openai/gpt-5" })
		await expect(client.getConfigWarnings()).resolves.toEqual([{ path: "zoo.jsonc", message: "Invalid config" }])
		expect(mock.requests.slice(-2)).toEqual([
			{ method: "PATCH", path: "/config", body: { model: "openai/gpt-5" } },
			{ path: "/config/warnings" },
		])
	})

	test("invalidates portable core config", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })

		await expect(client.invalidateConfig()).resolves.toBe(true)
		expect(mock.requests.at(-1)).toEqual({ method: "POST", path: "/global/dispose" })
	})

	test("wraps provider routes", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })

		await expect(client.listProviders()).resolves.toEqual({
			all: [{ id: "anthropic", name: "Anthropic", source: "api", env: [], options: {}, models: {} }],
			default: { anthropic: "claude-sonnet-4" },
			connected: ["anthropic"],
			failed: [],
		})
		await expect(client.getProviderAuthMethods()).resolves.toEqual({
			anthropic: [
				{ type: "oauth", label: "Anthropic OAuth" },
				{ type: "api", label: "API key", prompts: [{ type: "text", key: "apiKey", message: "API key" }] },
			],
		})
		await expect(
			client.authorizeProviderOAuth("anthropic", { method: 0, inputs: { workspace: "zoo" } }),
		).resolves.toEqual({
			url: "https://auth.example/authorize",
			method: "code",
			instructions: "Paste the code",
		})
		await expect(client.callbackProviderOAuth("anthropic", { method: 0, code: "oauth-code" })).resolves.toBe(true)

		expect(mock.requests.slice(-4)).toEqual([
			{ path: "/provider" },
			{ path: "/provider/auth" },
			{
				method: "POST",
				path: "/provider/anthropic/oauth/authorize",
				body: { method: 0, inputs: { workspace: "zoo" } },
			},
			{
				method: "POST",
				path: "/provider/anthropic/oauth/callback",
				body: { method: 0, code: "oauth-code" },
			},
		])
	})

	test("wraps worktree lifecycle routes", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })

		await expect(client.listWorktrees()).resolves.toEqual(["/tmp/repo-feature"])
		await expect(client.createWorktree({ name: "feature", startCommand: "bun install" })).resolves.toEqual({
			name: "feature",
			branch: "opencode/feature",
			directory: "/tmp/repo-feature",
		})
		await expect(client.removeWorktree({ directory: "/tmp/repo-feature" })).resolves.toBe(true)
		await expect(client.resetWorktree("/tmp/repo-feature")).resolves.toBe(true)

		expect(mock.requests.slice(-4)).toEqual([
			{ path: "/experimental/worktree" },
			{
				method: "POST",
				path: "/experimental/worktree",
				body: { name: "feature", startCommand: "bun install" },
			},
			{ method: "DELETE", path: "/experimental/worktree", body: { directory: "/tmp/repo-feature" } },
			{ method: "POST", path: "/experimental/worktree/reset", body: { directory: "/tmp/repo-feature" } },
		])
	})

	test("wraps worktree diff routes", async () => {
		const mock = transport()
		const client = await ZooClient.connect({ transport: mock })

		await expect(client.getWorktreeDiff({ base: "main" })).resolves.toEqual([
			{ file: "src/app.ts", before: "old\n", after: "new\n", additions: 1, deletions: 1, status: "modified" },
		])
		await expect(client.getWorktreeDiffSummary({ base: "main" })).resolves.toEqual([
			{
				file: "src/app.ts",
				patch: "",
				before: "",
				after: "",
				additions: 1,
				deletions: 1,
				status: "modified",
				tracked: true,
				generatedLike: false,
				summarized: true,
				stamp: "7:1",
			},
		])
		await expect(client.getWorktreeDiffFile({ base: "main", file: "src/app.ts" })).resolves.toEqual({
			file: "src/app.ts",
			patch: "patch",
			before: "old\n",
			after: "new\n",
			additions: 1,
			deletions: 1,
			status: "modified",
			tracked: true,
			generatedLike: false,
			summarized: false,
			stamp: "7:1",
		})

		expect(mock.requests.slice(-3)).toEqual([
			{ path: "/experimental/worktree/diff?base=main" },
			{ path: "/experimental/worktree/diff/summary?base=main" },
			{ path: "/experimental/worktree/diff/file?base=main&file=src%2Fapp.ts" },
		])
	})
})
