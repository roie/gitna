// Small, valid PDF with one page. No external PDF tools or third-party content.
export function pdfFixture(script?: string): Buffer {
  const text = 'BT /F1 22 Tf 30 240 Td (Gitna native PDF preview) Tj ET'
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R ${script == null ? '' : '/OpenAction 6 0 R'} >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
  ]
  if (script != null)
    objects.push(`<< /S /JavaScript /JS <${Buffer.from(script).toString('hex')}> >>`)
  let data = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(data))
    data += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(data)
  data += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  data += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  data += `trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(data)
}
