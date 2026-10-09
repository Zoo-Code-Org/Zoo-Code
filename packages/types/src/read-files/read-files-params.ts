/**
 * Parameters, validation, and limits for bounded native multiple-file reads (read_files).
 */
import { z } from "zod"

/** A deliberately small, sequential batch of modern file reads. */
export const MAX_READ_FILES = 10

const optionalInteger = (minimum: number) =>
	z
		.number()
		.int()
		.min(minimum)
		.max(Number.MAX_SAFE_INTEGER)
		.nullish()
		.transform((value) => value ?? undefined)

export const readFilesParamsSchema = z
	.object({
		entries: z
			.array(
				z
					.object({
						path: z.string().min(1).max(1024),
						mode: z
							.enum(["slice", "indentation"])
							.nullish()
							.transform((value) => value ?? undefined),
						offset: optionalInteger(1),
						limit: optionalInteger(1),
						indentation: z
							.object({
								anchor_line: optionalInteger(1),
								max_levels: optionalInteger(0),
								include_siblings: z
									.boolean()
									.nullish()
									.transform((value) => value ?? undefined),
								include_header: z
									.boolean()
									.nullish()
									.transform((value) => value ?? undefined),
								max_lines: optionalInteger(1),
							})
							.strict()
							.nullish()
							.transform((value) => value ?? undefined),
					})
					.strict(),
			)
			.min(1)
			.max(MAX_READ_FILES),
	})
	.strict()

export type ReadFilesParams = z.infer<typeof readFilesParamsSchema>
