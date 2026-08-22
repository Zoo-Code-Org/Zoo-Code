type MessageRecord = Record<string, unknown> & { ts?: unknown }

function isRecord(value: unknown): value is MessageRecord {
	return typeof value === "object" && value !== null
}

function mergeTimestampedSnapshots(
	existing: unknown,
	incoming: unknown,
	mergeMatch: (disk: MessageRecord, next: MessageRecord) => MessageRecord,
): unknown {
	if (!Array.isArray(existing) || !Array.isArray(incoming)) {
		return incoming
	}

	const existingGroups = new Map<number, MessageRecord[]>()
	const existingLegacy: unknown[] = []

	for (const message of existing) {
		if (isRecord(message) && typeof message.ts === "number") {
			const group = existingGroups.get(message.ts) ?? []
			group.push(message)
			existingGroups.set(message.ts, group)
		} else {
			existingLegacy.push(message)
		}
	}

	const consumedByTimestamp = new Map<number, number>()
	let incomingLegacyCount = 0
	const merged = incoming.map((message) => {
		if (!isRecord(message) || typeof message.ts !== "number") {
			incomingLegacyCount++
			return message
		}

		const consumed = consumedByTimestamp.get(message.ts) ?? 0
		consumedByTimestamp.set(message.ts, consumed + 1)
		const diskMessage = existingGroups.get(message.ts)?.[consumed]
		return diskMessage ? mergeMatch(diskMessage, message) : message
	})

	const diskOnlyTimestamped = [...existingGroups.entries()].flatMap(([timestamp, messages]) =>
		messages.slice(consumedByTimestamp.get(timestamp) ?? 0),
	)

	for (const diskMessage of diskOnlyTimestamped) {
		const insertionIndex = merged.findIndex(
			(message) => isRecord(message) && typeof message.ts === "number" && message.ts > (diskMessage.ts as number),
		)
		if (insertionIndex === -1) {
			merged.push(diskMessage)
		} else {
			merged.splice(insertionIndex, 0, diskMessage)
		}
	}

	merged.push(...existingLegacy.slice(incomingLegacyCount))
	return merged
}

export function mergeClineMessageSnapshots(existing: unknown, incoming: unknown): unknown {
	return mergeTimestampedSnapshots(existing, incoming, (disk, next) => {
		if (disk.type !== next.type || disk.say !== next.say || disk.ask !== next.ask) {
			return next
		}

		const merged = { ...disk, ...next }
		if (disk.partial === false && next.partial === true) {
			merged.partial = false
		}
		if (disk.isAnswered === true) {
			merged.isAnswered = true
		}
		return merged
	})
}

export function mergeApiMessageSnapshots(existing: unknown, incoming: unknown): unknown {
	return mergeTimestampedSnapshots(existing, incoming, (_disk, next) => next)
}
