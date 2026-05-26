import { defaultCommitMessageAttributionSettings, defaultCommitMessageGitContextSettings } from "@roo-code/types"

import { getActiveCommitMessageProfileSettings, getCommitMessageProfileSettings } from "../profileSettings"

describe("commit message profile settings", () => {
	const createContextProxy = (values: Record<string, unknown>) => ({
		getValue: vi.fn((key: string) => values[key]),
	})

	it("creates one default profile from old single-profile settings", () => {
		const contextProxy = createContextProxy({
			customSupportPrompts: { COMMIT_MESSAGE: "Custom commit prompt ${gitContext}" },
			commitMessageApiConfigId: "commit-profile",
			commitMessageGitContext: { diffContextLines: 8, includeRecentCommits: false },
			commitMessageAttribution: { enabled: true, template: "Assisted-by: ${providerModel}" },
		})

		const settings = getCommitMessageProfileSettings(contextProxy)

		expect(settings.activeProfileId).toBe("default")
		expect(settings.profiles).toHaveLength(1)
		expect(settings.profiles[0]).toMatchObject({
			id: "default",
			name: "Default",
			prompt: "Custom commit prompt ${gitContext}",
			apiConfigId: "commit-profile",
		})
		expect(settings.profiles[0].gitContext).toMatchObject({
			...defaultCommitMessageGitContextSettings,
			diffContextLines: 8,
			includeRecentCommits: false,
		})
		expect(settings.profiles[0].attribution).toEqual({
			enabled: true,
			template: "Assisted-by: ${providerModel}",
		})
	})

	it("clamps profiles to 5 and falls back to the first profile when the active id is missing", () => {
		const contextProxy = createContextProxy({
			commitMessageProfiles: {
				activeProfileId: "missing",
				profiles: Array.from({ length: 7 }, (_, index) => ({
					id: `profile-${index + 1}`,
					name: `Profile ${index + 1}`,
				})),
			},
		})

		const settings = getCommitMessageProfileSettings(contextProxy)

		expect(settings.profiles).toHaveLength(5)
		expect(settings.activeProfileId).toBe("profile-1")
	})

	it("clamps recent commit diff count while merging default Git context settings", () => {
		const contextProxy = createContextProxy({
			commitMessageProfiles: {
				activeProfileId: "detailed",
				profiles: [
					{
						id: "detailed",
						name: "Detailed",
						gitContext: { includeRecentCommitDiffs: true, recentCommitDiffCount: 9 },
					},
				],
			},
		})

		const profile = getActiveCommitMessageProfileSettings(contextProxy)

		expect(profile.gitContext).toMatchObject({
			...defaultCommitMessageGitContextSettings,
			includeRecentCommitDiffs: true,
			recentCommitDiffCount: 5,
		})
	})

	it("does not apply top-level attribution fallback to stored profiles", () => {
		const contextProxy = createContextProxy({
			commitMessageAttribution: { enabled: true, template: "Assisted-by: ${providerModel}" },
			commitMessageProfiles: {
				activeProfileId: "default",
				profiles: [{ id: "default", name: "Default" }],
			},
		})

		const profile = getActiveCommitMessageProfileSettings(contextProxy)

		expect(profile.attribution).toEqual(defaultCommitMessageAttributionSettings)
	})

	it("normalizes stored profile attribution independently", () => {
		const contextProxy = createContextProxy({
			commitMessageProfiles: {
				activeProfileId: "release",
				profiles: [
					{ id: "default", name: "Default" },
					{ id: "release", name: "Release", attribution: { enabled: true } },
				],
			},
		})

		const profile = getActiveCommitMessageProfileSettings(contextProxy)

		expect(profile.attribution).toEqual({
			...defaultCommitMessageAttributionSettings,
			enabled: true,
		})
	})
})
