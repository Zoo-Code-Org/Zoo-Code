import type { JWTInput } from "google-auth-library"

import { safeJsonParse } from "@roo-code/core"

// Detects when the "Google Cloud Credentials" field has received a filesystem
// path instead of the raw JSON contents of a service-account key file. Users
// often confuse this with GOOGLE_APPLICATION_CREDENTIALS (which IS a path),
// and the sibling "Google Cloud Key File Path" field is where a path belongs.
// Returns the parsed credentials object when the input looks like JSON, or
// undefined when the field is empty, path-shaped, or unparseable.
export function parseVertexJsonCredentials(value: string | undefined): JWTInput | undefined {
	const trimmed = value?.trim()
	if (!trimmed) {
		return undefined
	}

	const looksLikePath =
		/^[A-Za-z]:[\\/]/.test(trimmed) || // Windows: C:\... or C:/...
		trimmed.startsWith("/") || // POSIX absolute: /home/...
		trimmed.startsWith("~") || // POSIX home: ~/...
		trimmed.startsWith(".") // POSIX relative: ./... or ../...

	if (looksLikePath) {
		const preview = trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed
		console.warn(
			`[Vertex] The 'Google Cloud Credentials' field appears to contain a file path ("${preview}"), ` +
				"but this field expects the raw JSON contents of a service-account key file. " +
				"If you have a path to the credentials file, paste it into the 'Google Cloud Key File Path' field instead, " +
				"or leave both fields empty and use the GOOGLE_APPLICATION_CREDENTIALS environment variable.",
		)
		return undefined
	}

	return safeJsonParse<JWTInput>(trimmed, undefined, "Vertex credentials")
}
