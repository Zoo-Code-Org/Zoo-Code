export interface TestResultEvent {
	type: string
	data: {
		name?: string
		file?: string
		skip?: boolean
		todo?: boolean
		details?: { type?: string; error?: { failureType?: string; exitCode?: number; signal?: string } }
	}
}
export function summarizeTestEvents(
	events: AsyncIterable<TestResultEvent> | Iterable<TestResultEvent>,
	expected: string[],
	file: string,
	trusted: boolean,
): Promise<{
	passed: number
	failed: number
	cancelled: number
	failures: { name: string; file: string }[]
	complete: boolean
}>
