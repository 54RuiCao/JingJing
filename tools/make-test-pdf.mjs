import { writeFileSync } from "node:fs";

// 生成一个最小的合法 PDF（Helvetica 拉丁文本），用于验证 PDF 导入/渲染链路。
const objects = [];
const add = (s) => { objects.push(s); return objects.length; };

const content = "BT /F1 28 Tf 72 760 Td (Hello PDF from aireader) Tj ET\n" +
                "BT /F1 14 Tf 72 720 Td (If you can read this, PDF rendering works.) Tj ET\n" +
                "BT /F1 14 Tf 72 690 Td (Page 1 of 1) Tj ET\n";

add("<< /Type /Catalog /Pages 2 0 R >>");
add("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>");
add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
add(`<< /Length ${content.length} >>\nstream\n${content}endstream`);

let pdf = "%PDF-1.4\n";
const offsets = [0];
objects.forEach((body, i) => {
  offsets.push(pdf.length);
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xrefPos = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n`;
pdf += "0000000000 65535 f \n";
for (let i = 1; i <= objects.length; i++) {
  pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;

writeFileSync("fixtures/test.pdf", Buffer.from(pdf, "latin1"));
console.log("wrote fixtures/test.pdf", pdf.length, "bytes");
