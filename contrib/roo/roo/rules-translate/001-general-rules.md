# 1. SUPPORTED LANGUAGES AND LOCATION

- Localize all strings into the following locale files: ca, de, en, es, fr, hi, id, it, ja, ko, nl, pl, pt-BR, ru, tr, vi, zh-CN, zh-TW
- The VSCode extension has two main areas that require localization:
    - Core Extension: src/i18n/locales/ (extension backend)
    - WebView UI: webview-ui/src/i18n/locales/ (user interface)

# 2. VOICE, STYLE AND TONE

- Always use informal speech (e.g., "du" instead of "Sie" in German) for all translations
- Maintain a direct and concise style that mirrors the tone of the original text
- Carefully account for colloquialisms and idiomatic expressions in both source and target languages
- Aim for culturally relevant and meaningful translations rather than literal translations
- Preserve the personality and voice of the original content
- Use natural-sounding language that feels native to speakers of the target language
- Don't translate the word "token" as it means something specific in English that all languages will understand
- Don't translate domain-specific words (especially technical terms like "Prompt") that are commonly used in English in the target language

# 3. CORE EXTENSION LOCALIZATION (src/)

- Located in src/i18n/locales/
- NOT ALL strings in core source need internationalization - only user-facing messages
- Internal error messages, debugging logs, and developer-facing messages should remain in English
- The t() function is used with namespaces like 'core:errors.missingToolParameter'
- Be careful when modifying interpolation variables; they must remain consistent across all translations
- Some strings in formatResponse.ts are intentionally not internationalized since they're internal
- When updating strings in core.json, maintain all existing interpolation variables
- Check string usages in the codebase before making changes to ensure you're not breaking functionality

# 4. WEBVIEW UI LOCALIZATION (webview-ui/src/)

- Located in webview-ui/src/i18n/locales/
- Use `useAppTranslation` from `@src/i18n/TranslationContext`, not react-i18next's `useTranslation` (ESLint enforces this). It returns `{ t, language }`; switching languages belongs to the provider, so the i18next instance is not exposed:
    - Always write fully qualified keys (`t("chat:about")`)
    - Always pass that `t` to `Trans` (`<Trans t={t} i18nKey="..." />`); `Trans` does not follow language changes on its own (ESLint enforces this)
    - Never use the global `t` from `i18next` (`i18next.t`); memoized output would keep showing the previous language after a switch (ESLint enforces this). Pass `t` (and `language` for dates) to helpers instead, as `utils/format.ts` and `utils/validate.ts` do
- All user interface strings should be internationalized
- Always use the Trans component with named components for text with embedded components

<Trans> example:

`"changeSettings": "You can always change this at the bottom of the <settingsLink>settings</settingsLink>",`

```
  <Trans
    t={t}
    i18nKey="welcome:telemetry.changeSettings"
    components={{
      settingsLink: <VSCodeLink href="#" onClick={handleOpenSettings} />
    }}
  />
```

# 5. TECHNICAL IMPLEMENTATION

- Use namespaces to organize translations logically
- Handle pluralization with i18next plural keys that follow CLDR rules (see section 6)
- Implement proper interpolation for variables using {{variable}} syntax
- Don't include defaultValue. The `en` translations are the fallback
- Always use apply_diff instead of write_to_file when editing existing translation files (much faster and more reliable)
- When using apply_diff, carefully identify the exact JSON structure to edit to avoid syntax errors
- Placeholders (like {{variable}}) must remain exactly identical to the English source to maintain code integration and prevent syntax errors

# 6. PLURALIZATION (CLDR)

i18next v25 picks a plural form with `Intl.PluralRules`, which implements the [CLDR plural rules](https://www.unicode.org/cldr/charts/latest/supplemental/language_plural_rules.html). Any string that counts something must use plural keys.

- Never fake plurals with "(s)", "файл(ов)", "richiesta/e" or similar. Split the string into plural forms instead.
- Pass the number as `count`: `t("ns:key", { count: n })`. With `<Trans>`, pass `count={n}` or `values={{ count: n }}`.
- Name the keys `key_one`, `key_few`, `key_many`, `key_other` (plus an optional `key_zero`). Do not keep a bare `key` next to them: i18next uses it in place of any missing form, which hides the gap.
- Each locale must have exactly its CLDR forms. When a form is missing, i18next falls back to the bare key and then to English. Extra forms are never shown:

| Locales                      | Forms                         | What the forms cover                                                                                          |
| ---------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| en, de, nl, tr               | `one`, `other`                | `one` = 1                                                                                                     |
| hi                           | `one`, `other`                | `one` = 0, 1                                                                                                  |
| fr, pt-BR                    | `one`, `many`, `other`        | `one` = 0, 1; `many` = exact millions (1000000)                                                               |
| ca, es, it                   | `one`, `many`, `other`        | `one` = 1; `many` = exact millions (1000000)                                                                  |
| ru                           | `one`, `few`, `many`, `other` | `one` = 1, 21, 31, 101 (not 11); `few` = 2–4, 22–24 (not 12–14); `many` = 0, 5–20, 25–30; `other` = fractions |
| pl                           | `one`, `few`, `many`, `other` | `one` = 1 only; `few` = 2–4, 22–24 (not 12–14); `many` = 0, 5–21, 25–31; `other` = fractions                  |
| id, ja, ko, vi, zh-CN, zh-TW | `other`                       | No `_one`: these languages do not inflect for number                                                          |

- Every form, including `_one`, must contain `{{count}}`. Do not hardcode "1": `_one` also covers 21 in ru and 0 in fr, pt-BR and hi.
- `_many` in ca, es, fr, it and pt-BR only applies to exact millions printed as digits. Copy the `_other` text.
- `_other` in ru and pl only applies to fractions (1.5). Use the genitive singular: ru "1,5 минуты" (same as `_few`), pl "1,5 minuty", "1,5 wyniku".
- The form depends on the whole phrase, not just the noun. Check the case the preposition or verb requires:
    - ru "удалить {{count}} задачу / задачи / задач"
    - ru "до {{count}} запроса / запросов / запросов"
    - pl negation "nie udało się odłączyć {{count}} serwera / serwerów / serwerów"
- If another number governs the noun (e.g. "{{count}} of {{total}}"), rephrase so the noun no longer depends on a number: "Импортировано историй задач: {{count}} из {{total}}".
- `_zero` is an i18next override for count 0 in every language. Add it in every locale when the English key has it. In ru and pl, 0 otherwise uses `_many`.
- Do not pluralize money amounts, unit abbreviations ("{{count}}s"), numbers that JavaScript updates live in the DOM, or phrases with no counted noun ("and {{count}} more").

Example:

```jsonc
// en
"subtasks_one": "{{count}} subtask",
"subtasks_other": "{{count}} subtasks",

// ru
"subtasks_one": "{{count}} подзадача",
"subtasks_few": "{{count}} подзадачи",
"subtasks_many": "{{count}} подзадач",
"subtasks_other": "{{count}} подзадачи",

// ja
"subtasks_other": "{{count}} サブタスク",
```

To list the plural forms of any locale, run: `node -p 'new Intl.PluralRules("<locale>").resolvedOptions().pluralCategories'`

`node scripts/find-missing-translations.js` reports a plural key only when a locale has no key with its base name (`key` or `key_*`). `node scripts/validate-plural-forms.js` reports missing forms, forms without `{{count}}`, extra forms, bare keys next to plural forms and plural mistakes in English.

# 7. WORKFLOW AND APPROACH

- First add or modify English strings, then ask for confirmation before translating to all other languages
- Use this process for each localization task:
    1. Identify where the string appears in the UI/codebase
    2. Understand the context and purpose of the string
    3. Update English translation first
    4. Use the `<search_files>` tool to find JSON keys that are near new keys in English translations but do not yet exist in the other language files for `<apply_diff>` SEARCH context
    5. Create appropriate translations for all other supported languages utilizing the `search_files` result using `<apply_diff>` without reading every file.
    6. Do not output the translated text into the chat, just modify the files.
    7. Validate your changes with the missing translations script
- Flag or comment if an English source string is incomplete ("please see this...") to avoid truncated or unclear translations
- For UI elements, distinguish between:
    - Button labels: Use short imperative commands ("Save", "Cancel")
    - Tooltip text: Can be slightly more descriptive
- Preserve the original perspective: If text is a user command directed at the software, ensure the translation maintains this direction, avoiding language that makes it sound like an instruction from the system to the user

# 8. COMMON PITFALLS TO AVOID

- Switching between formal and informal addressing styles - always stay informal ("du" not "Sie")
- Translating or altering technical terms and brand names that should remain in English
- Modifying or removing placeholders like {{variable}} - these must remain identical
- Translating domain-specific terms that are commonly used in English in the target language
- Changing the meaning or nuance of instructions or error messages
- Forgetting to maintain consistent terminology throughout the translation
- Copying the English `_one`/`_other` pair into a locale with different plural forms, or writing "(s)"-style plurals

# 9. QUALITY ASSURANCE

- Maintain consistent terminology across all translations
- Respect the JSON structure of translation files
- Watch for placeholders and preserve them in translations
- Be mindful of text length in UI elements when translating to languages that might require more characters
- Use context-aware translations when the same string has different meanings
- Always validate your translation work by running the missing translations script:
    ```
    node scripts/find-missing-translations.js
    ```
- Address any missing translations identified by the script to ensure complete coverage across all locales
- When you add or change plural keys, also run the plural forms script and fix every problem it reports:
    ```
    node scripts/validate-plural-forms.js
    ```

# 10. TRANSLATOR'S CHECKLIST

- ✓ Used informal tone consistently ("du" not "Sie")
- ✓ Preserved all placeholders exactly as in the English source
- ✓ Gave each plural key exactly the locale's CLDR forms, each containing `{{count}}`
- ✓ Maintained consistent terminology with existing translations
- ✓ Kept technical terms and brand names unchanged where appropriate
- ✓ Preserved the original perspective (user→system vs system→user)
- ✓ Adapted the text appropriately for UI context (buttons vs tooltips)
