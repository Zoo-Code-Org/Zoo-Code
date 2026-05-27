/**
 * Safely parses JSON without crashing on invalid input.
 *
 * @param jsonString The string to parse
 * @param defaultValue Value to return if parsing fails
 * @param context Optional label included in the error log so callers can be
 *   identified when something other than valid JSON is supplied (e.g. a user
 *   pasting a file path into a JSON field).
 * @returns Parsed JSON object or defaultValue if parsing fails
 */
export function safeJsonParse<T>(
	jsonString: string | null | undefined,
	defaultValue?: T,
	context?: string,
): T | undefined {
	if (!jsonString) {
		return defaultValue
	}

	try {
		return JSON.parse(jsonString) as T
	} catch (error) {
		// Log the error to the console for debugging.
		console.error(`Error parsing JSON${context ? ` (${context})` : ""}:`, error)
		return defaultValue
	}
}
