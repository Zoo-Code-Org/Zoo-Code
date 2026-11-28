type MessageRecord = Record<string, unknown> & { messageId?: unknown; ts?: unknown }
type IdentifiedMessage = { messageId?: string; ts?: unknown }

function isRecord(value: unknown): value is MessageRecord {
	return typeof value === "object" && value !== null
}

export function ensureMessageIdentifiers<T extends IdentifiedMessage>(messages: T[]): T[] {
	// Pre-scan: collect all IDs already present so generated ones stay unique.
	const usedIds = new Set<string>()
	for (const message of messages) {
		if (typeof message.messageId === "string") usedIds.add(message.messageId)
	}

	const timestampOrdinals = new Map<string, number>()
	for (const message of messages) {
		if (typeof message.messageId === "string") continue

		const timestampKey = typeof message.ts === "number" ? String(message.ts) : "none"
		let ordinal = timestampOrdinals.get(timestampKey) ?? 0
		let candidate = `legacy:${timestampKey}:${ordinal}`
		while (usedIds.has(candidate)) {
			ordinal++
			candidate = `legacy:${timestampKey}:${ordinal}`
		}
		timestampOrdinals.set(timestampKey, ordinal + 1)
		usedIds.add(candidate)
		message.messageId = candidate
	}
	return messages
}

function mergeTimestampedSnapshots(
	existing: unknown,
	incoming: unknown,
	mergeMatch?: (disk: MessageRecord, next: MessageRecord) => MessageRecord,
): unknown {
	if (!Array.isArray(existing) || !Array.isArray(incoming)) {
		return incoming
	}

	type IndexQueue = { indices: number[]; cursor: number }
	type Group = {
		messages: MessageRecord[]
		byId?: Map<string, IndexQueue>
		legacy?: IndexQueue
		consumed: Set<number>
	}
	const existingGroups = new Map<number, Group>()
	const existingLegacy: unknown[] = []

	for (const message of existing) {
		if (isRecord(message) && typeof message.ts === "number") {
			let group = existingGroups.get(message.ts)
			if (!group) {
				group = { messages: [], consumed: new Set() }
				existingGroups.set(message.ts, group)
			}
			group.messages.push(message)
		} else {
			existingLegacy.push(message)
		}
	}

	const takeIndex = (queue?: IndexQueue) =>
		queue && queue.cursor < queue.indices.length ? queue.indices[queue.cursor++] : undefined
	let incomingLegacyCount = 0
	const merged = incoming.map((message) => {
		if (!isRecord(message) || typeof message.ts !== "number") {
			incomingLegacyCount++
			return message
		}

		const group = existingGroups.get(message.ts)
		const messageId = typeof message.messageId === "string" ? message.messageId : undefined
		let diskIndex: number | undefined
		if (group?.messages.length === 1) {
			const candidateId = group.messages[0].messageId
			if (
				!group.consumed.has(0) &&
				(candidateId === undefined || (messageId !== undefined && candidateId === messageId))
			)
				diskIndex = 0
		} else if (group) {
			// Only allocate ID queues for collisions. Most timestamps have one message.
			if (!group.byId) {
				const byId = new Map<string, IndexQueue>()
				const legacy: IndexQueue = { indices: [], cursor: 0 }
				for (const [index, candidate] of group.messages.entries()) {
					const id = candidate.messageId
					if (typeof id === "string") {
						const queue = byId.get(id) ?? { indices: [], cursor: 0 }
						queue.indices.push(index)
						byId.set(id, queue)
					} else if (id === undefined) legacy.indices.push(index)
				}
				group.byId = byId
				group.legacy = legacy
			}
			diskIndex = takeIndex(messageId === undefined ? group.legacy : group.byId.get(messageId))
			if (diskIndex === undefined && messageId !== undefined) diskIndex = takeIndex(group.legacy)
		}
		const diskMessage = diskIndex === undefined ? undefined : group?.messages[diskIndex]
		if (diskIndex !== undefined) group?.consumed.add(diskIndex)
		if (mergeMatch !== undefined && diskMessage !== undefined) {
			return mergeMatch(diskMessage, message)
		}
		return message
	})

	const diskOnlyTimestamped: MessageRecord[] = []
	for (const group of existingGroups.values()) {
		for (const [index, message] of group.messages.entries()) {
			if (!group.consumed.has(index)) diskOnlyTimestamped.push(message)
		}
	}

	const timestampMerged: unknown[] = []
	let diskOnlyIndex = 0
	for (const incomingMessage of merged) {
		if (isRecord(incomingMessage) && typeof incomingMessage.ts === "number") {
			while (
				diskOnlyIndex < diskOnlyTimestamped.length &&
				(diskOnlyTimestamped[diskOnlyIndex].ts as number) < incomingMessage.ts
			) {
				timestampMerged.push(diskOnlyTimestamped[diskOnlyIndex])
				diskOnlyIndex++
			}
		}
		timestampMerged.push(incomingMessage)
	}
	for (; diskOnlyIndex < diskOnlyTimestamped.length; diskOnlyIndex++)
		timestampMerged.push(diskOnlyTimestamped[diskOnlyIndex])

	for (let index = incomingLegacyCount; index < existingLegacy.length; index++)
		timestampMerged.push(existingLegacy[index])
	return timestampMerged
}

export function mergeClineMessageSnapshots(existing: unknown, incoming: unknown): unknown {
	return mergeTimestampedSnapshots(existing, incoming, (disk, next) => {
		if (disk.type !== next.type || disk.say !== next.say || disk.ask !== next.ask) {
			return next
		}

		if (disk.partial !== true && next.partial === true) {
			return disk
		}
		const merged = { ...disk, ...next }
		if (disk.isAnswered === true) {
			merged.isAnswered = true
		}
		return merged
	})
}

export function mergeApiMessageSnapshots(existing: unknown, incoming: unknown): unknown {
	return mergeTimestampedSnapshots(existing, incoming)
}
