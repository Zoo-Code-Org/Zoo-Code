type MessageRecord = Record<string, unknown> & { messageId?: unknown; ts?: unknown }
type IdentifiedMessage = { messageId?: string; ts?: unknown }

function isRecord(value: unknown): value is MessageRecord {
	return typeof value === "object" && value !== null
}

export function ensureMessageIdentifiers<T extends IdentifiedMessage>(messages: T[]): T[] {
	const timestampOrdinals = new Map<string, number>()
	for (const message of messages) {
		if (typeof message.messageId === "string") continue

		const timestampKey = typeof message.ts === "number" ? String(message.ts) : "none"
		const ordinal = timestampOrdinals.get(timestampKey) ?? 0
		timestampOrdinals.set(timestampKey, ordinal + 1)
		message.messageId = `legacy:${timestampKey}:${ordinal}`
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

	const consumedByTimestamp = new Map<number, Set<number>>()
	let incomingLegacyCount = 0
	const merged = incoming.map((message) => {
		if (!isRecord(message) || typeof message.ts !== "number") {
			incomingLegacyCount++
			return message
		}

		const existingGroup = existingGroups.get(message.ts) ?? []
		const consumed = consumedByTimestamp.get(message.ts) ?? new Set<number>()
		const messageId = typeof message.messageId === "string" ? message.messageId : undefined
		let diskIndex =
			messageId === undefined
				? existingGroup.findIndex(
						(candidate, index) => !consumed.has(index) && candidate.messageId === undefined,
					)
				: existingGroup.findIndex(
						(candidate, index) => !consumed.has(index) && candidate.messageId === messageId,
					)
		if (diskIndex === -1 && messageId !== undefined) {
			// Match one legacy record while persisted histories are upgraded with identifiers.
			diskIndex = existingGroup.findIndex(
				(candidate, index) => !consumed.has(index) && candidate.messageId === undefined,
			)
		}
		const diskMessage = diskIndex === -1 ? undefined : existingGroup[diskIndex]
		if (diskIndex !== -1) {
			consumed.add(diskIndex)
			consumedByTimestamp.set(message.ts, consumed)
		}
		if (mergeMatch !== undefined && diskMessage !== undefined) {
			return mergeMatch(diskMessage, message)
		}
		return message
	})

	const diskOnlyTimestamped = [...existingGroups.entries()].flatMap(([timestamp, messages]) => {
		const consumed = consumedByTimestamp.get(timestamp)
		return messages.filter((_message, index) => !consumed?.has(index))
	})

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
	timestampMerged.push(...diskOnlyTimestamped.slice(diskOnlyIndex))

	timestampMerged.push(...existingLegacy.slice(incomingLegacyCount))
	return timestampMerged
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
	return mergeTimestampedSnapshots(existing, incoming)
}
