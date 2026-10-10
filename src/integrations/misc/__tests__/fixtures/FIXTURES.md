# Document extraction fixtures

These small, owned documents exercise the real parsers through the buffer-only extraction API. They contain no external resources and require no additional dependencies.

- [approved.pdf](approved.pdf) is a one-page PDF 1.4 containing two Helvetica text lines: “Approved PDF first line” and “Approved PDF second line”. It was generated using Python's standard library with five objects (Catalog, Pages, Page, Font, Contents), byte-accurate stream length, cross-reference offsets, and trailer. The default PDF parser prefixes the page text with two newlines; the integration test preserves that historical numbering.
- [approved.docx](approved.docx) is a minimal OOXML document generated using Python's standard-library ZIP writer, fixed entry timestamps, and DEFLATE compression. It includes the content-type declarations, root office-document relationship, and main document part. Its two paragraphs read “Approved DOCX first paragraph” and “Approved DOCX second & final paragraph”; the second combines two runs and an escaped XML entity. Mammoth separates paragraphs with two newlines.

The integration suite deliberately does not mock either document parser. It reads each fixture before guarding against pathname I/O, then passes a different, metadata-only pathname to the extraction API and asserts the full numbered output.
