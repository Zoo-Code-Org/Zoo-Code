import { describe, expect, it } from "vitest"

import type { OrganizationAllowList } from "../cloud.js"
import { isModelAllowedForOrganization, isProviderAllowAll } from "../organization-allow-list.js"
import { providerIdentifiers } from "../provider-identifiers.js"

describe("isProviderAllowAll", () => {
	it("allows everything when the allow list is missing", () => {
		expect(isProviderAllowAll(undefined, providerIdentifiers.anthropic)).toBe(true)
	})

	it("allows everything when the organization allows all", () => {
		const allowList: OrganizationAllowList = { allowAll: true, providers: {} }
		expect(isProviderAllowAll(allowList, providerIdentifiers.anthropic)).toBe(true)
	})

	it("rejects when the provider is missing but the organization is restricted", () => {
		const allowList: OrganizationAllowList = { allowAll: false, providers: {} }
		expect(isProviderAllowAll(allowList, undefined)).toBe(false)
	})

	it("rejects a provider without an explicit entry", () => {
		const allowList: OrganizationAllowList = { allowAll: false, providers: {} }
		expect(isProviderAllowAll(allowList, providerIdentifiers.anthropic)).toBe(false)
	})

	it("allows a provider narrowed to a model list (the list still constrains models)", () => {
		const allowList: OrganizationAllowList = {
			allowAll: false,
			providers: { [providerIdentifiers.anthropic]: { allowAll: false, models: ["m"] } },
		}
		// A non-allowAll provider must not expose the custom-model escape hatch.
		expect(isProviderAllowAll(allowList, providerIdentifiers.anthropic)).toBe(false)
	})

	it("allows a provider explicitly marked allowAll", () => {
		const allowList: OrganizationAllowList = {
			allowAll: false,
			providers: { [providerIdentifiers.openrouter]: { allowAll: true } },
		}
		expect(isProviderAllowAll(allowList, providerIdentifiers.openrouter)).toBe(true)
	})
})

describe("isModelAllowedForOrganization", () => {
	it("allows any model when the allow list is missing", () => {
		expect(isModelAllowedForOrganization(undefined, providerIdentifiers.anthropic, "any")).toBe(true)
	})

	it("allows any model when the organization allows all", () => {
		const allowList: OrganizationAllowList = { allowAll: true, providers: {} }
		expect(isModelAllowedForOrganization(allowList, providerIdentifiers.anthropic, "any")).toBe(true)
	})

	it("rejects when the provider is missing but the organization is restricted", () => {
		const allowList: OrganizationAllowList = { allowAll: false, providers: {} }
		expect(isModelAllowedForOrganization(allowList, undefined, "any")).toBe(false)
	})

	it("rejects a model from a provider without an explicit entry", () => {
		const allowList: OrganizationAllowList = { allowAll: false, providers: {} }
		expect(isModelAllowedForOrganization(allowList, providerIdentifiers.anthropic, "m")).toBe(false)
	})

	it("allows a listed model and rejects an unlisted one", () => {
		const allowList: OrganizationAllowList = {
			allowAll: false,
			providers: { [providerIdentifiers.anthropic]: { allowAll: false, models: ["allowed"] } },
		}
		expect(isModelAllowedForOrganization(allowList, providerIdentifiers.anthropic, "allowed")).toBe(true)
		expect(isModelAllowedForOrganization(allowList, providerIdentifiers.anthropic, "other")).toBe(false)
	})

	it("allows any model for a provider explicitly marked allowAll", () => {
		const allowList: OrganizationAllowList = {
			allowAll: false,
			providers: { [providerIdentifiers.openrouter]: { allowAll: true } },
		}
		expect(isModelAllowedForOrganization(allowList, providerIdentifiers.openrouter, "anything")).toBe(true)
	})
})
