# Document extraction fixtures

These small, owned documents exercise the real parsers through the buffer-only extraction API. They contain no external resources and require no additional dependencies.

- [approved.pdf](approved.pdf) is a one-page PDF 1.4 containing two Helvetica text lines: “Approved PDF first line” and “Approved PDF second line”. It was generated using Python's standard library with five objects (Catalog, Pages, Page, Font, Contents), byte-accurate stream length, cross-reference offsets, and trailer. The default PDF parser prefixes the page text with two newlines; the integration test preserves that historical numbering.
- [approved.docx](approved.docx) is a minimal OOXML document generated using Python's standard-library ZIP writer, fixed entry timestamps, and DEFLATE compression. It includes the content-type declarations, root office-document relationship, and main document part. Its two paragraphs read “Approved DOCX first paragraph” and “Approved DOCX second & final paragraph”; the second combines two runs and an escaped XML entity. Mammoth separates paragraphs with two newlines.

The integration suite deliberately does not mock either document parser. It reads each fixture before guarding against pathname I/O, then passes a different, metadata-only pathname to the extraction API and asserts the full numbered output.

## Regeneration and integrity

[`generate-fixtures.py`](generate-fixtures.py) contains the complete document sources and prints each generated file's SHA-256 hash. Run it from the repository root:

```sh
python3 src/integrations/misc/__tests__/fixtures/generate-fixtures.py
```

Without an argument it writes beside the script, regardless of the current working directory. Supply an output directory as the optional argument to regenerate elsewhere for comparison. The generator uses only Python 3's standard library; it is not invoked by the test suite, so running tests does not require Python.

PDF object order and offsets, DOCX entry order, ZIP timestamps, Unix file permissions, and DEFLATE level 6 are fixed. The committed files have these sizes and SHA-256 hashes:

| Fixture                        | Bytes | SHA-256                                                            |
| ------------------------------ | ----: | ------------------------------------------------------------------ |
| [approved.pdf](approved.pdf)   |   643 | `11b19aed8bc2e40b9eda9d18b7bfe36e0bbc41c4383d7e30141927992790f411` |
| [approved.docx](approved.docx) |  1002 | `732d827ad38ff51c24983c773bcb964ba53ca29bb055ea73aa9fbed820ae3a9b` |

The integration suite checks these hashes as well as the real parsers' extracted text. If a fixture is intentionally changed, update its generator source, the documented hash, and the corresponding test expectations together.
