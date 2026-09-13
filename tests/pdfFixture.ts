/**
 * A PDF with a real text layer, written byte by byte: one page per entry, one
 * line of Helvetica per string. Built in the test rather than committed as a
 * binary so the test says exactly what is in it.
 */
export function buildPdf(pages: string[][]): Buffer {
  const objects: string[] = [];
  const push = (body: string) => objects.push(body);

  push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); // 1
  const contentNums: number[] = [];
  for (const lines of pages) {
    const stream =
      'BT /F1 12 Tf 72 720 Td 14 TL\n' +
      lines.map((line) => `(${line.replace(/[()\\]/g, '\\$&')}) Tj T*`).join('\n') +
      '\nET';
    contentNums.push(push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`));
  }
  const pagesNum = objects.length + pages.length + 1;
  const pageNums = pages.map((_, i) =>
    push(
      `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 1 0 R >> >> /Contents ${contentNums[i]} 0 R >>`,
    ),
  );
  push(`<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageNums.length} >>`);
  const catalog = push(`<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
