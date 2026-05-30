import crypto from "crypto"
import type { Logger, Requirement, RequirementsVerificationResult, ConflictResolver } from "./types"
import { KeywordConflictResolver } from "./KeywordConflictResolver"

export interface RequirementsVerifierConfig {
	/** Whether requirements verification is mandatory (blocks completion) */
	mandatory: boolean
	/** Whether to auto-extract requirements from prompt */
	autoExtract: boolean
	/** Whether to require all requirements to be verified before completion */
	requireAllVerified: boolean
}

const DEFAULT_CONFIG: RequirementsVerifierConfig = {
	mandatory: true,
	autoExtract: true,
	requireAllVerified: true,
}

export class RequirementsVerifier {
	private config: RequirementsVerifierConfig
	private requirements: Map<string, Requirement> = new Map()
	private processedMessageCount = 0
	private conflictResolver: ConflictResolver
	private allMessages: string[] = []
	private lastVerifyResult?: RequirementsVerificationResult

	constructor(
		private readonly logger?: Logger,
		config?: Partial<RequirementsVerifierConfig>,
		conflictResolver?: ConflictResolver,
	) {
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.conflictResolver = conflictResolver ?? new KeywordConflictResolver()
	}

	/**
	 * Replace the conflict resolver at runtime.
	 */
	setConflictResolver(resolver: ConflictResolver): void {
		this.conflictResolver = resolver
		this.logger?.appendLine(`[RequirementsVerifier] Conflict resolver set to: ${resolver.name}`)
	}

	/**
	 * Get the current conflict resolver.
	 */
	getConflictResolver(): ConflictResolver {
		return this.conflictResolver
	}

	updateConfig(config: Partial<RequirementsVerifierConfig>): void {
		this.config = { ...this.config, ...config }
		this.logger?.appendLine(`[RequirementsVerifier] Config updated: ${JSON.stringify(config)}`)
	}

	getConfig(): RequirementsVerifierConfig {
		return { ...this.config }
	}

	/**
	 * Process ALL user messages from the session (chronological order).
	 * Extracts requirements from each message and resolves conflicts
	 * where later messages supersede earlier ones.
	 */
	async processUserMessages(messages: string[]): Promise<Requirement[]> {
		if (messages.length === 0) return []

		this.logger?.appendLine(`[RequirementsVerifier] Processing ${messages.length} user messages`)

		// Store all messages for conflict resolution context
		this.allMessages = messages

		// Only process new messages since last call
		const newMessageCount = messages.length - this.processedMessageCount
		if (newMessageCount <= 0) {
			return this.getAllRequirements()
		}

		const messagesToProcess = messages.slice(this.processedMessageCount)

		for (let i = 0; i < messagesToProcess.length; i++) {
			const globalIndex = this.processedMessageCount + i
			const message = messagesToProcess[i]
			const extracted = this.extractFromPrompt(message, globalIndex)

			// Run conflict resolution against existing requirements
			await this.resolveConflicts(extracted, globalIndex)

			// Add new requirements
			for (const req of extracted) {
				this.requirements.set(req.id, req)
			}
		}

		this.processedMessageCount = messages.length

		const all = this.getAllRequirements()
		const active = all.filter((r) => r.status !== "superseded")
		this.logger?.appendLine(
			`[RequirementsVerifier] ${all.length} total requirements (${active.length} active, ${all.length - active.length} superseded)`,
		)

		return all
	}

	/**
	 * Resolve conflicts between newly extracted requirements and existing ones.
	 * Uses the pluggable conflict resolver to determine supersession.
	 */
	private async resolveConflicts(newRequirements: Requirement[], newMessageIndex: number): Promise<void> {
		const existingActive = this.getActiveRequirements()

		for (const newReq of newRequirements) {
			const resolution = await this.conflictResolver.resolve(newReq, existingActive, newMessageIndex, this.allMessages)

			for (const supersededId of resolution.supersedes) {
				const existing = this.requirements.get(supersededId)
				if (existing && existing.status !== "superseded") {
					existing.status = "superseded"
					existing.supersededBy = newReq.id
					newReq.supersedes = existing.id
					this.logger?.appendLine(
						`[RequirementsVerifier] ${this.conflictResolver.name} resolver: "${existing.text.slice(0, 60)}..." superseded by "${newReq.text.slice(0, 60)}..." (confidence: ${resolution.confidence})`,
					)
				}
			}
		}
	}

	/**
	 * Extract requirements from a single user message.
	 */
	extractFromPrompt(prompt: string, messageIndex: number = 0): Requirement[] {
		const extracted: Requirement[] = []
		const lines = prompt.split("\n")
		let currentCategory: Requirement["category"] = "functional"

		for (const line of lines) {
			const trimmed = line.trim()
			if (!trimmed) continue

			// Detect category headers
			const categoryMatch = trimmed.match(
				/^(?:#+\s*)?(functional|non-functional|constraint|goal|edge.case|security|compliance|performance|reliability)/i,
			)
			if (categoryMatch) {
				const cat = categoryMatch[1].toLowerCase().replace(/[\s-]/g, "-")
				if (cat === "edge-case" || cat === "edge.case") currentCategory = "edge-case"
				else if (cat === "non-functional") currentCategory = "non-functional"
				else currentCategory = cat as Requirement["category"]
				continue
			}

			// Extract bullet points and numbered items
			const itemMatch = trimmed.match(/^[-*•]\s+(.+)/)
			const numMatch = trimmed.match(/^\d+[.)]\s+(.+)/)
			const reqText = itemMatch?.[1] || numMatch?.[1]

			if (reqText) {
				extracted.push(this.createRequirement(reqText, currentCategory, messageIndex))
				continue
			}

			// Extract sentences with requirement keywords
			const keywordMatch = trimmed.match(
				/(?:must|should|need|require|shall|will|ensure|verify|check|validate|support|implement|add|create|build|fix|refactor)\s.+[.!]/i,
			)
			if (keywordMatch && trimmed.length > 10 && trimmed.length < 500) {
				extracted.push(this.createRequirement(trimmed, currentCategory, messageIndex))
			}
		}

		// If no structured requirements found, treat the whole prompt as one requirement
		if (extracted.length === 0 && prompt.trim().length > 0) {
			extracted.push(this.createRequirement(prompt.trim(), "goal", messageIndex))
		}

		return extracted
	}

	/**
	 * Manually add a requirement
	 */
	addRequirement(text: string, category: Requirement["category"] = "functional"): Requirement {
		const req = this.createRequirement(text, category, this.processedMessageCount)
		this.requirements.set(req.id, req)
		return req
	}

	/**
	 * Mark a requirement as verified with evidence
	 */
	verifyRequirement(id: string, verifiedBy: Requirement["verifiedBy"], evidence: string): boolean {
		const req = this.requirements.get(id)
		if (!req) return false

		req.status = "verified"
		req.verifiedBy = verifiedBy
		req.evidence = evidence
		req.verifiedAt = Date.now()
		return true
	}

	/**
	 * Mark a requirement as failed
	 */
	failRequirement(id: string, evidence: string): boolean {
		const req = this.requirements.get(id)
		if (!req) return false

		req.status = "failed"
		req.evidence = evidence
		req.verifiedAt = Date.now()
		return true
	}

	/**
	 * Get all requirements (including superseded ones for audit trail)
	 */
	getAllRequirements(): Requirement[] {
		return Array.from(this.requirements.values())
	}

	/**
	 * Get only active (non-superseded) requirements
	 */
	getActiveRequirements(): Requirement[] {
		return this.getAllRequirements().filter((r) => r.status !== "superseded")
	}

	/**
	 * Get requirements by status
	 */
	getRequirementsByStatus(status: Requirement["status"]): Requirement[] {
		return this.getAllRequirements().filter((r) => r.status === status)
	}

	/**
	 * Run full verification — checks only ACTIVE (non-superseded) requirements
	 */
	getStatus(): Record<string, unknown> {
		return {
			enabled: true,
			requirementCount: this.requirements.size,
			activeCount: this.getActiveRequirements().length,
			supersededCount: Array.from(this.requirements.values()).filter(r => r.status === 'superseded').length,
			lastVerifyResult: this.lastVerifyResult,
		}
	}

	async verify(): Promise<RequirementsVerificationResult> {
		const all = this.getAllRequirements()
		const active = this.getActiveRequirements()
		const verified = active.filter((r) => r.status === "verified")
		const failed = active.filter((r) => r.status === "failed")
		const pending = active.filter((r) => r.status === "pending" || r.status === "skipped")
		const superseded = all.filter((r) => r.status === "superseded")

		const passed = failed.length === 0 && (pending.length === 0 || !this.config.requireAllVerified)

		let summary: string
		if (all.length === 0) {
			summary = "No requirements extracted"
		} else if (passed) {
			summary = `${active.length} active requirements: ${verified.length} verified, ${failed.length} failed, ${pending.length} pending (${superseded.length} superseded)`
		} else {
			summary = `${failed.length}/${active.length} active requirements failed: ${failed.map((r) => r.text.slice(0, 80)).join("; ")}`
		}

		this.lastVerifyResult = { passed, total: all.length, verified, failed, pending, summary }

		return { passed, total: all.length, verified, failed, pending, summary }
	}

	/**
	 * Reset all requirements
	 */
	reset(): void {
		this.requirements.clear()
		this.processedMessageCount = 0
		this.allMessages = []
	}

	/**
	 * Get the number of processed messages
	 */
	getProcessedMessageCount(): number {
		return this.processedMessageCount
	}

	private createRequirement(text: string, category: Requirement["category"], messageIndex: number): Requirement {
		return {
			id: crypto.randomUUID(),
			text,
			category,
			status: "pending",
			messageIndex,
		}
	}
}
