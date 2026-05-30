import { z } from "zod"

/**
 * MemoryEntry - a single durable memory entry for prompt-facing context
 * Adapted from Hermes' bounded memory store concept.
 */
export const memoryEntrySchema = z.object({
	id: z.string(),
	content: z.string().max(2000),
	source: z.enum(["learning", "user", "system", "review"]),
	createdAt: z.number(),
	updatedAt: z.number(),
	relevanceScore: z.number().min(0).max(1).optional(),
	tags: z.array(z.string()).optional(),
	expiresAt: z.number().optional(),
})

export type MemoryEntry = z.infer<typeof memoryEntrySchema>

/**
 * MemoryContext - bounded set of memory entries for prompt injection
 */
export const memoryContextSchema = z.object({
	entries: z.array(memoryEntrySchema).max(10),
	revision: z.number().int().default(0),
	generatedAt: z.number(),
})

export type MemoryContext = z.infer<typeof memoryContextSchema>
