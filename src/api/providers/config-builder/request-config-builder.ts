import type { ApiHandlerCreateMessageMetadata } from "../../index"
import { mergeAbortSignalAndTimeout, mergeAbortSignals } from "../utils/abort-signal"

/**
 * A generic, SDK-agnostic request configuration builder.
 *
 * Provides a fluent API for building request configurations with:
 * - Chainable method calls
 * - Generic type support (TOptions)
 * - Abort signal handling
 * - Header merging
 * - Static factory methods
 */
export class RequestConfigBuilder<TOptions extends Record<string, any> = Record<string, any>> {
	protected options: TOptions

	constructor(defaultOptions?: Partial<TOptions>) {
		this.options = (defaultOptions ? { ...defaultOptions } : {}) as TOptions
	}

	/**
	 * Add an abort signal from metadata.
	 *
	 * @param metadata - Optional metadata containing an abortSignal
	 * @returns this for chainable calls
	 */
	addAbortSignal(metadata?: ApiHandlerCreateMessageMetadata): this {
		if (!metadata?.abortSignal) {
			return this
		}

		this.options = { ...this.options, signal: metadata.abortSignal } as TOptions
		return this
	}

	/**
	 * Add or merge custom headers.
	 *
	 * @param headers - Key-value pairs of header names and values
	 * @returns this for chainable calls
	 */
	addHeaders(headers?: Record<string, string>): this {
		if (!headers || Object.keys(headers).length === 0) {
			return this
		}

		const existingHeaders = (this.options as any).headers ?? {}
		this.options = { ...this.options, headers: { ...existingHeaders, ...headers } } as TOptions
		return this
	}

	/**
	 * Merge an internal controller signal with an external metadata signal and optional timeout.
	 *
	 * Use this for providers that already maintain their own AbortController but also need
	 * to honor the request-level abort signal from metadata and/or a timeout.
	 *
	 * @param internalController - Provider-owned AbortController for the current request
	 * @param metadata - Optional metadata containing an external abortSignal
	 * @param timeoutMs - Optional positive timeout in milliseconds; <= 0 disables timeout
	 * @returns this for chainable calls
	 */
	addMergedSignal(
		internalController: AbortController,
		metadata?: ApiHandlerCreateMessageMetadata,
		timeoutMs?: number,
	): this {
		const merged = mergeAbortSignalAndTimeout(metadata?.abortSignal, timeoutMs)
		const signal = mergeAbortSignals(internalController.signal, merged.signal)

		this.options = { ...this.options, signal, _cleanup: merged.cleanup } as TOptions
		return this
	}

	/**
	 * Set a single option by key (type-safe).
	 *
	 * @param key - Option key
	 * @param value - Option value
	 * @returns this for chainable calls
	 */
	setOption<K extends keyof TOptions>(key: K, value: TOptions[K]): this {
		if (value === undefined) {
			return this
		}

		this.options = { ...this.options, [key]: value } as TOptions
		return this
	}

	/**
	 * Get an option by key.
	 *
	 * @param key - Option key
	 * @returns The option value or undefined if not set
	 */
	getOption<K extends keyof TOptions>(key: K): TOptions[K] | undefined {
		return this.options[key]
	}

	/**
	 * Build the final configuration object.
	 *
	 * Returns a shallow copy of the internal options to ensure immutability.
	 * Returns undefined if no options have been set.
	 *
	 * @returns The built configuration or undefined if empty
	 */
	build(): TOptions | undefined {
		const keys = Object.keys(this.options as object)
		if (keys.length === 0) {
			return undefined
		}

		return { ...this.options } as TOptions
	}

	/**
	 * Factory method to quickly create and configure a builder from metadata.
	 *
	 * @param metadata - Optional metadata containing an abortSignal
	 * @param extraOptions - Additional options to merge
	 * @returns The built configuration or undefined if empty
	 */
	static fromMetadata<TOptions extends Record<string, any> = Record<string, any>>(
		metadata?: ApiHandlerCreateMessageMetadata,
		extraOptions?: Partial<TOptions>,
	): TOptions | undefined {
		const builder = new RequestConfigBuilder<TOptions>(extraOptions)
		builder.addAbortSignal(metadata)
		return builder.build()
	}

	/**
	 * Merge multiple abort signals using the standard API.
	 *
	 * Uses `AbortSignal.any()` which correctly handles the case where
	 * any signal is already aborted.
	 *
	 * @param primarySignal - The primary abort signal
	 * @param secondarySignal - Optional secondary abort signal
	 * @returns A merged AbortSignal that aborts when any input signal aborts
	 */
	static mergeAbortSignals(primarySignal: AbortSignal, secondarySignal?: AbortSignal): AbortSignal {
		return mergeAbortSignals(primarySignal, secondarySignal)
	}
}
