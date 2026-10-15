"""Regenerate the owned PDF/DOCX fixtures using only Python's standard library."""

import argparse
import hashlib
import io
from pathlib import Path
import zipfile


def generate_pdf() -> bytes:
    stream = (
        b"BT\n/F1 12 Tf\n72 720 Td\n"
        b"(Approved PDF first line) Tj\n0 -18 Td\n"
        b"(Approved PDF second line) Tj\nET\n"
    )
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"endstream",
    ]
    document = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, content in enumerate(objects, 1):
        offsets.append(len(document))
        document += b"%d 0 obj\n" % number + content + b"\nendobj\n"

    xref_offset = len(document)
    document += b"xref\n0 6\n0000000000 65535 f \n"
    for offset in offsets:
        document += b"%010d 00000 n \n" % offset
    document += (
        b"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"
        % xref_offset
    )
    return bytes(document)


def generate_docx() -> bytes:
    header = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    parts = [
        (
            "[Content_Types].xml",
            header
            + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
            '<Default Extension="xml" ContentType="application/xml"/>\n'
            '<Override PartName="/word/document.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>\n'
            '</Types>',
        ),
        (
            "_rels/.rels",
            header
            + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
            '<Relationship Id="rId1" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
            'Target="word/document.xml"/>\n'
            '</Relationships>',
        ),
        (
            "word/document.xml",
            header
            + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">\n'
            '<w:body>\n'
            '<w:p><w:r><w:t>Approved DOCX first paragraph</w:t></w:r></w:p>\n'
            '<w:p><w:r><w:t xml:space="preserve">Approved DOCX second &amp; </w:t></w:r>'
            '<w:r><w:t>final paragraph</w:t></w:r></w:p>\n'
            '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>\n'
            '</w:body>\n</w:document>',
        ),
    ]

    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for name, content in parts:
            entry = zipfile.ZipInfo(name, (2020, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, content.encode("utf-8"), compresslevel=6)
    return output.getvalue()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "output_directory",
        nargs="?",
        type=Path,
        default=Path(__file__).resolve().parent,
        help="destination directory (defaults to this script's directory)",
    )
    output_directory = parser.parse_args().output_directory
    output_directory.mkdir(parents=True, exist_ok=True)

    for name, content in (
        ("approved.pdf", generate_pdf()),
        ("approved.docx", generate_docx()),
    ):
        (output_directory / name).write_bytes(content)
        print(f"{hashlib.sha256(content).hexdigest()}  {name}")


if __name__ == "__main__":
    main()
