/** CSV and Excel (.xlsx) generation. No dependency except fflate for zipping. */
import { strToU8, zipSync } from 'fflate';
import type { ExportRow } from '../../supabase/functions/_shared/api.ts';
import { formatDateTimeIST, formatDateLong, examWindow, statusLabel, time12 } from './format';

/**
 * Neutralises spreadsheet formula injection. A cell that begins with = + - @ (or a
 * tab / carriage return, which some programs strip before evaluating) is prefixed
 * with an apostrophe so Excel / Sheets / LibreOffice treat it as text.
 */
export function sanitizeCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export function csvEscape(value: unknown): string {
  const s = sanitizeCell(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers, ...rows].map((r) => r.map(csvEscape).join(','));
  // UTF-8 BOM so Excel opens non-ASCII school names correctly.
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

/** The mobile number is exported as 10 digits (no leading "+"), which is also formula-safe. */
function nationalMobile(e164: string): string {
  return e164.replace(/^\+91/, '');
}

export function exportTable(rows: ExportRow[], includeNotes: boolean): { headers: string[]; data: string[][] } {
  const headers = [
    'Registration ID', 'Student name', 'School', 'Roll number', 'Mobile', 'Class', 'Shift',
    'Exam date', 'Exam time', 'Reporting time', 'Registered at (IST)', 'Payment status',
  ];
  if (includeNotes) headers.push('Rejection reason', 'Internal note');
  const data = rows.map((r) => {
    const base = [
      r.registrationId, r.fullName, r.schoolName, r.rollNumber, nationalMobile(r.mobile),
      `Class ${r.classLevel}`, `Shift ${r.shift}`, formatDateLong(r.examDate), examWindow(r.examStart, r.examEnd),
      time12(r.reportingTime), formatDateTimeIST(r.createdAt), statusLabel(r.paymentStatus),
    ];
    if (includeNotes) base.push(r.paymentRejectReason ?? '', r.paymentNote ?? '');
    return base;
  });
  return { headers, data };
}

// -------------------------------------------------------------------- XLSX ----

function xmlEscape(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function colName(i: number): string {
  let n = i;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/**
 * Builds a minimal .xlsx. Every value is written as an inline STRING cell (never a
 * number or formula), so roll numbers keep leading zeros and text such as "=1+1"
 * is displayed literally instead of being evaluated.
 */
export function buildXlsx(sheetName: string, headers: string[], rows: string[][]): Uint8Array {
  const all = [headers, ...rows];
  const sheetRows = all
    .map((r, ri) => {
      const cells = r
        .map((v, ci) => `<c r="${colName(ci)}${ri + 1}" t="inlineStr"${ri === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlEscape(v ?? '')}</t></is></c>`)
        .join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join('');
  const cols = headers.map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="${i === 2 ? 40 : 18}" customWidth="1"/>`).join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${sheetRows}</sheetData></worksheet>`;
  const safeName = xmlEscape(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1');
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${safeName}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'),
    'xl/styles.xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/></cellXfs></styleSheet>'),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  });
}

export function download(filename: string, content: string | Uint8Array, mime: string): void {
  const blob = new Blob([content as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
