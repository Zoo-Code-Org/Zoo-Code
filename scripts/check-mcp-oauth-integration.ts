import assert from "node:assert/strict"

import {
	AUTHORIZATION_CODE_GRANT_TYPE,
	buildMcpOAuthClientMetadata,
	MCP_OAUTH_GRANT_TYPES,
	REFRESH_TOKEN_GRANT_TYPE,
	selectMcpOAuthGrantTypes,
} from "../src/services/mcp/oauthMetadata"

const advertisedGrantTypes = [
	AUTHORIZATION_CODE_GRANT_TYPE,
	REFRESH_TOKEN_GRANT_TYPE,
	"urn:ietf:params:oauth:grant-type:jwt-bearer",
	"urn:example:grant-type:extension",
] as const

let checkedCases = 0

// Repository policy: Zoo Code implements only these two token-endpoint grants.
// Keeping this assertion literal prevents an allowlist expansion from silently
// broadening dynamic registration.
assert.deepEqual(MCP_OAUTH_GRANT_TYPES, ["authorization_code", "refresh_token"])

for (let mask = 0; mask < 1 << advertisedGrantTypes.length; mask++) {
	const advertised = advertisedGrantTypes.filter((_, index) => mask & (1 << index))
	const selected = selectMcpOAuthGrantTypes(advertised)
	const expected = MCP_OAUTH_GRANT_TYPES.filter((grantType) => advertised.includes(grantType))

	// Normative MUST: RFC 7591 section 2 says grant_types describes grants the
	// client can use, and each token-endpoint grant_type must match its registered
	// value. https://www.rfc-editor.org/rfc/rfc7591.html#section-2
	// Repository policy: intersect server metadata with Zoo Code's implemented
	// grants, canonicalize order, and never propagate unknown extension values.
	assert.deepEqual(selected, expected, `unexpected grant selection for ${JSON.stringify(advertised)}`)
	assert.equal(new Set(selected).size, selected.length, "registration grant types must be unique")

	const buildMetadata = () =>
		buildMcpOAuthClientMetadata({
			clientName: "Zoo Code",
			redirectUrl: "http://localhost:12345/callback",
			grantTypes: selected,
			tokenEndpointAuthMethod: "none",
		})

	if (!selected.includes(AUTHORIZATION_CODE_GRANT_TYPE)) {
		assert.throws(buildMetadata, /requires authorization_code support/)
		checkedCases++
		continue
	}

	const metadata = buildMetadata()

	assert.deepEqual(metadata.grant_types, selected)
	// Normative SHOULD: RFC 7591 section 2.1 recommends consistent
	// authorization_code/code metadata.
	// https://www.rfc-editor.org/rfc/rfc7591.html#section-2.1
	assert.deepEqual(metadata.response_types, ["code"])
	// Normative MUST/SHOULD: MCP 2026-07-28 requires DCR clients to declare
	// application_type; desktop clients using localhost should identify as native.
	// https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration#application-type-and-redirect-uri-constraints
	assert.equal(metadata.application_type, "native")
	assert.match(metadata.redirect_uris[0], /^http:\/\/localhost:/)

	checkedCases++
}

// Repository policy: retain both implemented grants when RFC 8414's optional
// grant_types_supported metadata is omitted.
// https://www.rfc-editor.org/rfc/rfc8414.html#section-2
// Normative SHOULD: MCP clients that use refresh tokens should include
// refresh_token in their grant_types client metadata.
// https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#refresh-tokens
assert.deepEqual(selectMcpOAuthGrantTypes(), [...MCP_OAUTH_GRANT_TYPES])
assert.deepEqual(
	selectMcpOAuthGrantTypes([REFRESH_TOKEN_GRANT_TYPE, AUTHORIZATION_CODE_GRANT_TYPE, REFRESH_TOKEN_GRANT_TYPE]),
	[...MCP_OAUTH_GRANT_TYPES],
)

console.log(`MCP OAuth integration check passed (${checkedCases} advertised-grant combinations)`)
