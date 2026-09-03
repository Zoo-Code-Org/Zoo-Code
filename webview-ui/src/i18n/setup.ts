import i18next from "i18next"
import { initReactI18next } from "react-i18next"

// Static imports for every locale JSON file. They back the fallback map used
// when `import.meta.glob` is unavailable: Playwright component tests transpile
// and evaluate this module on the Node side, where the Vite-only glob macro is
// undefined and calling it crashes with `TypeError: (intermediate value).glob
// is not a function`. Keep this list in sync with `src/i18n/locales/*/*.json`.
import caChatJson from "./locales/ca/chat.json"
import caCommonJson from "./locales/ca/common.json"
import caDashboardJson from "./locales/ca/dashboard.json"
import caHistoryJson from "./locales/ca/history.json"
import caMarketplaceJson from "./locales/ca/marketplace.json"
import caMcpJson from "./locales/ca/mcp.json"
import caPromptsJson from "./locales/ca/prompts.json"
import caSettingsJson from "./locales/ca/settings.json"
import caStatsJson from "./locales/ca/stats.json"
import caWelcomeJson from "./locales/ca/welcome.json"
import caWorktreesJson from "./locales/ca/worktrees.json"
import deChatJson from "./locales/de/chat.json"
import deCommonJson from "./locales/de/common.json"
import deDashboardJson from "./locales/de/dashboard.json"
import deHistoryJson from "./locales/de/history.json"
import deMarketplaceJson from "./locales/de/marketplace.json"
import deMcpJson from "./locales/de/mcp.json"
import dePromptsJson from "./locales/de/prompts.json"
import deSettingsJson from "./locales/de/settings.json"
import deStatsJson from "./locales/de/stats.json"
import deWelcomeJson from "./locales/de/welcome.json"
import deWorktreesJson from "./locales/de/worktrees.json"
import enChatJson from "./locales/en/chat.json"
import enCommonJson from "./locales/en/common.json"
import enDashboardJson from "./locales/en/dashboard.json"
import enHistoryJson from "./locales/en/history.json"
import enMarketplaceJson from "./locales/en/marketplace.json"
import enMcpJson from "./locales/en/mcp.json"
import enPromptsJson from "./locales/en/prompts.json"
import enSettingsJson from "./locales/en/settings.json"
import enStatsJson from "./locales/en/stats.json"
import enWelcomeJson from "./locales/en/welcome.json"
import enWorktreesJson from "./locales/en/worktrees.json"
import esChatJson from "./locales/es/chat.json"
import esCommonJson from "./locales/es/common.json"
import esDashboardJson from "./locales/es/dashboard.json"
import esHistoryJson from "./locales/es/history.json"
import esMarketplaceJson from "./locales/es/marketplace.json"
import esMcpJson from "./locales/es/mcp.json"
import esPromptsJson from "./locales/es/prompts.json"
import esSettingsJson from "./locales/es/settings.json"
import esStatsJson from "./locales/es/stats.json"
import esWelcomeJson from "./locales/es/welcome.json"
import esWorktreesJson from "./locales/es/worktrees.json"
import frChatJson from "./locales/fr/chat.json"
import frCommonJson from "./locales/fr/common.json"
import frDashboardJson from "./locales/fr/dashboard.json"
import frHistoryJson from "./locales/fr/history.json"
import frMarketplaceJson from "./locales/fr/marketplace.json"
import frMcpJson from "./locales/fr/mcp.json"
import frPromptsJson from "./locales/fr/prompts.json"
import frSettingsJson from "./locales/fr/settings.json"
import frStatsJson from "./locales/fr/stats.json"
import frWelcomeJson from "./locales/fr/welcome.json"
import frWorktreesJson from "./locales/fr/worktrees.json"
import hiChatJson from "./locales/hi/chat.json"
import hiCommonJson from "./locales/hi/common.json"
import hiDashboardJson from "./locales/hi/dashboard.json"
import hiHistoryJson from "./locales/hi/history.json"
import hiMarketplaceJson from "./locales/hi/marketplace.json"
import hiMcpJson from "./locales/hi/mcp.json"
import hiPromptsJson from "./locales/hi/prompts.json"
import hiSettingsJson from "./locales/hi/settings.json"
import hiStatsJson from "./locales/hi/stats.json"
import hiWelcomeJson from "./locales/hi/welcome.json"
import hiWorktreesJson from "./locales/hi/worktrees.json"
import idChatJson from "./locales/id/chat.json"
import idCommonJson from "./locales/id/common.json"
import idDashboardJson from "./locales/id/dashboard.json"
import idHistoryJson from "./locales/id/history.json"
import idMarketplaceJson from "./locales/id/marketplace.json"
import idMcpJson from "./locales/id/mcp.json"
import idPromptsJson from "./locales/id/prompts.json"
import idSettingsJson from "./locales/id/settings.json"
import idStatsJson from "./locales/id/stats.json"
import idWelcomeJson from "./locales/id/welcome.json"
import idWorktreesJson from "./locales/id/worktrees.json"
import itChatJson from "./locales/it/chat.json"
import itCommonJson from "./locales/it/common.json"
import itDashboardJson from "./locales/it/dashboard.json"
import itHistoryJson from "./locales/it/history.json"
import itMarketplaceJson from "./locales/it/marketplace.json"
import itMcpJson from "./locales/it/mcp.json"
import itPromptsJson from "./locales/it/prompts.json"
import itSettingsJson from "./locales/it/settings.json"
import itStatsJson from "./locales/it/stats.json"
import itWelcomeJson from "./locales/it/welcome.json"
import itWorktreesJson from "./locales/it/worktrees.json"
import jaChatJson from "./locales/ja/chat.json"
import jaCommonJson from "./locales/ja/common.json"
import jaDashboardJson from "./locales/ja/dashboard.json"
import jaHistoryJson from "./locales/ja/history.json"
import jaMarketplaceJson from "./locales/ja/marketplace.json"
import jaMcpJson from "./locales/ja/mcp.json"
import jaPromptsJson from "./locales/ja/prompts.json"
import jaSettingsJson from "./locales/ja/settings.json"
import jaStatsJson from "./locales/ja/stats.json"
import jaWelcomeJson from "./locales/ja/welcome.json"
import jaWorktreesJson from "./locales/ja/worktrees.json"
import koChatJson from "./locales/ko/chat.json"
import koCommonJson from "./locales/ko/common.json"
import koDashboardJson from "./locales/ko/dashboard.json"
import koHistoryJson from "./locales/ko/history.json"
import koMarketplaceJson from "./locales/ko/marketplace.json"
import koMcpJson from "./locales/ko/mcp.json"
import koPromptsJson from "./locales/ko/prompts.json"
import koSettingsJson from "./locales/ko/settings.json"
import koStatsJson from "./locales/ko/stats.json"
import koWelcomeJson from "./locales/ko/welcome.json"
import koWorktreesJson from "./locales/ko/worktrees.json"
import nlChatJson from "./locales/nl/chat.json"
import nlCommonJson from "./locales/nl/common.json"
import nlDashboardJson from "./locales/nl/dashboard.json"
import nlHistoryJson from "./locales/nl/history.json"
import nlMarketplaceJson from "./locales/nl/marketplace.json"
import nlMcpJson from "./locales/nl/mcp.json"
import nlPromptsJson from "./locales/nl/prompts.json"
import nlSettingsJson from "./locales/nl/settings.json"
import nlStatsJson from "./locales/nl/stats.json"
import nlWelcomeJson from "./locales/nl/welcome.json"
import nlWorktreesJson from "./locales/nl/worktrees.json"
import plChatJson from "./locales/pl/chat.json"
import plCommonJson from "./locales/pl/common.json"
import plDashboardJson from "./locales/pl/dashboard.json"
import plHistoryJson from "./locales/pl/history.json"
import plMarketplaceJson from "./locales/pl/marketplace.json"
import plMcpJson from "./locales/pl/mcp.json"
import plPromptsJson from "./locales/pl/prompts.json"
import plSettingsJson from "./locales/pl/settings.json"
import plStatsJson from "./locales/pl/stats.json"
import plWelcomeJson from "./locales/pl/welcome.json"
import plWorktreesJson from "./locales/pl/worktrees.json"
import ptBRChatJson from "./locales/pt-BR/chat.json"
import ptBRCommonJson from "./locales/pt-BR/common.json"
import ptBRDashboardJson from "./locales/pt-BR/dashboard.json"
import ptBRHistoryJson from "./locales/pt-BR/history.json"
import ptBRMarketplaceJson from "./locales/pt-BR/marketplace.json"
import ptBRMcpJson from "./locales/pt-BR/mcp.json"
import ptBRPromptsJson from "./locales/pt-BR/prompts.json"
import ptBRSettingsJson from "./locales/pt-BR/settings.json"
import ptBRStatsJson from "./locales/pt-BR/stats.json"
import ptBRWelcomeJson from "./locales/pt-BR/welcome.json"
import ptBRWorktreesJson from "./locales/pt-BR/worktrees.json"
import ruChatJson from "./locales/ru/chat.json"
import ruCommonJson from "./locales/ru/common.json"
import ruDashboardJson from "./locales/ru/dashboard.json"
import ruHistoryJson from "./locales/ru/history.json"
import ruMarketplaceJson from "./locales/ru/marketplace.json"
import ruMcpJson from "./locales/ru/mcp.json"
import ruPromptsJson from "./locales/ru/prompts.json"
import ruSettingsJson from "./locales/ru/settings.json"
import ruStatsJson from "./locales/ru/stats.json"
import ruWelcomeJson from "./locales/ru/welcome.json"
import ruWorktreesJson from "./locales/ru/worktrees.json"
import trChatJson from "./locales/tr/chat.json"
import trCommonJson from "./locales/tr/common.json"
import trDashboardJson from "./locales/tr/dashboard.json"
import trHistoryJson from "./locales/tr/history.json"
import trMarketplaceJson from "./locales/tr/marketplace.json"
import trMcpJson from "./locales/tr/mcp.json"
import trPromptsJson from "./locales/tr/prompts.json"
import trSettingsJson from "./locales/tr/settings.json"
import trStatsJson from "./locales/tr/stats.json"
import trWelcomeJson from "./locales/tr/welcome.json"
import trWorktreesJson from "./locales/tr/worktrees.json"
import viChatJson from "./locales/vi/chat.json"
import viCommonJson from "./locales/vi/common.json"
import viDashboardJson from "./locales/vi/dashboard.json"
import viHistoryJson from "./locales/vi/history.json"
import viMarketplaceJson from "./locales/vi/marketplace.json"
import viMcpJson from "./locales/vi/mcp.json"
import viPromptsJson from "./locales/vi/prompts.json"
import viSettingsJson from "./locales/vi/settings.json"
import viStatsJson from "./locales/vi/stats.json"
import viWelcomeJson from "./locales/vi/welcome.json"
import viWorktreesJson from "./locales/vi/worktrees.json"
import zhCNChatJson from "./locales/zh-CN/chat.json"
import zhCNCommonJson from "./locales/zh-CN/common.json"
import zhCNDashboardJson from "./locales/zh-CN/dashboard.json"
import zhCNHistoryJson from "./locales/zh-CN/history.json"
import zhCNMarketplaceJson from "./locales/zh-CN/marketplace.json"
import zhCNMcpJson from "./locales/zh-CN/mcp.json"
import zhCNPromptsJson from "./locales/zh-CN/prompts.json"
import zhCNSettingsJson from "./locales/zh-CN/settings.json"
import zhCNStatsJson from "./locales/zh-CN/stats.json"
import zhCNWelcomeJson from "./locales/zh-CN/welcome.json"
import zhCNWorktreesJson from "./locales/zh-CN/worktrees.json"
import zhTWChatJson from "./locales/zh-TW/chat.json"
import zhTWCommonJson from "./locales/zh-TW/common.json"
import zhTWDashboardJson from "./locales/zh-TW/dashboard.json"
import zhTWHistoryJson from "./locales/zh-TW/history.json"
import zhTWMarketplaceJson from "./locales/zh-TW/marketplace.json"
import zhTWMcpJson from "./locales/zh-TW/mcp.json"
import zhTWPromptsJson from "./locales/zh-TW/prompts.json"
import zhTWSettingsJson from "./locales/zh-TW/settings.json"
import zhTWStatsJson from "./locales/zh-TW/stats.json"
import zhTWWelcomeJson from "./locales/zh-TW/welcome.json"
import zhTWWorktreesJson from "./locales/zh-TW/worktrees.json"

type LocaleModule = Record<string, unknown>

// Build translations object
const translations: Record<string, Record<string, LocaleModule>> = {}

// Static mirror of `import.meta.glob("./locales/**/*.json", { eager: true })`.
const staticLocaleModules: Record<string, LocaleModule> = {
	"./locales/ca/chat.json": caChatJson,
	"./locales/ca/common.json": caCommonJson,
	"./locales/ca/dashboard.json": caDashboardJson,
	"./locales/ca/history.json": caHistoryJson,
	"./locales/ca/marketplace.json": caMarketplaceJson,
	"./locales/ca/mcp.json": caMcpJson,
	"./locales/ca/prompts.json": caPromptsJson,
	"./locales/ca/settings.json": caSettingsJson,
	"./locales/ca/stats.json": caStatsJson,
	"./locales/ca/welcome.json": caWelcomeJson,
	"./locales/ca/worktrees.json": caWorktreesJson,
	"./locales/de/chat.json": deChatJson,
	"./locales/de/common.json": deCommonJson,
	"./locales/de/dashboard.json": deDashboardJson,
	"./locales/de/history.json": deHistoryJson,
	"./locales/de/marketplace.json": deMarketplaceJson,
	"./locales/de/mcp.json": deMcpJson,
	"./locales/de/prompts.json": dePromptsJson,
	"./locales/de/settings.json": deSettingsJson,
	"./locales/de/stats.json": deStatsJson,
	"./locales/de/welcome.json": deWelcomeJson,
	"./locales/de/worktrees.json": deWorktreesJson,
	"./locales/en/chat.json": enChatJson,
	"./locales/en/common.json": enCommonJson,
	"./locales/en/dashboard.json": enDashboardJson,
	"./locales/en/history.json": enHistoryJson,
	"./locales/en/marketplace.json": enMarketplaceJson,
	"./locales/en/mcp.json": enMcpJson,
	"./locales/en/prompts.json": enPromptsJson,
	"./locales/en/settings.json": enSettingsJson,
	"./locales/en/stats.json": enStatsJson,
	"./locales/en/welcome.json": enWelcomeJson,
	"./locales/en/worktrees.json": enWorktreesJson,
	"./locales/es/chat.json": esChatJson,
	"./locales/es/common.json": esCommonJson,
	"./locales/es/dashboard.json": esDashboardJson,
	"./locales/es/history.json": esHistoryJson,
	"./locales/es/marketplace.json": esMarketplaceJson,
	"./locales/es/mcp.json": esMcpJson,
	"./locales/es/prompts.json": esPromptsJson,
	"./locales/es/settings.json": esSettingsJson,
	"./locales/es/stats.json": esStatsJson,
	"./locales/es/welcome.json": esWelcomeJson,
	"./locales/es/worktrees.json": esWorktreesJson,
	"./locales/fr/chat.json": frChatJson,
	"./locales/fr/common.json": frCommonJson,
	"./locales/fr/dashboard.json": frDashboardJson,
	"./locales/fr/history.json": frHistoryJson,
	"./locales/fr/marketplace.json": frMarketplaceJson,
	"./locales/fr/mcp.json": frMcpJson,
	"./locales/fr/prompts.json": frPromptsJson,
	"./locales/fr/settings.json": frSettingsJson,
	"./locales/fr/stats.json": frStatsJson,
	"./locales/fr/welcome.json": frWelcomeJson,
	"./locales/fr/worktrees.json": frWorktreesJson,
	"./locales/hi/chat.json": hiChatJson,
	"./locales/hi/common.json": hiCommonJson,
	"./locales/hi/dashboard.json": hiDashboardJson,
	"./locales/hi/history.json": hiHistoryJson,
	"./locales/hi/marketplace.json": hiMarketplaceJson,
	"./locales/hi/mcp.json": hiMcpJson,
	"./locales/hi/prompts.json": hiPromptsJson,
	"./locales/hi/settings.json": hiSettingsJson,
	"./locales/hi/stats.json": hiStatsJson,
	"./locales/hi/welcome.json": hiWelcomeJson,
	"./locales/hi/worktrees.json": hiWorktreesJson,
	"./locales/id/chat.json": idChatJson,
	"./locales/id/common.json": idCommonJson,
	"./locales/id/dashboard.json": idDashboardJson,
	"./locales/id/history.json": idHistoryJson,
	"./locales/id/marketplace.json": idMarketplaceJson,
	"./locales/id/mcp.json": idMcpJson,
	"./locales/id/prompts.json": idPromptsJson,
	"./locales/id/settings.json": idSettingsJson,
	"./locales/id/stats.json": idStatsJson,
	"./locales/id/welcome.json": idWelcomeJson,
	"./locales/id/worktrees.json": idWorktreesJson,
	"./locales/it/chat.json": itChatJson,
	"./locales/it/common.json": itCommonJson,
	"./locales/it/dashboard.json": itDashboardJson,
	"./locales/it/history.json": itHistoryJson,
	"./locales/it/marketplace.json": itMarketplaceJson,
	"./locales/it/mcp.json": itMcpJson,
	"./locales/it/prompts.json": itPromptsJson,
	"./locales/it/settings.json": itSettingsJson,
	"./locales/it/stats.json": itStatsJson,
	"./locales/it/welcome.json": itWelcomeJson,
	"./locales/it/worktrees.json": itWorktreesJson,
	"./locales/ja/chat.json": jaChatJson,
	"./locales/ja/common.json": jaCommonJson,
	"./locales/ja/dashboard.json": jaDashboardJson,
	"./locales/ja/history.json": jaHistoryJson,
	"./locales/ja/marketplace.json": jaMarketplaceJson,
	"./locales/ja/mcp.json": jaMcpJson,
	"./locales/ja/prompts.json": jaPromptsJson,
	"./locales/ja/settings.json": jaSettingsJson,
	"./locales/ja/stats.json": jaStatsJson,
	"./locales/ja/welcome.json": jaWelcomeJson,
	"./locales/ja/worktrees.json": jaWorktreesJson,
	"./locales/ko/chat.json": koChatJson,
	"./locales/ko/common.json": koCommonJson,
	"./locales/ko/dashboard.json": koDashboardJson,
	"./locales/ko/history.json": koHistoryJson,
	"./locales/ko/marketplace.json": koMarketplaceJson,
	"./locales/ko/mcp.json": koMcpJson,
	"./locales/ko/prompts.json": koPromptsJson,
	"./locales/ko/settings.json": koSettingsJson,
	"./locales/ko/stats.json": koStatsJson,
	"./locales/ko/welcome.json": koWelcomeJson,
	"./locales/ko/worktrees.json": koWorktreesJson,
	"./locales/nl/chat.json": nlChatJson,
	"./locales/nl/common.json": nlCommonJson,
	"./locales/nl/dashboard.json": nlDashboardJson,
	"./locales/nl/history.json": nlHistoryJson,
	"./locales/nl/marketplace.json": nlMarketplaceJson,
	"./locales/nl/mcp.json": nlMcpJson,
	"./locales/nl/prompts.json": nlPromptsJson,
	"./locales/nl/settings.json": nlSettingsJson,
	"./locales/nl/stats.json": nlStatsJson,
	"./locales/nl/welcome.json": nlWelcomeJson,
	"./locales/nl/worktrees.json": nlWorktreesJson,
	"./locales/pl/chat.json": plChatJson,
	"./locales/pl/common.json": plCommonJson,
	"./locales/pl/dashboard.json": plDashboardJson,
	"./locales/pl/history.json": plHistoryJson,
	"./locales/pl/marketplace.json": plMarketplaceJson,
	"./locales/pl/mcp.json": plMcpJson,
	"./locales/pl/prompts.json": plPromptsJson,
	"./locales/pl/settings.json": plSettingsJson,
	"./locales/pl/stats.json": plStatsJson,
	"./locales/pl/welcome.json": plWelcomeJson,
	"./locales/pl/worktrees.json": plWorktreesJson,
	"./locales/pt-BR/chat.json": ptBRChatJson,
	"./locales/pt-BR/common.json": ptBRCommonJson,
	"./locales/pt-BR/dashboard.json": ptBRDashboardJson,
	"./locales/pt-BR/history.json": ptBRHistoryJson,
	"./locales/pt-BR/marketplace.json": ptBRMarketplaceJson,
	"./locales/pt-BR/mcp.json": ptBRMcpJson,
	"./locales/pt-BR/prompts.json": ptBRPromptsJson,
	"./locales/pt-BR/settings.json": ptBRSettingsJson,
	"./locales/pt-BR/stats.json": ptBRStatsJson,
	"./locales/pt-BR/welcome.json": ptBRWelcomeJson,
	"./locales/pt-BR/worktrees.json": ptBRWorktreesJson,
	"./locales/ru/chat.json": ruChatJson,
	"./locales/ru/common.json": ruCommonJson,
	"./locales/ru/dashboard.json": ruDashboardJson,
	"./locales/ru/history.json": ruHistoryJson,
	"./locales/ru/marketplace.json": ruMarketplaceJson,
	"./locales/ru/mcp.json": ruMcpJson,
	"./locales/ru/prompts.json": ruPromptsJson,
	"./locales/ru/settings.json": ruSettingsJson,
	"./locales/ru/stats.json": ruStatsJson,
	"./locales/ru/welcome.json": ruWelcomeJson,
	"./locales/ru/worktrees.json": ruWorktreesJson,
	"./locales/tr/chat.json": trChatJson,
	"./locales/tr/common.json": trCommonJson,
	"./locales/tr/dashboard.json": trDashboardJson,
	"./locales/tr/history.json": trHistoryJson,
	"./locales/tr/marketplace.json": trMarketplaceJson,
	"./locales/tr/mcp.json": trMcpJson,
	"./locales/tr/prompts.json": trPromptsJson,
	"./locales/tr/settings.json": trSettingsJson,
	"./locales/tr/stats.json": trStatsJson,
	"./locales/tr/welcome.json": trWelcomeJson,
	"./locales/tr/worktrees.json": trWorktreesJson,
	"./locales/vi/chat.json": viChatJson,
	"./locales/vi/common.json": viCommonJson,
	"./locales/vi/dashboard.json": viDashboardJson,
	"./locales/vi/history.json": viHistoryJson,
	"./locales/vi/marketplace.json": viMarketplaceJson,
	"./locales/vi/mcp.json": viMcpJson,
	"./locales/vi/prompts.json": viPromptsJson,
	"./locales/vi/settings.json": viSettingsJson,
	"./locales/vi/stats.json": viStatsJson,
	"./locales/vi/welcome.json": viWelcomeJson,
	"./locales/vi/worktrees.json": viWorktreesJson,
	"./locales/zh-CN/chat.json": zhCNChatJson,
	"./locales/zh-CN/common.json": zhCNCommonJson,
	"./locales/zh-CN/dashboard.json": zhCNDashboardJson,
	"./locales/zh-CN/history.json": zhCNHistoryJson,
	"./locales/zh-CN/marketplace.json": zhCNMarketplaceJson,
	"./locales/zh-CN/mcp.json": zhCNMcpJson,
	"./locales/zh-CN/prompts.json": zhCNPromptsJson,
	"./locales/zh-CN/settings.json": zhCNSettingsJson,
	"./locales/zh-CN/stats.json": zhCNStatsJson,
	"./locales/zh-CN/welcome.json": zhCNWelcomeJson,
	"./locales/zh-CN/worktrees.json": zhCNWorktreesJson,
	"./locales/zh-TW/chat.json": zhTWChatJson,
	"./locales/zh-TW/common.json": zhTWCommonJson,
	"./locales/zh-TW/dashboard.json": zhTWDashboardJson,
	"./locales/zh-TW/history.json": zhTWHistoryJson,
	"./locales/zh-TW/marketplace.json": zhTWMarketplaceJson,
	"./locales/zh-TW/mcp.json": zhTWMcpJson,
	"./locales/zh-TW/prompts.json": zhTWPromptsJson,
	"./locales/zh-TW/settings.json": zhTWSettingsJson,
	"./locales/zh-TW/stats.json": zhTWStatsJson,
	"./locales/zh-TW/welcome.json": zhTWWelcomeJson,
	"./locales/zh-TW/worktrees.json": zhTWWorktreesJson,
}

// Normalize a locale module: both the Vite eager-glob result and static JSON
// imports may surface the parsed object directly or under `default` depending
// on interop mode. No locale JSON file has a top-level "default" key, so
// preferring `default` when present is safe.
function toLocaleModule(module: unknown): LocaleModule {
	if (typeof module !== "object" || module === null) {
		return {}
	}
	const parsed = module as LocaleModule
	const nested = parsed["default"]
	if (typeof nested === "object" && nested !== null) {
		return nested as LocaleModule
	}
	return parsed
}

// Vite compiles `import.meta.glob` at build time, so the call below must stay
// a literal member-expression call (it is never executed when Vite rewrites
// it). The `typeof` guard only decides which fully-populated source to use at
// runtime under non-Vite transforms (Playwright CT/Node), where it falls back
// to the static import map above covering the same files.
const localeFiles: Record<string, unknown> =
	typeof (import.meta as { glob?: unknown }).glob === "function"
		? import.meta.glob("./locales/**/*.json", { eager: true })
		: staticLocaleModules

// Process all locale files
Object.entries(localeFiles).forEach(([path, module]) => {
	// Extract language and namespace from path
	// Example path: './locales/en/common.json' -> language: 'en', namespace: 'common'
	const match = path.match(/\.\/locales\/([^/]+)\/([^/]+)\.json/)

	if (match) {
		const [, language, namespace] = match

		// Initialize language object if it doesn't exist
		if (!translations[language]) {
			translations[language] = {}
		}

		// Add namespace resources to language
		translations[language][namespace] = toLocaleModule(module)
	}
})

console.log("Dynamically loaded translations:", Object.keys(translations))

// Initialize i18next for React
// This will be initialized with the VSCode language in TranslationProvider
i18next.use(initReactI18next).init({
	lng: "en", // Default language (will be overridden)
	fallbackLng: "en",
	debug: false,
	interpolation: {
		escapeValue: false, // React already escapes by default
	},
})

export function loadTranslations() {
	Object.entries(translations).forEach(([lang, namespaces]) => {
		try {
			Object.entries(namespaces).forEach(([namespace, resources]) => {
				i18next.addResourceBundle(lang, namespace, resources, true, true)
			})
		} catch (error) {
			console.warn(`Could not load ${lang} translations:`, error)
		}
	})
}

export default i18next
