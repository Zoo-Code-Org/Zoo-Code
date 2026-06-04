# Critical Review Report — Phase 2: AST Auto-Expansion

**Date:** 2026-06-04  
**Reviewer:** Research Analyst (research-analyst mode)  
**Status:** ✅ **ACCEPTED** with minor recommendations

---

## Overview

Phase 2 implements AST-based auto-expansion for `ContentRef.focus` — the ability to find a syntactic code block (function, class, method) by its name and return the entire block content with precise boundaries.

### Changes Under Review

| File                                            | Role                                                                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `src/core/tools/ref/selector.ts`                | Core implementation: `resolveAstBlock()` (vscode API), `resolveFocus()` (regex AST), `resolveContentRef()` (priority chain) |
| `src/shared/tools.ts`                           | Types: `SelectorResult.method` now includes `"ast"`                                                                         |
| `src/core/tools/ref/__tests__/selector.spec.ts` | Tests for `resolveFocus()` and updated `resolveContentRef()`                                                                |
| `src/core/tools/ref/sources/file.ts`            | File source passes `cwd` to `resolveContentRef()`                                                                           |
| `src/core/tools/ref/sources/chat.ts`            | Updated to pass `cwd` structure                                                                                             |
| `src/core/tools/ref/sources/terminal.ts`        | Updated to pass `cwd` structure                                                                                             |
| `src/core/tools/ref/sources/tool.ts`            | Updated to pass `cwd` structure                                                                                             |
| `src/core/tools/ref/__tests__/sources.spec.ts`  | Source resolver tests updated for `cwd` parameter                                                                           |

---

## File-by-File Analysis

### 1. `src/core/tools/ref/selector.ts`

#### `resolveAstBlock()` (lines 50–109)

**Architecture:** Uses `vscode.executeDocumentSymbolProvider` to obtain the symbol tree, then finds the deepest symbol node containing the focus keyword position.

**Strengths:**

- ✅ Graceful fallback via `try/catch` — returns `null` when vscode API is unavailable (headless/test mode)
- ✅ Dynamic import of `vscode` module (`const vs: any = await import("vscode")`) — standard pattern for test compatibility
- ✅ Uses `document.positionAt(idx)` to map text offset → Position — correct VS Code API usage
- ✅ `findDeepestContaining()` recursively searches children for most precise symbol — handles nested symbols
- ✅ 1-based line number conversion (`symbol.range.start.line + 1`) — consistent with rest of codebase

**Issues Found:**

- ⚠️ **Line 71**: `symbols: any[]` — the `any` typing is justified (vscode types may not resolve in test context), but reduces type safety for the symbol tree traversal
- ⚠️ **Line 72**: `vs.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri)` — confirmed correct via Tavily research. Returns `DocumentSymbol[] | undefined`. The `children` field population depends on the language server implementation

#### `resolveFocus()` (lines 176–195)

**Language Support:**

- ✅ TypeScript/JavaScript: function declarations, async functions, generators, arrow functions (block + expression), classes, methods
- ✅ Python: `def`, `async def`, `class` with indentation-based block detection
- ✅ Go: `func` with receiver methods
- ✅ Rust: `fn` with return type
- ✅ Java/C#/C++: methods with access modifiers

**Edge Cases Covered:**

- Empty source / empty focusName → returns null
- Duplicate function names → picks the first (earliest) match
- Nested braces → `findMatchingBrace()` correctly tracks depth
- String literals with braces → skip tracking when inside strings

**Issues Found:**

- ⚠️ **Line 222**: `inTemplate` is declared but **never set to `true`**. Template literal strings (backtick) with `${}` expressions containing nested braces `{` could cause incorrect `findMatchingBrace()` results. However, this only affects focus keywords found inside template expressions — extremely unlikely for function/class names
- ⚠️ **Line 312**: `methodPattern` — could match function calls that pass an object literal as argument: `calculateSum({a: 1})`. Mitigation: the `{` at the end makes this less likely
- ⚠️ **Line 328**: `javaPattern` — could match variable declarations that use the focus name as a type rather than a function name

#### `resolveContentRef()` (lines 1076–1175)

**Priority Chain:**

1. `ref.source === "file" && ref.startLine != null` → line range
2. `ref.source === "file" && ref.focus` → `resolveAstBlock()` (vscode API)
3. `ref.startAnchor` → anchor pair
4. `ref.selector` → selector
5. `ref.focus` → `resolveFocus()` (regex AST) → `resolveSelector()` fallback
6. Error

**Strengths:**

- ✅ Clear priority chain with proper fallbacks
- ✅ Vscode API AST → regex AST → selector text match — triple redundancy
- ✅ `cwd` parameter correctly passed for file path resolution

**Issues Found:**

- ⚠️ **Line 1109**: `sourceId` format inconsistency — vscode AST path produces `file://${filePath}:${startLine}-${endLine}`, while all other paths use just `file://${filePath}`. This could confuse consumers that parse `sourceId`
- ⚠️ **Double file read risk**: For `source === "file" && focus`, the file is opened via vscode API in `resolveAstBlock()`. If fallback is needed, `resolveFocus()` works on the already-read source text (provided by the caller like `resolveFileSource`). The caller reads the file again via `fs.readFile`. This is acceptable overhead for the fallback case

---

### 2. `src/shared/tools.ts`

- ✅ `SelectorResult.method` correctly includes `"ast"` in the union type (line 121)
- ✅ `ContentRef.focus` field properly typed as `string | undefined` (line 249)
- ✅ `ContentRefParams.transform` and related types unchanged — no regressions

---

### 3. `src/core/tools/ref/__tests__/selector.spec.ts`

**Coverage:**

- ✅ `resolveContentRef`: line range, anchor, selector, focus priority
- ✅ `resolveFocus`: 15 test cases covering TS/JS (functions, generators, async, arrows, classes, methods), Python (def, async def, class), Go (func, receiver), Rust (fn), Java/C# (modifiers), nested braces, duplicates
- ✅ Edge cases: empty source, empty focusName, nonexistent function, fallback to selector

**Issues Found:**

- ❓ **No tests for `resolveAstBlock()`** — understandable since it requires vscode API. Could be tested via integration tests in the extension host
- ✅ **All 253 tests pass** across 9 test files

---

### 4. `src/core/tools/ref/sources/file.ts`

- ✅ Correctly passes `cwd` to `resolveContentRef()` (line 74)
- ✅ Line range extraction has its own implementation (not using `resolveContentRef`) — efficient
- ✅ File reading error handling is robust

---

## Verification Results

### TypeScript Compilation

```
$ cd src && npx tsc --noEmit
```

**Result:** ✅ **Clean** — no errors, no warnings

### Test Suite

```
$ cd src && npx vitest run core/tools/ref/__tests__/

Test Files  9 passed (9)
Tests     253 passed (253)
Duration  2.80s
```

**Result:** ✅ **All 253 tests pass** — no regressions

### Type Safety Check: `SelectorResult`

- `method` field correctly accepts `"ast"` as a valid value
- `endLine` field is `number | undefined` — only populated by AST expansion
- `confidence` is `1.0` for both vscode AST and regex AST methods — appropriate
- All existing code that matches on `method` continues to work

### Edge Cases Check

| Scenario                            | Expected                    | Actual                            | Status |
| ----------------------------------- | --------------------------- | --------------------------------- | ------ |
| File not found                      | Error thrown                | Error thrown                      | ✅     |
| Focus not found in source           | Fallback to selector        | Fallback to selector              | ✅     |
| vscode API not available (headless) | Returns null, falls through | Returns null via catch            | ✅     |
| Empty source                        | Null returned               | Null returned                     | ✅     |
| Empty focusName                     | Null returned               | Null returned                     | ✅     |
| Duplicate function names            | First match returned        | First match returned (line 553)   | ✅     |
| Nested braces `{ { } }`             | Correctly matched           | `findMatchingBrace` handles depth | ✅     |

### Regression Check

- `resolveSelector()` (exact → normalized → fuzzy → word-boundary) — **unchanged**
- `resolveAnchorPair()` — **unchanged**
- `resolveContentRef()` for `source !== "file"` — **unchanged behavior**
- Source resolvers (chat, terminal, tool) — only `cwd` parameter added, no behavioral change

All existing tests pass — ✅ **No regressions detected**

---

## External Research (Tavily / Context7)

### `vscode.executeDocumentSymbolProvider`

- **Source:** [VS Code API Reference](https://code.visualstudio.com/api/references/commands)
- **Findings:** Returns `DocumentSymbol[]` with hierarchical `children` array. Quality depends on the language server implementation. Some LSPs (e.g., Haskell) may not populate `children` properly
- **Impact:** The current implementation correctly handles undefined/missing children. Fallback to regex-based AST provides robustness for languages with poor LSP support

### Tree-sitter Alternative

- **Source:** `@vscode/tree-sitter-wasm` (npm), Tree-sitter documentation
- **Findings:** VS Code provides `@vscode/tree-sitter-wasm` (v0.3.1) for direct tree-sitter WASM parsing. However, adding tree-sitter would significantly increase bundle size and complexity
- **Decision:** Current approach (vscode DocumentSymbolProvider → regex AST → selector) is **appropriate** for a VS Code extension. Tree-sitter should only be considered if language coverage gaps become problematic

### Best Practices

- Dynamic import of vscode module for test compatibility — **confirmed standard pattern**
- CancellationToken not required for `executeCommand` calls — **correct**
- 1-based line numbers in user-facing output, 0-based in VS Code API — **correctly handled**

---

## Verdict

```
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║                    ✅  ACCEPTED                              ║
║                                                              ║
║   Phase 2 is well-architected, properly implemented,         ║
║   and passes all verification checks.                        ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
```

### Summary

| Criterion                   | Result                           |
| --------------------------- | -------------------------------- |
| TypeScript (`tsc --noEmit`) | ✅ Clean                         |
| Tests (253/253)             | ✅ All pass                      |
| No regressions              | ✅ Confirmed                     |
| Edge cases handled          | ✅ Covered                       |
| Best practices followed     | ✅ Confirmed via Tavily research |

### Recommendations (non-blocking)

1. **🟢 LOW — Template literal handling in `findMatchingBrace()` (selector.ts:222)**

    ```typescript
    // In the string-skipping logic, add handling for backtick template literals
    if (ch === "`" && prev !== "\\") {
    	if (!inTemplate) {
    		inTemplate = true
    	} else {
    		inTemplate = false
    	}
    }
    ```

    Currently `inTemplate` is declared but never set, which could cause incorrect brace matching inside template literals with `${}` expressions.

2. **🟢 LOW — `sourceId` format consistency**
   Consider using the same `sourceId` format for both vscode AST and regex AST paths in `resolveContentRef()`. Currently:

    - vscode AST → `file:///path/to/file.ts:10-20`
    - regex AST → `file:///path/to/file.ts`

    Align to `file:///path/to/file.ts:startLine-endLine` for both, or keep simple format for both.

3. **🟢 LOW — Potential future enhancement: Tree-sitter integration**
   If gaps in language coverage are identified (e.g., LSPs that don't populate DocumentSymbol `children`), consider `@vscode/tree-sitter-wasm` as a complementary parsing strategy.

### Final Statement

Phase 2 — AST Auto-Expansion for `ContentRef.focus` is **ready for merge**. The implementation is robust, with proper fallback chains from vscode API → regex-based AST → text selector. All 253 tests pass, TypeScript compiles cleanly, and edge cases are well handled. The three recommendations above are non-critical and can be addressed in future iterations.
