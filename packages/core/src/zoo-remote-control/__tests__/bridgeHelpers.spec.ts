import { describe, expect, it } from "vitest"

import {
	classifyRemoteControlHttpResult,
	generateZooRemoteInstanceId,
	isRemoteAuthBlockedStatus,
	isRemoteNotFoundStatus,
	partialFlushDecision,
	remoteMessageKey,
	requeueRemoteEventsKeepingNewest,
	resolveRemoteMessageAction,
	resolveZooRemoteEventSeq,
	workspaceNicknameFromFsPath,
} from "../bridgeHelpers.js"

describe("bridgeHelpers", () => {
	it("derives a nickname from posix and windows paths", () => {
		expect(workspaceNicknameFromFsPath("/Users/me/proj/")).toBe("proj")
		expect(workspaceNicknameFromFsPath("C:\\Users\\me\\proj\\")).toBe("proj")
		expect(workspaceNicknameFromFsPath("///")).toBeUndefined()
		expect(workspaceNicknameFromFsPath(undefined)).toBeUndefined()
	})

	it("prefers messageId for remote message keys", () => {
		expect(remoteMessageKey("t1", { messageId: "m1", ts: 9 })).toBe("m1")
		expect(remoteMessageKey("t1", { ts: 9 })).toBe("t1:9")
	})

	it("resolves message actions from explicit values or partial flag", () => {
		expect(resolveRemoteMessageAction("created", true)).toBe("created")
		expect(resolveRemoteMessageAction(undefined, true)).toBe("updated")
		expect(resolveRemoteMessageAction(undefined, false)).toBe("created")
	})

	it("requeues failed events and keeps the newest under the cap", () => {
		expect(requeueRemoteEventsKeepingNewest([1, 2], [3, 4], 3)).toEqual([2, 3, 4])
	})

	it("decides when partial flushes should arm, wait, or flush", () => {
		expect(partialFlushDecision(0, 100, 75)).toBe("arm")
		expect(partialFlushDecision(100, 150, 75)).toBe("wait")
		expect(partialFlushDecision(100, 200, 75)).toBe("flush")
	})

	it("classifies remote HTTP statuses", () => {
		expect(isRemoteAuthBlockedStatus(401)).toBe(true)
		expect(isRemoteAuthBlockedStatus(402)).toBe(true)
		expect(isRemoteAuthBlockedStatus(403)).toBe(true)
		expect(isRemoteAuthBlockedStatus(404)).toBe(false)
		expect(isRemoteAuthBlockedStatus(undefined)).toBe(false)
		expect(isRemoteNotFoundStatus(404)).toBe(true)
		expect(isRemoteNotFoundStatus(500)).toBe(false)
		expect(isRemoteNotFoundStatus(undefined)).toBe(false)
		expect(classifyRemoteControlHttpResult({ ok: false, status: 401 })).toBe("auth_blocked")
		expect(classifyRemoteControlHttpResult({ ok: false, status: 404 })).toBe("unavailable")
		expect(classifyRemoteControlHttpResult({ ok: true, status: 200 })).toBe("success")
		expect(classifyRemoteControlHttpResult({ ok: false, status: 500 })).toBe("failed")
	})

	it("normalizes event seq and instance ids", () => {
		expect(resolveZooRemoteEventSeq(undefined)).toBe(0)
		expect(resolveZooRemoteEventSeq(-1)).toBe(0)
		expect(resolveZooRemoteEventSeq(12)).toBe(12)
		expect(generateZooRemoteInstanceId(1, "sess-1")).toBe("sess-1")
		expect(generateZooRemoteInstanceId(1, undefined)).toMatch(/^zoo-1-/)
	})
})
