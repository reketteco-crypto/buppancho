import { unzipSync, strFromU8 } from "fflate";
import { type ImportCandidate, type Sheet } from "./candidate";
import { tabularCandidate, invoiceCandidate } from "./tabular";
function xml(text: string) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("Excelの内容を読み取れませんでした。");
  return doc;
}
function xlsx(data: Uint8Array): Sheet[] {
  let size = 0;
  const files = unzipSync(data, {
    filter: (file) => {
      size += file.originalSize;
      if (size > 60_000_000 || file.originalSize > 20_000_000)
        throw new Error("ファイルが大きすぎます。");
      return /^(xl\/(worksheets\/sheet\d+\.xml|sharedStrings\.xml|workbook\.xml|_rels\/workbook\.xml\.rels))$/.test(
        file.name,
      );
    },
  });
  const read = (path: string) => (files[path] ? xml(strFromU8(files[path]!)) : undefined);
  const strings = [...(read("xl/sharedStrings.xml")?.querySelectorAll("si") || [])].map((si) =>
    [...si.querySelectorAll("t")].map((n) => n.textContent || "").join(""),
  );
  const names = new Map(
    [...(read("xl/workbook.xml")?.querySelectorAll("sheet") || [])].map((s) => [
      s.getAttribute("r:id"),
      s.getAttribute("name") || "",
    ]),
  );
  const relations = new Map(
    [...(read("xl/_rels/workbook.xml.rels")?.querySelectorAll("Relationship") || [])].map((r) => [
      r.getAttribute("Target")?.replace(/^\/xl\//, ""),
      names.get(r.getAttribute("Id")),
    ]),
  );
  return Object.keys(files)
    .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))
    .map((path) => ({
      name: relations.get(path.slice(3)) || path,
      rows: [...read(path)!.querySelectorAll("sheetData row")].map((r) => {
        const row: string[] = [];
        for (const c of r.querySelectorAll("c")) {
          const column = (c.getAttribute("r") || "").replace(/\d/g, "");
          let index = 0;
          for (const ch of column) index = index * 26 + ch.charCodeAt(0) - 64;
          const v = c.querySelector("v")?.textContent || "";
          row[index - 1] =
            c.getAttribute("t") === "s"
              ? strings[Number(v)] || ""
              : c.getAttribute("t") === "inlineStr"
                ? [...c.querySelectorAll("t")].map((t) => t.textContent || "").join("")
                : v;
        }
        return row;
      }),
    }));
}
export async function readImport(file: File): Promise<ImportCandidate> {
  if (file.size > 10_000_000) throw new Error("10MB以下のファイルを選んでください。");
  const buffer = await file.arrayBuffer(),
    data = new Uint8Array(buffer);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  let candidate: Omit<ImportCandidate, "fileName" | "digest">;
  if (/\.xlsx$/i.test(file.name)) candidate = tabularCandidate(xlsx(data));
  else if (/\.pdf$/i.test(file.name)) {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
    const task = pdfjs.getDocument({ data, disableAutoFetch: true, disableStream: true });
    const pdf = await task.promise;
    try {
      if (pdf.numPages > 50) throw new Error("50ページ以下のPDFを選んでください。");
      const lines: string[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const content = await (await pdf.getPage(i)).getTextContent();
        let row = "",
          lastY: number | undefined;
        for (const item of content.items) {
          if (!("str" in item)) continue;
          const y = item.transform[5] as number;
          if (lastY !== undefined && Math.abs(y - lastY) > 3) {
            lines.push(row);
            row = "";
          }
          row += ` ${item.str}`;
          lastY = y;
          if (item.hasEOL) {
            lines.push(row);
            row = "";
            lastY = undefined;
          }
        }
        if (row) lines.push(row);
        if (lines.join("").length > 200000) throw new Error("PDFの内容が大きすぎます。");
      }
      candidate = invoiceCandidate(lines);
    } finally {
      await task.destroy();
    }
  } else throw new Error("Excel（.xlsx）またはPDFを選んでください。");
  return { ...candidate, fileName: file.name, digest };
}
