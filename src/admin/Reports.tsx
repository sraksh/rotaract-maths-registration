import { useEffect, useMemo, useState } from 'react';
import type { ExportRow, PaymentStatus } from '../../supabase/functions/_shared/api.ts';
import { scheduleLabel } from '../../supabase/functions/_shared/schedule.ts';
import { admin } from '../lib/api';
import { download, exportTable, toCsv } from '../lib/export';
import { examWindow, formatDateLong, statusLabel, time12, todayIST } from '../lib/format';
import { useAdmin } from './context';

type Mode = 'class' | 'school';

const byRoll = (a: ExportRow, b: ExportRow) =>
  a.schoolName.localeCompare(b.schoolName) ||
  a.rollNumber.localeCompare(b.rollNumber, undefined, { numeric: true }) ||
  a.fullName.localeCompare(b.fullName);

export function Reports() {
  const { onError } = useAdmin();
  const [mode, setMode] = useState<Mode>('class');
  const [status, setStatus] = useState<'' | PaymentStatus>('verified');
  const [rows, setRows] = useState<ExportRow[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const res = await admin.exportRows(status ? { status } : {}, 'print', false);
      setRows(res.rows);
      setTruncated(res.truncated);
    } catch (e) {
      setError(onError(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const groups = useMemo(() => {
    if (!rows) return [];
    const map = new Map<string, ExportRow[]>();
    for (const r of rows) {
      const key = mode === 'class' ? String(r.classLevel) : r.schoolName;
      (map.get(key) ?? map.set(key, []).get(key)!).push(r);
    }
    const keys = [...map.keys()].sort((a, b) => (mode === 'class' ? Number(a) - Number(b) : a.localeCompare(b)));
    return keys.map((k) => ({ key: k, rows: map.get(k)!.sort(byRoll) }));
  }, [rows, mode]);

  function downloadCsv() {
    if (!rows) return;
    const sorted = [...rows].sort((a, b) => a.classLevel - b.classLevel || byRoll(a, b));
    const { headers, data } = exportTable(sorted, false);
    download(`participants-${mode}-wise-${todayIST()}.csv`, toCsv(headers, data), 'text/csv;charset=utf-8');
  }

  return (
    <>
      <div className="no-print">
        <h1>Participant lists</h1>
        <div className="card filters">
          <div className="field">
            <label htmlFor="rm">Group by</label>
            <select id="rm" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
              <option value="class">Class (with shift &amp; timing)</option>
              <option value="school">School</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="rs">Include payments</label>
            <select id="rs" value={status} onChange={(e) => setStatus(e.target.value as '' | PaymentStatus)}>
              <option value="verified">Verified only</option>
              <option value="">All registrations</option>
              <option value="pending">Pending only</option>
              <option value="rejected">Rejected only</option>
            </select>
          </div>
          <div className="actions">
            <button className="btn btn-primary" onClick={() => window.print()} disabled={!rows?.length}>Print / save as PDF</button>
            <button className="btn btn-secondary" onClick={downloadCsv} disabled={!rows?.length}>Download CSV</button>
            <button className="btn btn-secondary" onClick={() => void generate()} disabled={loading}>Refresh</button>
          </div>
        </div>
        {error && <p className="notice notice-warn" role="alert">{error}</p>}
        {loading && <p role="status">Loading…</p>}
        {truncated && <p className="notice notice-warn">The list was truncated to the first 20,000 registrations.</p>}
        {rows && rows.length === 0 && !loading && <p className="card">No registrations match.</p>}
      </div>

      {groups.map((g) => {
        const sample = g.rows[0]!;
        return (
          <section key={g.key} className="report-group">
            <h2>
              {mode === 'class'
                ? `Class ${g.key} — Shift ${sample.shift}`
                : g.key}
              <span className="hint"> · {g.rows.length} participant{g.rows.length === 1 ? '' : 's'}</span>
            </h2>
            {mode === 'class' && (
              <p className="hint">
                {scheduleLabel({ classLevel: sample.classLevel as 7 | 8 | 9 | 10, shift: sample.shift as 1 | 2, examStart: sample.examStart, examEnd: sample.examEnd, reportingTime: sample.reportingTime })}
                {' · '}{formatDateLong(sample.examDate)}
              </p>
            )}
            <table>
              <thead>
                <tr>
                  <th>#</th><th>Roll</th><th>Student</th>
                  {mode === 'class' ? <th>School</th> : <><th>Class</th><th>Shift &amp; timing</th></>}
                  <th>Mobile</th><th>Reg. ID</th><th>Payment</th>
                </tr>
              </thead>
              <tbody>
                {g.rows.map((r, i) => (
                  <tr key={r.registrationId}>
                    <td>{i + 1}</td><td>{r.rollNumber}</td><td>{r.fullName}</td>
                    {mode === 'class' ? <td>{r.schoolName}</td> : <><td>{r.classLevel}</td><td>Shift {r.shift}: {examWindow(r.examStart, r.examEnd)} (rep. {time12(r.reportingTime)})</td></>}
                    <td>{r.mobile.replace(/^\+91/, '')}</td><td>{r.registrationId}</td><td>{statusLabel(r.paymentStatus)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
    </>
  );
}
