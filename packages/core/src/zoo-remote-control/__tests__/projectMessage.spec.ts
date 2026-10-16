import { describe, expect, it } from "vitest"

import {
	projectClineMessageForRemote,
	projectClineMessagesForSnapshot,
	REMOTE_MESSAGE_IMAGE_MAX_CHARS,
	REMOTE_MESSAGE_IMAGE_MAX_COUNT,
	REMOTE_MESSAGE_JSON_MAX_CHARS,
	REMOTE_MESSAGE_TEXT_MAX_CHARS,
	REMOTE_SNAPSHOT_MAX_MESSAGES,
} from "../projectMessage.js"

describe("projectClineMessageForRemote", () => {
	it("truncates oversized tool diff payloads while keeping path metadata", () => {
		const huge = "x".repeat(60_000)
		const shaped = projectClineMessageForRemote({
			ts: 1,
			type: "ask",
			ask: "tool",
			text: JSON.stringify({
				tool: "appliedDiff",
				path: "src/a.ts",
				diff: huge,
				diffStats: { added: 1, removed: 0 },
			}),
		})

		expect(shaped.text).toBeTruthy()
		const parsed = JSON.parse(shaped.text!) as {
			path: string
			diff: string
			diffStats: { added: number }
		}
		expect(parsed.path).toBe("src/a.ts")
		expect(parsed.diffStats.added).toBe(1)
		expect(parsed.diff.length).toBeLessThan(huge.length)
		expect(parsed.diff).toContain("[truncated")
	})

	it("shapes say:tool, command, and use_mcp_server asks", () => {
		const huge = "y".repeat(REMOTE_MESSAGE_TEXT_MAX_CHARS + 100)
		for (const message of [
			{
				ts: 1,
				type: "say" as const,
				say: "tool" as const,
				text: JSON.stringify({ content: huge, code: huge }),
			},
			{
				ts: 2,
				type: "ask" as const,
				ask: "command" as const,
				text: JSON.stringify({ result: huge }),
			},
			{
				ts: 3,
				type: "ask" as const,
				ask: "use_mcp_server" as const,
				text: JSON.stringify({ originalContent: huge }),
			},
		]) {
			const shaped = projectClineMessageForRemote(message)
			const parsed = JSON.parse(shaped.text!) as Record<string, string>
			for (const value of Object.values(parsed)) {
				if (typeof value === "string" && value.length > 100) {
					expect(value.length).toBeLessThanOrEqual(REMOTE_MESSAGE_TEXT_MAX_CHARS + 40)
					expect(value).toContain("[truncated")
				}
			}
		}
	})

	it("truncates non-JSON tool text and invalid JSON arrays/objects", () => {
		const huge = "z".repeat(REMOTE_MESSAGE_TEXT_MAX_CHARS + 50)
		expect(projectClineMessageForRemote({ ts: 1, type: "ask", ask: "tool", text: huge }).text).toContain(
			"[truncated",
		)
		expect(
			projectClineMessageForRemote({
				ts: 2,
				type: "ask",
				ask: "tool",
				text: JSON.stringify(["not", "an", "object"]),
			}).text,
		).toBe(JSON.stringify(["not", "an", "object"]))
		expect(
			projectClineMessageForRemote({
				ts: 3,
				type: "ask",
				ask: "tool",
				text: `{${"n".repeat(REMOTE_MESSAGE_TEXT_MAX_CHARS + 20)}`,
			}).text,
		).toContain("[truncated")
	})

	it("enforces an aggregate serialized character budget across many large fields", () => {
		const chunk = "z".repeat(20_000)
		const shaped = projectClineMessageForRemote({
			ts: 1,
			type: "ask",
			ask: "tool",
			text: JSON.stringify({
				a: chunk,
				b: chunk,
				c: chunk,
				d: chunk,
				e: chunk,
				f: chunk,
			}),
		})
		expect(shaped.text!.length).toBeLessThanOrEqual(REMOTE_MESSAGE_JSON_MAX_CHARS + 80)
	})

	it("recursively truncates nested tool JSON strings beyond top-level keys", () => {
		const huge = "n".repeat(REMOTE_MESSAGE_TEXT_MAX_CHARS + 80)
		const shaped = projectClineMessageForRemote({
			ts: 1,
			type: "ask",
			ask: "tool",
			text: JSON.stringify({
				tool: "updateTodoList",
				path: "src/a.ts",
				meta: {
					summary: huge,
					nested: { note: huge, keep: "ok" },
				},
				todos: [
					{ id: "1", content: huge },
					{ id: "2", content: "short" },
				],
			}),
		})
		const parsed = JSON.parse(shaped.text!) as {
			path: string
			meta: { summary: string; nested: { note: string; keep: string } }
			todos: Array<{ id: string; content: string }>
		}
		expect(parsed.path).toBe("src/a.ts")
		expect(parsed.meta.nested.keep).toBe("ok")
		expect(parsed.meta.summary).toContain("[truncated")
		expect(parsed.meta.nested.note).toContain("[truncated")
		expect(parsed.todos[0]?.content).toContain("[truncated")
		expect(parsed.todos[1]?.content).toBe("short")
		expect(parsed.meta.summary.length).toBeLessThanOrEqual(REMOTE_MESSAGE_TEXT_MAX_CHARS + 40)
	})

	it("shapes batchDiffs entries and leaves non-object batch entries untouched", () => {
		const huge = "d".repeat(REMOTE_MESSAGE_TEXT_MAX_CHARS + 10)
		const shaped = projectClineMessageForRemote({
			ts: 1,
			type: "ask",
			ask: "tool",
			text: JSON.stringify({
				batchDiffs: [
					{ path: "a.ts", diff: huge, content: huge },
					"skip-me",
					null,
					{ path: "b.ts", note: "ok" },
					...Array.from({ length: 25 }, (_, i) => ({ path: `x${i}.ts`, diff: "small" })),
				],
			}),
		})
		const parsed = JSON.parse(shaped.text!) as {
			batchDiffs: Array<string | null | { path?: string; diff?: string; content?: string }>
		}
		expect(parsed.batchDiffs).toHaveLength(20)
		expect(parsed.batchDiffs[0]).toMatchObject({ path: "a.ts" })
		expect((parsed.batchDiffs[0] as { diff: string }).diff).toContain("[truncated")
		expect((parsed.batchDiffs[0] as { content: string }).content).toContain("[truncated")
		expect(parsed.batchDiffs[1]).toBe("skip-me")
		expect(parsed.batchDiffs[2]).toBeNull()
	})

	it("truncates plain text, reasoning, and image payloads", () => {
		const hugeText = "t".repeat(REMOTE_MESSAGE_TEXT_MAX_CHARS + 20)
		const hugeImage = "i".repeat(REMOTE_MESSAGE_IMAGE_MAX_CHARS + 20)
		const shaped = projectClineMessageForRemote({
			ts: 1,
			type: "say",
			say: "text",
			text: hugeText,
			reasoning: hugeText,
			images: [hugeImage, hugeImage, hugeImage],
		})
		expect(shaped.text).toContain("[truncated")
		expect(shaped.reasoning).toContain("[truncated")
		expect(shaped.images).toHaveLength(REMOTE_MESSAGE_IMAGE_MAX_COUNT)
		expect(shaped.images?.[0]).toContain("[truncated")
	})

	it("leaves short non-tool messages unchanged", () => {
		const shaped = projectClineMessageForRemote({
			ts: 1,
			type: "say",
			say: "text",
			text: "hello",
			reasoning: "think",
			images: ["img"],
		})
		expect(shaped).toMatchObject({
			text: "hello",
			reasoning: "think",
			images: ["img"],
		})
	})

	it("limits snapshot windows", () => {
		const messages = Array.from({ length: REMOTE_SNAPSHOT_MAX_MESSAGES + 40 }, (_, i) => ({
			ts: i,
			type: "say" as const,
			say: "text" as const,
			text: `m${i}`,
		}))
		const window = projectClineMessagesForSnapshot(messages)
		expect(window).toHaveLength(REMOTE_SNAPSHOT_MAX_MESSAGES)
		expect(window[0]?.text).toBe(`m${40}`)
		expect(window.at(-1)?.text).toBe(`m${REMOTE_SNAPSHOT_MAX_MESSAGES + 39}`)
	})
})
