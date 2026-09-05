import type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js"

export const MCP_OAUTH_GRANT_TYPES = ["authorization_code", "refresh_token"] as const
export type McpOAuthGrantType = (typeof MCP_OAUTH_GRANT_TYPES)[number]

export const AUTHORIZATION_CODE_GRANT_TYPE = MCP_OAUTH_GRANT_TYPES[0]
export const REFRESH_TOKEN_GRANT_TYPE = MCP_OAUTH_GRANT_TYPES[1]

export interface McpOAuthClientMetadata extends OAuthClientMetadata {
	application_type: "native"
}

export function selectMcpOAuthGrantTypes(supportedGrantTypes?: readonly string[]): McpOAuthGrantType[] {
	const supported = new Set(supportedGrantTypes ?? MCP_OAUTH_GRANT_TYPES)
	return MCP_OAUTH_GRANT_TYPES.filter((grantType) => supported.has(grantType))
}

export function buildMcpOAuthClientMetadata(options: {
	clientName: string
	redirectUrl: string
	grantTypes: readonly McpOAuthGrantType[]
	tokenEndpointAuthMethod: string
}): McpOAuthClientMetadata {
	if (!options.grantTypes.includes(AUTHORIZATION_CODE_GRANT_TYPE)) {
		throw new Error("MCP OAuth registration requires authorization_code support")
	}

	return {
		application_type: "native",
		client_name: options.clientName,
		redirect_uris: [options.redirectUrl],
		grant_types: [...options.grantTypes],
		response_types: ["code"],
		token_endpoint_auth_method: options.tokenEndpointAuthMethod,
	}
}
