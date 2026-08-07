export const DCG_VERSION = "v0.7.7"

export type DcgArchiveInfo = Readonly<{
	archive: string
	binary: "dcg" | "dcg.exe"
	sha256: string
}>

export const DCG_ARCHIVES: Readonly<Record<string, DcgArchiveInfo>> = {
	"darwin-arm64": {
		archive: "dcg-aarch64-apple-darwin.tar.xz",
		binary: "dcg",
		sha256: "a63cf82bd3584055112d5ec7a4ab3d7e0619a9f806a53930c27aa0e6297484de",
	},
	"linux-arm64": {
		archive: "dcg-aarch64-unknown-linux-gnu.tar.xz",
		binary: "dcg",
		sha256: "abb0d94f23ab50f9edc16f8ca6939ff8eec23e1831d3ad7a28d9f03252c3306d",
	},
	"linux-x64": {
		archive: "dcg-x86_64-unknown-linux-musl.tar.xz",
		binary: "dcg",
		sha256: "472b130a9b235edc57e6cb7566641da5fef905e9dbefd3a46f9ad1e33205fa04",
	},
	"win32-x64": {
		archive: "dcg-x86_64-pc-windows-msvc.zip",
		binary: "dcg.exe",
		sha256: "435127410eabc53e772be4f5c668a875b45fbaf806654b577c2d975bd0e38964",
	},
} as const

export const DCG_DOWNLOAD_BASE_URL = `https://github.com/Dicklesworthstone/destructive_command_guard/releases/download/${DCG_VERSION}`

export const DCG_RUN_TIMEOUT_MS = 3_000
export const DCG_MAX_OUTPUT_BYTES = 256 * 1024

export const DCG_TRUSTED_DOWNLOAD_DOMAINS = [
	"github.com",
	"objects.githubusercontent.com",
	"release-assets.githubusercontent.com",
] as const
