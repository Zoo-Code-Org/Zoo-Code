/**
 * Content Reference Tool — Transform Engine
 *
 * Applies a pipeline of transformations to resolved content fragments.
 *
 * Pipeline order (strict):
 *   replace -> prepend -> wrap_with -> append
 */

import { info, successCrt } from "./superDebug"

// ─── Public Types ───────────────────────────────────────────────────────────

export interface TransformOptions {
    /** Substring replacement (all occurrences) */
    replace?: { from: string; to: string } | null
    /** Text to prepend before content */
    prepend?: string | null
    /** Template to wrap content with. "{content}" placeholder is replaced with content.
     *  If "{content}" is absent, content is appended to the template. */
    wrap_with?: string | null
    /** Text to append after content */
    append?: string | null
    /** Separator for joining multi_ref fragments */
    join_with?: string | null
}

// ─── Single Content Transform ───────────────────────────────────────────────

/**
 * Apply a pipeline of transformations to a single content string.
 *
 * Pipeline (strict order):
 *   1. replace   — replace all occurrences of `replace.from` with `replace.to`
 *   2. prepend   — add text before the content
 *   3. wrap_with — wrap content using template (placeholder "{content}" or append)
 *   4. append    — add text after the content
 *
 * Edge cases:
 * - Empty content → returned as-is
 * - transform is undefined/null → content returned as-is
 * - `replace.from` not found → replace step is skipped, other transforms apply
 * - `wrap_with` without "{content}" placeholder → content appended to template
 *
 * @param content  - The content string to transform
 * @param transform - Transform options (optional)
 * @returns Transformed content string
 */
export function applyTransform(content: string, transform?: TransformOptions | null): string {
    // Edge case: empty content or no transform
    if (!content || !transform) {
        return content
    }

    info("TRANSFORM", `applyTransform: inputLength=${content.length}, hasReplace=${!!transform.replace}, hasPrepend=${!!transform.prepend}, hasWrap=${!!transform.wrap_with}, hasAppend=${!!transform.append}`)

    let result = content

    // Step 1: replace — substitute all occurrences of `from` with `to`
    if (transform.replace && transform.replace.from) {
        // Only perform replacement if `from` exists in content
        if (result.includes(transform.replace.from)) {
            result = result.split(transform.replace.from).join(transform.replace.to)
        }
        // If `from` not found → skip replace, continue with remaining pipeline
    }

    // Step 2: prepend — add text before content
    if (transform.prepend) {
        result = transform.prepend + result
    }

    // Step 3: wrap_with — wrap content with template
    if (transform.wrap_with) {
        const placeholder = "{content}"
        if (transform.wrap_with.includes(placeholder)) {
            result = transform.wrap_with.replace(placeholder, result)
        } else {
            // No placeholder found → append content to template
            result = transform.wrap_with + result
        }
    }

    // Step 4: append — add text after content
    if (transform.append) {
        result = result + transform.append
    }

    info("TRANSFORM", `applyTransform: ${content.length} -> ${result.length} chars`)
    return result
}

// ─── Multi Content Transform ────────────────────────────────────────────────

/**
 * Apply the transform pipeline to multiple content fragments independently,
 * then optionally join them with a separator.
 *
 * Each fragment goes through the full pipeline: replace -> prepend -> wrap -> append.
 *
 * If `transform.join_with` is specified, all fragments are joined using it
 * and returned as `joined`. Otherwise, only `contents` is returned.
 *
 * @param contents  - Array of content strings to transform
 * @param transform - Transform options (optional)
 * @returns Object with transformed `contents` array and optional `joined` string
 */
export function applyMultiTransform(
    contents: string[],
    transform?: TransformOptions | null,
): { contents: string[]; joined?: string } {
    // Edge case: no content or no transform
    if (!contents || contents.length === 0 || !transform) {
        return { contents }
    }

    info("TRANSFORM", `applyMultiTransform: ${contents.length} fragments, join_with="${transform.join_with ?? ""}"`)

    // Apply transform to each fragment independently
    const transformed = contents.map((c) => applyTransform(c, transform))

    // Join fragments if join_with is specified
    let joined: string | undefined
    if (transform.join_with) {
        joined = transformed.join(transform.join_with)
    }

    successCrt("TRANSFORM", `applyMultiTransform: ${contents.length} fragment(s) transformed${joined !== undefined ? `, joinedLength=${joined.length}` : ""}`, {
        inputLengths: contents.map(c => c.length),
        outputLengths: transformed.map(c => c.length),
    })
    return { contents: transformed, joined }
}
