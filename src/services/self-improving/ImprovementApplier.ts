import crypto from "crypto"

import type { SkillProvenance } from "./SkillUsageStore"
import type { Experiments, ImprovementAction, LearnedPattern, PromptContext } from "./types"

interface ImprovementApplierOptions {
	getSkillNames?: () => string[]
	getSkillProvenance?: (name: string) => SkillProvenance | string
	getSkillProvenanceForSource?: (name: string, source: "global" | "project") => SkillProvenance | string
	hasSkill?: (name: string, source: "global" | "project") => boolean
	isAutoSkillsEnabled?: () => boolean
	getAutoSkillsScope?: () => "workspace" | "global"
	getExperiments?: () => Experiments | undefined
}

/**
 * ImprovementApplier - converts learned patterns into actionable improvements.
 *
 * Generates:
 * - Prompt enrichment context (bounded, ordered by confidence)
 * - Tool preference adjustments
 * - Error avoidance hints
 * - Skill suggestions / mutations for reusable workflows
 */
export class ImprovementApplier {
	private readonly getSkillNames: () => string[]
	private readonly getSkillProvenance: (name: string) => SkillProvenance | string
	private readonly getSkillProvenanceForSource: (
		name: string,
		source: "global" | "project",
	) => SkillProvenance | string
	private readonly hasSkill: (name: string, source: "global" | "project") => boolean
	private readonly isAutoSkillsEnabled: () => boolean
	private readonly getAutoSkillsScope: () => "workspace" | "global"
	private readonly getExperiments: () => Experiments | undefined

	constructor(options: ImprovementApplierOptions = {}) {
		this.getSkillNames = options.getSkillNames ?? (() => [])
		this.getSkillProvenance = options.getSkillProvenance ?? (() => "unknown")
		this.getSkillProvenanceForSource =
			options.getSkillProvenanceForSource ?? ((name: string) => this.getSkillProvenance(name))
		this.hasSkill =
			options.hasSkill ??
			((name: string, source: "global" | "project") =>
				source === "project" && this.getSkillNames().includes(name))
		this.isAutoSkillsEnabled = options.isAutoSkillsEnabled ?? (() => false)
		this.getAutoSkillsScope = options.getAutoSkillsScope ?? (() => "workspace")
		this.getExperiments = options.getExperiments ?? (() => undefined)
	}

	/**
	 * Generate improvement actions from learned patterns.
	 * Each active pattern maps to one or more actions.
	 */
	generateActions(patterns: LearnedPattern[]): ImprovementAction[] {
		const actions: ImprovementAction[] = []
		const now = Date.now()

		for (const pattern of patterns) {
			if (pattern.state !== "active") {
				continue
			}

			switch (pattern.patternType) {
				case "error":
					actions.push(this.createErrorAvoidanceAction(pattern, now))
					break
				case "tool":
					actions.push(this.createToolPreferenceAction(pattern, now))
					if (this.isAutoSkillsEnabled()) {
						const skillAction = this.createSkillMutationAction(pattern, now)
						if (skillAction) {
							actions.push(skillAction)
						}
					}
					break
				case "prompt":
					actions.push(this.createPromptEnrichmentAction(pattern, now))
					break
				case "skill":
					actions.push(this.createSkillSuggestionAction(pattern, now))
					break
			}
		}

		// SKILL_MERGE: detect similar skills and generate merge actions
		const experiments = this.getExperiments()
		if (experiments?.selfImprovingSkillMerge !== false) {
			const mergeActions = this.generateSkillMergeActions(patterns, now)
			actions.push(...mergeActions)
		}

		// SPECIALIZED_SKILL: generate SKILL_CREATE_FROM_SCRATCH actions for
		// high-confidence, domain-specific patterns that warrant dedicated skills
		if (experiments?.selfImprovingSpecializedSkills !== false) {
			const specializedActions = this.generateSpecializedSkillActions(patterns, now)
			actions.push(...specializedActions)
		}

		return actions
	}

	/**
	 * Build a bounded prompt context from learned patterns.
	 * Returns the top-N patterns by confidence, ordered descending.
	 */
	buildPromptContext(patterns: LearnedPattern[], maxEntries: number = 5): PromptContext {
		const active = patterns.filter((p) => p.state === "active" && p.confidenceScore != null)

		// Sort by confidence descending, take top N
		const top = active.sort((a, b) => (b.confidenceScore ?? 0) - (a.confidenceScore ?? 0)).slice(0, maxEntries)

		return {
			entries: top.map((p) => ({
				type: p.patternType,
				summary: p.summary,
				confidence: p.confidenceScore ?? 0,
			})),
			revision: Date.now(),
		}
	}

	/**
	 * Alias for buildPromptContext — used by SelfImprovingManager.getPromptContext().
	 */
	getPromptContext(patterns: LearnedPattern[], maxEntries: number, revision?: number): PromptContext {
		return this.buildPromptContext(patterns, maxEntries)
	}

	private createErrorAvoidanceAction(pattern: LearnedPattern, now: number): ImprovementAction {
		const errorKeys = pattern.context.errorKeys ?? []
		const primaryErrorKey = errorKeys.length > 0 ? errorKeys[0] : "unknown"

		return {
			id: crypto.randomUUID(),
			actionType: "ERROR_AVOIDANCE",
			target: "task-execution",
			payload: {
				summary: pattern.summary,
				errorKeys,
				confidence: pattern.confidenceScore ?? 0.5,
				patternId: pattern.id,
				primaryErrorKey,
			},
			timestamp: now,
		}
	}

	private createToolPreferenceAction(pattern: LearnedPattern, now: number): ImprovementAction {
		const toolNames = pattern.context.toolNames ?? []
		return {
			id: crypto.randomUUID(),
			actionType: "TOOL_PREFERENCE",
			target: "task-execution",
			payload: {
				summary: pattern.summary,
				toolNames,
				confidence: pattern.confidenceScore ?? 0.5,
				patternId: pattern.id,
			},
			timestamp: now,
		}
	}

	private createPromptEnrichmentAction(pattern: LearnedPattern, now: number): ImprovementAction {
		return {
			id: crypto.randomUUID(),
			actionType: "PROMPT_ENRICHMENT",
			target: "system-prompt",
			payload: {
				summary: pattern.summary,
				confidence: pattern.confidenceScore ?? 0.5,
				patternId: pattern.id,
			},
			timestamp: now,
		}
	}

	private createSkillSuggestionAction(pattern: LearnedPattern, now: number): ImprovementAction {
		const toolNames = pattern.context.toolNames ?? []
		const skillName = this.buildWorkflowSkillName(toolNames)
		const summary = `Capture reusable workflow for ${toolNames.join(", ")}`

		return {
			id: crypto.randomUUID(),
			actionType: "SKILL_SUGGESTION",
			target: "review-queue",
			payload: {
				summary,
				skillName,
				confidence: pattern.confidenceScore ?? 0.5,
				patternId: pattern.id,
			},
			timestamp: now,
		}
	}

	private createSkillMutationAction(pattern: LearnedPattern, now: number): ImprovementAction | undefined {
		const toolNames = pattern.context.toolNames ?? []
		if (toolNames.length === 0) {
			return undefined
		}

		const skillName = this.buildWorkflowSkillName(toolNames)
		const summary = `Auto-created workflow for ${toolNames.join(", ")}`
		const source = this.getAutoSkillsScope() === "global" ? "global" : "project"
		const skillId = this.buildSkillId(skillName, source)

		if (this.hasSkill(skillName, source)) {
			return {
				id: crypto.randomUUID(),
				actionType: "SKILL_UPDATE",
				target: "skills-manager",
				payload: {
					skillName,
					skillId,
					content: this.buildSkillContent(skillName, summary, toolNames),
					source,
					confidence: pattern.confidenceScore ?? 0.5,
					patternId: pattern.id,
				},
				timestamp: now,
			}
		}

		return {
			id: crypto.randomUUID(),
			actionType: "SKILL_CREATE",
			target: "skills-manager",
			payload: {
				skillName,
				skillId,
				description: summary,
				content: this.buildSkillContent(skillName, summary, toolNames),
				source,
				confidence: pattern.confidenceScore ?? 0.5,
				patternId: pattern.id,
			},
			timestamp: now,
		}
	}

	private buildWorkflowSkillName(toolNames: string[]): string {
		return `workflow-${toolNames
			.map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, "-"))
			.sort()
			.join("-")}`
	}

	private buildSkillId(skillName: string, source: "global" | "project"): string {
		return `skill:${source}:${skillName}`
	}

	private buildSkillContent(skillName: string, description: string, toolNames: string[]): string {
		const title = skillName
			.split("-")
			.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
			.join(" ")
		const bulletList = toolNames.map((toolName) => "- `" + toolName + "`").join("\n")
		const inlineTools = toolNames.map((toolName) => "`" + toolName + "`").join(" then ")

		return `---
name: ${skillName}
description: ${description}
---

# ${title}

## When to use

${description}

## Preferred tools

${bulletList}

## Workflow

1. Start with ${inlineTools}.
2. Keep the sequence focused on the same reusable workflow.
3. Update this skill when the workflow changes materially.
`
	}

	/**
	 * Generate SKILL_MERGE actions when similar skills are detected.
	 * Two skills are considered similar if they share significant tool overlap.
	 */
	private generateSkillMergeActions(patterns: LearnedPattern[], now: number): ImprovementAction[] {
		const actions: ImprovementAction[] = []
		const skillPatterns = patterns.filter(
			(p) => p.patternType === "skill" && p.state === "active" && p.frequency >= 2,
		)

		if (skillPatterns.length < 2) {
			return actions
		}

		// Group patterns by tool overlap
		const processed = new Set<string>()
		for (let i = 0; i < skillPatterns.length; i++) {
			if (processed.has(skillPatterns[i].id)) {
				continue
			}

			const toolsA = new Set(skillPatterns[i].context.toolNames ?? [])
			const mergeGroup: LearnedPattern[] = [skillPatterns[i]]
			processed.add(skillPatterns[i].id)

			for (let j = i + 1; j < skillPatterns.length; j++) {
				if (processed.has(skillPatterns[j].id)) {
					continue
				}

				const toolsB = new Set(skillPatterns[j].context.toolNames ?? [])
				const overlap = [...toolsA].filter((t) => toolsB.has(t))

				// Merge if at least 50% tool overlap
				const minSize = Math.min(toolsA.size, toolsB.size)
				if (minSize > 0 && overlap.length / minSize >= 0.5) {
					mergeGroup.push(skillPatterns[j])
					processed.add(skillPatterns[j].id)
				}
			}

			if (mergeGroup.length >= 2) {
				const umbrellaName = this.buildMergeSkillName(mergeGroup)
				const absorbNames = mergeGroup
					.slice(1)
					.map((p) => this.buildWorkflowSkillName(p.context.toolNames ?? []))
				const mergedDescription = `Merged skill combining ${mergeGroup.map((p) => p.summary).join("; ")}`
				const mergedContent = this.buildMergeSkillContent(umbrellaName, mergedDescription, mergeGroup)

				actions.push({
					id: crypto.randomUUID(),
					actionType: "SKILL_MERGE",
					target: "skills-manager",
					payload: {
						umbrellaName,
						absorbNames,
						description: mergedDescription,
						content: mergedContent,
						source: this.getAutoSkillsScope() === "global" ? "global" : "project",
						patternIds: mergeGroup.map((p) => p.id),
						confidence: Math.min(
							1,
							mergeGroup.reduce((sum, p) => sum + (p.confidenceScore ?? 0), 0) / mergeGroup.length,
						),
					},
					timestamp: now,
				})
			}
		}

		return actions
	}

	private buildMergeSkillName(patterns: LearnedPattern[]): string {
		const allTools = new Set<string>()
		for (const pattern of patterns) {
			for (const toolName of pattern.context.toolNames ?? []) {
				allTools.add(toolName)
			}
		}

		return this.buildWorkflowSkillName([...allTools])
	}

	private buildMergeSkillContent(name: string, description: string, patterns: LearnedPattern[]): string {
		const title = name
			.split("-")
			.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
			.join(" ")

		const allTools = new Set<string>()
		for (const pattern of patterns) {
			for (const toolName of pattern.context.toolNames ?? []) {
				allTools.add(toolName)
			}
		}

		const bulletList = [...allTools].map((toolName) => "- `" + toolName + "`").join("\n")
		const inlineTools = [...allTools].map((toolName) => "`" + toolName + "`").join(" then ")

		const patternSummaries = patterns
			.map((p) => `- ${p.summary} (confidence: ${((p.confidenceScore ?? 0) * 100).toFixed(0)}%)`)
			.join("\n")

		return `---
name: ${name}
description: ${description}
---

# ${title}

## Description

${description}

## Merged From

${patternSummaries}

## Preferred Tools

${bulletList}

## Workflow

1. Start with ${inlineTools}.
2. Keep the sequence focused on the same reusable workflow.
3. This skill was automatically merged from similar patterns.
`
	}

	/**
	 * Generate SKILL_CREATE_FROM_SCRATCH actions for high-confidence,
	 * domain-specific patterns that warrant dedicated specialized skills.
	 *
	 * A pattern qualifies for specialization when:
	 * - It has high confidence (>= 0.7) and frequency (>= 3)
	 * - It involves domain-specific tool combinations
	 * - The pattern summary suggests a reusable domain (e.g., "react", "api", "test", "deploy")
	 *
	 * Enhanced with:
	 * - Flexible domain detection via tool usage patterns + task description analysis
	 * - Versatility scoring to measure cross-domain applicability
	 * - Cross-domain applicability notes in skill content
	 * - High-versatility skills promoted to global scope
	 */
	private generateSpecializedSkillActions(patterns: LearnedPattern[], now: number): ImprovementAction[] {
		const actions: ImprovementAction[] = []

		// Only generate when auto-skills are enabled
		if (!this.isAutoSkillsEnabled()) {
			return actions
		}

		const defaultSource = this.getAutoSkillsScope() === "global" ? "global" : "project"

		for (const pattern of patterns) {
			if (pattern.state !== "active") {
				continue
			}

			// Require high confidence and sufficient frequency for specialization
			if ((pattern.confidenceScore ?? 0) < 0.7 || (pattern.frequency ?? 0) < 3) {
				continue
			}

			const toolNames = pattern.context.toolNames ?? []
			if (toolNames.length === 0) {
				continue
			}

			// Detect domain from pattern summary and tool names — flexible approach
			const domainResult = this.detectSpecializedDomain(pattern.summary, toolNames)
			if (!domainResult) {
				continue
			}

			const { domain, crossDomainPatterns } = domainResult

			// Compute versatility score — how broadly applicable this skill is
			const versatilityScore = this.computeVersatilityScore(domain, toolNames, pattern)

			// High-versatility skills should be global; low-versatility stay project-local
			const source = versatilityScore >= 0.7 ? "global" : defaultSource

			const skillName = this.buildSpecializedSkillName(domain, toolNames)
			const skillId = this.buildSkillId(skillName, source)

			// Skip if skill already exists
			if (this.hasSkill(skillName, source)) {
				continue
			}

			const description = `Specialized skill for ${domain}: ${pattern.summary}`
			const instructions = this.buildSpecializedSkillContent(
				skillName,
				description,
				domain,
				toolNames,
				pattern,
				versatilityScore,
				crossDomainPatterns,
			)

			actions.push({
				id: crypto.randomUUID(),
				actionType: "SKILL_CREATE_FROM_SCRATCH",
				target: "skills-manager",
				payload: {
					name: skillName,
					skillId,
					description,
					instructions,
					source,
					modeSlugs: pattern.context.modes ?? [],
					tools: toolNames,
					confidence: pattern.confidenceScore ?? 0.7,
					patternId: pattern.id,
					// New metadata for cross-domain versatility
					domains: this.inferRelatedDomains(domain, toolNames, pattern),
					versatilityScore,
					crossDomainPatterns,
				},
				timestamp: now,
			})
		}

		return actions
	}

	/**
	 * Compute a versatility score (0-1) measuring how broadly applicable
	 * a skill is across different domains.
	 *
	 * Factors:
	 * - Tool diversity: more distinct tools → higher versatility
	 * - Domain generality: generic domains (e.g., "code-review", "documentation")
	 *   score higher than specific ones (e.g., "react-component")
	 * - Pattern frequency: higher frequency suggests broader applicability
	 * - Mode diversity: patterns seen across multiple modes are more versatile
	 */
	private computeVersatilityScore(domain: string, toolNames: string[], pattern: LearnedPattern): number {
		let score = 0.3 // baseline

		// Factor 1: Tool diversity (0-0.3)
		const toolDiversity = Math.min(1, toolNames.length / 5) * 0.3
		score += toolDiversity

		// Factor 2: Domain generality (0-0.2)
		// Generic domains are more versatile than framework-specific ones
		const genericDomains = new Set([
			"code-review", "documentation", "security-audit", "deployment-pipeline",
		])
		if (genericDomains.has(domain)) {
			score += 0.2
		} else if (domain.startsWith("database-") || domain.startsWith("api-")) {
			score += 0.1 // Semi-generic
		}
		// Framework-specific domains (react-component, test-suite) get no bonus

		// Factor 3: Frequency bonus (0-0.1)
		const freq = pattern.frequency ?? 0
		score += Math.min(0.1, freq * 0.02)

		// Factor 4: Mode diversity (0-0.1)
		const modes = pattern.context.modes ?? []
		if (modes.length > 1) {
			score += 0.1
		} else if (modes.length === 1) {
			score += 0.05
		}

		return Math.min(1, Math.round(score * 100) / 100)
	}

	/**
	 * Infer related domains that this skill could apply to.
	 * Returns an array of domain strings beyond the primary domain.
	 */
	private inferRelatedDomains(primaryDomain: string, toolNames: string[], pattern: LearnedPattern): string[] {
		const related: string[] = []
		const lowerSummary = pattern.summary.toLowerCase()
		const allTools = toolNames.map((t) => t.toLowerCase()).join(" ")
		const searchText = `${lowerSummary} ${allTools}`

		// Cross-domain pattern map: tool/term → secondary domains
		const crossDomainTriggers: Array<{ pattern: RegExp; domain: string }> = [
			{ pattern: /\b(read|write|file|fs|path)\b/, domain: "file-operations" },
			{ pattern: /\b(config|env|setting|option)\b/, domain: "configuration" },
			{ pattern: /\b(log|debug|trace|error)\b/, domain: "debugging" },
			{ pattern: /\b(validate|check|verify|assert)\b/, domain: "validation" },
			{ pattern: /\b(format|lint|style|prettier|eslint)\b/, domain: "code-formatting" },
			{ pattern: /\b(git|commit|branch|merge|pr|pull)\b/, domain: "version-control" },
			{ pattern: /\b(build|compile|bundle|webpack|vite|tsc)\b/, domain: "build-tooling" },
			{ pattern: /\b(test|spec|mock|stub|fixture)\b/, domain: "testing" },
			{ pattern: /\b(doc|readme|comment|annotation)\b/, domain: "documentation" },
			{ pattern: /\b(perf|performance|optimize|profile)\b/, domain: "performance" },
		]

		for (const { pattern, domain } of crossDomainTriggers) {
			if (pattern.test(searchText) && domain !== primaryDomain) {
				related.push(domain)
			}
		}

		// Deduplicate and limit
		return [...new Set(related)].slice(0, 5)
	}

	/**
	 * Detect a specialized domain from pattern summary and tool names.
	 * Returns a domain string (e.g., "react-component", "api-endpoint", "test-suite")
	 * or undefined if no specialized domain is detected.
	 *
	 * Enhanced with:
	 * - Cross-domain pattern analysis: returns both primary domain and cross-domain patterns
	 * - Tool-based domain inference: analyzes tool names for domain hints
	 * - Summary-based domain inference: analyzes task descriptions for domain hints
	 */
	private detectSpecializedDomain(
		summary: string,
		toolNames: string[],
	): { domain: string; crossDomainPatterns: string[] } | undefined {
		const lowerSummary = summary.toLowerCase()
		const allTools = toolNames.map((t) => t.toLowerCase()).join(" ")
		const searchText = `${lowerSummary} ${allTools}`

		// Domain detection rules — ordered by specificity
		// Each rule now includes cross-domain pattern tags
		const domains: Array<{ pattern: RegExp; domain: string; crossTags: string[] }> = [
			// React/UI component building
			{
				pattern: /\b(react|component|jsx|tsx|ui|component)\b/,
				domain: "react-component",
				crossTags: ["ui-development", "frontend", "component-architecture"],
			},
			// API endpoint creation
			{
				pattern: /\b(api|endpoint|route|rest|graphql|express|fastify)\b/,
				domain: "api-endpoint",
				crossTags: ["backend", "http", "data-exchange", "service-integration"],
			},
			// Test writing
			{
				pattern: /\b(test|spec|vitest|jest|mocha|tdd|assert)\b/,
				domain: "test-suite",
				crossTags: ["quality-assurance", "verification", "regression-prevention"],
			},
			// Database operations
			{
				pattern: /\b(db|database|sql|query|schema|migration|postgres|mongodb)\b/,
				domain: "database-operation",
				crossTags: ["data-persistence", "data-modeling", "storage"],
			},
			// Deployment/CI
			{
				pattern: /\b(deploy|ci|cd|pipeline|docker|kubernetes|k8s)\b/,
				domain: "deployment-pipeline",
				crossTags: ["infrastructure", "release-management", "automation"],
			},
			// Code review
			{
				pattern: /\b(review|audit|lint|quality|refactor)\b/,
				domain: "code-review",
				crossTags: ["quality-assurance", "maintainability", "best-practices"],
			},
			// Documentation
			{
				pattern: /\b(doc|readme|markdown|documentation|api-doc)\b/,
				domain: "documentation",
				crossTags: ["knowledge-sharing", "onboarding", "api-reference"],
			},
			// Security
			{
				pattern: /\b(security|auth|oauth|jwt|vulnerability|audit)\b/,
				domain: "security-audit",
				crossTags: ["compliance", "threat-modeling", "access-control"],
			},
		]

		for (const { pattern, domain, crossTags } of domains) {
			if (pattern.test(searchText)) {
				// Also scan for additional cross-domain patterns from the summary
				const additionalPatterns = this.inferCrossDomainPatterns(searchText, domain)
				const allPatterns = [...new Set([...crossTags, ...additionalPatterns])]
				return { domain, crossDomainPatterns: allPatterns }
			}
		}

		return undefined
	}

	/**
	 * Infer cross-domain patterns from search text beyond the primary domain.
	 * Returns pattern tags that describe how this skill applies across domains.
	 */
	private inferCrossDomainPatterns(searchText: string, primaryDomain: string): string[] {
		const patterns: string[] = []

		const crossPatterns: Array<{ pattern: RegExp; tag: string }> = [
			{ pattern: /\b(read|write|file|fs|path)\b/, tag: "file-operations" },
			{ pattern: /\b(config|env|setting|option)\b/, tag: "configuration-management" },
			{ pattern: /\b(log|debug|trace|error)\b/, tag: "observability" },
			{ pattern: /\b(validate|check|verify|assert)\b/, tag: "validation" },
			{ pattern: /\b(format|lint|style|prettier|eslint)\b/, tag: "code-quality" },
			{ pattern: /\b(git|commit|branch|merge|pr|pull)\b/, tag: "version-control" },
			{ pattern: /\b(build|compile|bundle|webpack|vite|tsc)\b/, tag: "build-tooling" },
			{ pattern: /\b(perf|performance|optimize|profile)\b/, tag: "performance-optimization" },
			{ pattern: /\b(async|await|promise|callback|stream)\b/, tag: "async-patterns" },
			{ pattern: /\b(error|exception|throw|catch|try)\b/, tag: "error-handling" },
		]

		for (const { pattern, tag } of crossPatterns) {
			if (pattern.test(searchText) && tag !== primaryDomain) {
				patterns.push(tag)
			}
		}

		return patterns
	}

	/**
	 * Build a skill name for a specialized domain.
	 * Format: {domain}-{tool1}-{tool2} (sorted, deduplicated)
	 */
	private buildSpecializedSkillName(domain: string, toolNames: string[]): string {
		const toolPart = toolNames
			.map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, "-"))
			.sort()
			.join("-")
		return `${domain}-${toolPart}`
	}

	/**
	 * Build full SKILL.md instructions body for a specialized skill.
	 * Returns only the markdown body (without frontmatter — frontmatter is
	 * added by ActionExecutor).
	 *
	 * Enhanced with:
	 * - Cross-domain applicability notes
	 * - Versatility score display
	 * - Related domains section
	 */
	private buildSpecializedSkillContent(
		skillName: string,
		description: string,
		domain: string,
		toolNames: string[],
		pattern: LearnedPattern,
		versatilityScore: number,
		crossDomainPatterns: string[],
	): string {
		const title = skillName
			.split("-")
			.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
			.join(" ")

		const toolList = toolNames.map((t) => `- \`${t}\``).join("\n")
		const confidencePct = ((pattern.confidenceScore ?? 0) * 100).toFixed(0)
		const versatilityPct = (versatilityScore * 100).toFixed(0)

		const crossDomainSection =
			crossDomainPatterns.length > 0
				? `## Cross-Domain Applicability

This skill's patterns are applicable beyond the primary **${domain}** domain. The following cross-domain patterns were detected:

${crossDomainPatterns.map((p) => `- \`${p}\``).join("\n")}

When working in these related areas, consider adapting the core workflow from this skill.
`
				: ""

		return `# ${title}

## Description

${description}

## Domain

${domain}

## When to Use

This specialized skill is recommended when the task involves **${domain}** patterns with the following tools:

${toolList}

## Instructions

1. Analyze the task context to determine if this ${domain} skill applies.
2. Use the preferred tools in the recommended sequence.
3. Follow domain-specific best practices for ${domain}.
4. Validate output against the expected ${domain} patterns.

## Preferred Tools

${toolList}

${crossDomainSection}
## Versatility

This skill has a versatility score of **${versatilityPct}%** — indicating how broadly applicable it is across different domains and contexts.

| Factor | Contribution |
|--------|-------------|
| Tool diversity | ${toolNames.length} distinct tools |
| Domain generality | ${domain} |
| Pattern frequency | ${pattern.frequency} occurrences |
| Mode diversity | ${(pattern.context.modes ?? []).length > 0 ? `${(pattern.context.modes ?? []).length} mode(s)` : "any mode"} |

## Confidence

This skill was auto-generated from observed patterns with **${confidencePct}%** confidence (frequency: ${pattern.frequency}).
`
	}
}
