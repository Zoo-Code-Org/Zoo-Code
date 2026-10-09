/** Clip file-reading output by UTF-8 bytes without splitting a multi-byte character. */
export function clipUtf8(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text)
	if (buffer.length <= maxBytes) return text
	let end = Math.max(0, Math.floor(maxBytes))
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--
	return buffer.subarray(0, end).toString("utf8")
}
