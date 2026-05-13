import { LLMock } from "@copilotkit/aimock"

type WriteToFileFixture = {
	toolCallId: string
	result: string
	id: string
}

export function addWriteToFileResultFixtures(mock: InstanceType<typeof LLMock>) {
	const fixtures: WriteToFileFixture[] = [
		{
			toolCallId: "call_write_to_file_create_001",
			result: "Created `write-to-file-tool-fixture/write-to-file-smoke.txt` with the requested content.",
			id: "call_write_to_file_create_002",
		},
		{
			toolCallId: "call_write_to_file_nested_001",
			result: "Created `write-to-file-tool-fixture/nested/deep/directory/write-to-file-nested-smoke.txt` with the requested content.",
			id: "call_write_to_file_nested_002",
		},
	]

	for (const fixture of fixtures) {
		mock.addFixture({
			match: {
				toolCallId: fixture.toolCallId,
			},
			response: {
				toolCalls: [
					{
						name: "attempt_completion",
						arguments: JSON.stringify({ result: fixture.result }),
						id: fixture.id,
					},
				],
			},
		})
	}
}
