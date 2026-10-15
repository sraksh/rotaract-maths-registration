import { useCallback, useEffect, useRef, useState } from 'react';
import type { ListResult, PaymentStatus, RegistrationFilters } from '../../supabase/functions/_shared/api.ts';
import { admin } from '../lib/api';
import { buildXlsx, download, exportTable, toCsv, XLSX_MIME } from '../lib/export';
import { examWindow, formatDateTimeIST, statusLabel, time12, todayIST } from '../lib/format';
import { useAdmin } from './context';

const PAGE_SIZE = 25;

interface Draft {
  q: string;
  classLevel: string;
  school: string;
  status: string;
  from: string;
  to: string;
}

function initialDraft(): Draft {
  const query = window.location.hash.split('?')[1] ?? '';
  const p = new URLSearchParams(query);
  const status = p.get('status') ?? '';
  return { q: '', classLevel: '', school: '', status: ['pending', 'verified', 'rejected'].includes(status) ? status : '', from: '', to: '' };
}

function toFilters(d: Draft): RegistrationFilters {
  const f: RegistrationFilters = {};
  if (d.q.trim()) f.q = d.q.trim();
  if (d.classLevel) f.classLevel = Number(d.classLevel);
  if (d.school) f.school = d.school;
  if (d.status) f.status = d.status as PaymentStatus;
  if (d.from) f.from = d.from;
  if (d.to) f.to = d.to;
  return f;
}

export function Registrations() {
  const { onError } = useAdmin();
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [applied, setApplied] = useState<RegistrationFilters>(() => toFilters(initialDraft()));
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [schools, setSchools] = useState<string[]>([]);
  const [includeNotes, setIncludeNotes] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    admin.stats().then((s) => setSchools(s.bySchool.map((x) => x.school).sort((a, b) => a.localeCompare(b)))).catch(() => undefined);
  }, []);

  const load = useCallback(() => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    admin
      .list(applied, page, PAGE_SIZE)
      .then((r) => mine === seq.current && setData(r))
      .catch((e: unknown) => mine === seq.current && setError(onError(e)))
      .finally(() => mine === seq.current && setLoading(false));
  }, [applied, page, onError]);
  useEffect(load, [load]);

  function apply(e: React.FormEvent) {
    e.preventDefault();
    setPage(1);
    setApplied(toFilters(draft));
  }
  function reset() {
    const empty: Draft = { q: '', classLevel: '', school: '', status: '', from: '', to: '' };
    setDraft(empty);
    setPage(1);
    setApplied({});
  }

  async function doExport(format: 'csv' | 'xlsx') {
    setExporting(format);
    setExportError(null);
    try {
      const res = await admin.exportRows(applied, format, includeNotes);
      const { headers, data: rows } = exportTable(res.rows, includeNotes);
      const name = `registrations-${todayIST()}`;
      if (format === 'csv') download(`${name}.csv`, toCsv(headers, rows), 'text/csv;charset=utf-8');
      else download(`${name}.xlsx`, buildXlsx('Registrations', headers, rows), XLSX_MIME);
      if (res.truncated) setExportError(`Only the first ${res.rows.length} of ${res.total} rows were exported. Narrow the filters and export again.`);
    } catch (e) {
      setExportError(onError(e));
    } finally {
      setExporting(null);
    }
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <h1>Registrations</h1>
      <form className="card filters" onSubmit={apply} role="search" aria-label="Filter registrations">
        <div className="field grow">
          <label htmlFor="q">Search</label>
          <input id="q" type="search" placeholder="Registration ID, name, school or mobile" value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} maxLength={100} />
        </div>
        <div className="field">
          <label htmlFor="fc">Class</label>
          <select id="fc" value={draft.classLevel} onChange={(e) => setDraft({ ...draft, classLevel: e.target.value })}>
            <option value="">All</option>
            {[7, 8, 9, 10].map((c) => <option key={c} value={c}>Class {c}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="fs">School</label>
          <select id="fs" value={draft.school} onChange={(e) => setDraft({ ...draft, school: e.target.value })}>
            <option value="">All</option>
            {schools.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="fp">Payment status</label>
          <select id="fp" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
            <option value="">All</option>
            <option value="pending">Pending</option>
            <option value="verified">Verified</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="ff">From (IST)</label>
          <input id="ff" type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="ft">To (IST)</label>
          <input id="ft" type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </div>
        <div className="actions">
          <button className="btn btn-primary">Apply</button>
          <button type="button" className="btn btn-secondary" onClick={reset}>Reset</button>
        </div>
      </form>

      <div className="row-between wrap">
        <p role="status" aria-live="polite">{loading ? 'Loading…' : data ? `${data.total} registration${data.total === 1 ? '' : 's'} match` : ''}</p>
        <div className="actions">
          <label className="checkbox inline"><input type="checkbox" checked={includeNotes} onChange={(e) => setIncludeNotes(e.target.checked)} /> Include internal notes</label>
          <button className="btn btn-secondary" disabled={exporting !== null || !data?.total} onClick={() => void doExport('csv')}>{exporting === 'csv' ? 'Preparing…' : 'Export CSV'}</button>
          <button className="btn btn-secondary" disabled={exporting !== null || !data?.total} onClick={() => void doExport('xlsx')}>{exporting === 'xlsx' ? 'Preparing…' : 'Export Excel'}</button>
        </div>
      </div>
      {exportError && <p className="notice notice-warn" role="alert">{exportError}</p>}

      {error && <div className="card" role="alert"><p>{error}</p><button className="btn" onClick={load}>Retry</button></div>}

      {!error && data && data.rows.length === 0 && !loading && <p className="card">No registrations match these filters.</p>}

      {!error && data && data.rows.length > 0 && (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Registrations table">
          <table>
            <thead>
              <tr>
                <th>Registration ID</th><th>Student</th><th>School</th><th>Roll</th><th>Mobile</th><th>Class / shift</th><th>Registered (IST)</th><th>Payment</th><th>Proof</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.registrationId}>
                  <td><a href={`#/admin/registrations/${r.registrationId}`}>{r.registrationId}</a></td>
                  <td>{r.fullName}</td>
                  <td>{r.schoolName}</td>
                  <td>{r.rollNumber}</td>
                  <td>{r.mobile.replace(/^\+91/, '+91 ')}</td>
                  <td>Class {r.classLevel} · Shift {r.shift}<br /><span className="hint">{examWindow(r.examStart, r.examEnd)} (rep. {time12(r.reportingTime)})</span></td>
                  <td>{formatDateTimeIST(r.createdAt)}</td>
                  <td><span className={`badge badge-${r.paymentStatus}`}>{statusLabel(r.paymentStatus)}</span></td>
                  <td>{r.hasProof ? 'Uploaded' : 'Missing'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.total > PAGE_SIZE && (
        <nav className="pager" aria-label="Pagination">
          <button className="btn btn-secondary" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>Previous</button>
          <span>Page {page} of {totalPages}</span>
          <button className="btn btn-secondary" disabled={page >= totalPages || loading} onClick={() => setPage((p) => p + 1)}>Next</button>
        </nav>
      )}
    </>
  );
}
