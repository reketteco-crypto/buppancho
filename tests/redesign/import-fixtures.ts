import { zipSync, strToU8 } from "fflate";

export function workbookFixture(name: string, rows: string[][]) {
  const escape = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  const column = (index: number) => {
    let result = "";
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
      result = String.fromCharCode(65 + ((n - 1) % 26)) + result;
    return result;
  };
  return Buffer.from(
    zipSync({
      "xl/workbook.xml": strToU8(
        `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escape(name)}" r:id="rId1"/></sheets></workbook>`,
      ),
      "xl/_rels/workbook.xml.rels": strToU8(
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      "xl/worksheets/sheet1.xml": strToU8(
        `<worksheet><sheetData>${rows.map((row, i) => `<row r="${i + 1}">${row.map((value, j) => `<c r="${column(j)}${i + 1}" t="inlineStr"><is><t>${escape(value)}</t></is></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`,
      ),
    }),
  );
}

/** Minimal text PDF with an explicit Unicode map; no real invoice or personal data. */
export function invoicePdfFixture() {
  const text = "関税 1,002円";
  const encoded = Array.from(text, (_, i) => (i + 1).toString(16).padStart(4, "0")).join("");
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /TestMap def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange ${text.length} beginbfchar ${Array.from(text, (ch, i) => `<${(i + 1).toString(16).padStart(4, "0")}> <${ch.charCodeAt(0).toString(16).padStart(4, "0")}>`).join("\n")} endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
  const content = `BT /F1 12 Tf 50 780 Td <${encoded}> Tj ET`;
  const stream = (s: string) => `<< /Length ${Buffer.byteLength(s)} >>\nstream\n${s}\nendstream`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 840] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiMin-W3 /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 7 0 R >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiMin-W3 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 0 >> >>",
    stream(content),
    stream(cmap),
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, obj] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((o) => `${o.toString().padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
