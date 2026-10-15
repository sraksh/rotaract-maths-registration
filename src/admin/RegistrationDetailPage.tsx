import { useCallback, useEffect, useRef, useState } from 'react';
import type { RegistrationDetail } from '../../supabase/functions/_shared/api.ts';
import { ApiError, admin } from '../lib/api';
import { bytesLabel, examWindow, formatDateLong, formatDateTimeIST, statusLabel, time12 } from '../lib/format';
import { useAdmin } from './context';

const ACTION_LABEL: Record<string, string> = {
  registration_created: 'Registration created',
  payment_status_changed: 'Payment status changed',
  note_updated: 'Internal note updated',
  proof_viewed: 'Payment proof viewed',
  config_updated: 'Settings updated',
  qr_updated: 'QR image replaced',
  export: 'Data exported',
};

export function RegistrationDetailPage({ registrationId }: { registrationId: string }) {
  const { onError } = useAdmin();
  const [reg, setReg] = useState<RegistrationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [proof, setProof] = useState<{ url: string; expiresAt: number } | null>(null);
  const [proofError, setProofError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const inFlight = useRef(false);

  const apply = useCallback((r: RegistrationDetail) => {
    setReg(r);
    setNote(r.paymentNote ?? '');
  }, []);

  const load = useCallback(() => {
    setError(null);
    admin.detail(registrationId).then(apply).catch((e: unknown) => setError(onError(e)));
  }, [registrationId, apply, onError]);
  useEffect(load, [load]);

  useEffect(() => {
    if (!proof) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [proof]);
  const proofLeft = proof ? Math.max(0, Math.ceil((proof.expiresAt - now) / 1000)) : 0;
  useEffect(() => {
    if (proof && proofLeft === 0) setProof(null);
  }, [proof, proofLeft]);

  async function run(fn: () => Promise<RegistrationDetail>, okText: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    setFieldErrors({});
    try {
      apply(await fn());
      setMessage({ kind: 'ok', text: okText });
      setRejecting(false);
      setReason('');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'STATUS_CONFLICT') {
        const latest = e.details?.registration as RegistrationDetail | null | undefined;
        if (latest) apply(latest);
        setMessage({ kind: 'warn', text: e.message });
      } else if (e instanceof ApiError && e.code === 'VALIDATION_FAILED') {
        setFieldErrors(e.fields);
      } else {
        setMessage({ kind: 'warn', text: onError(e) });
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function viewProof() {
    setProofError(null);
    try {
      const r = await admin.proofUrl(registrationId);
      setProof({ url: r.url, expiresAt: Date.now() + r.expiresInSeconds * 1000 });
      setNow(Date.now());
      load(); // refresh history: every proof view is audited
    } catch (e) {
      setProofError(onError(e));
    }
  }

  if (error) return <div className="card" role="alert"><p>{error}</p><button className="btn" onClick={load}>Retry</button> <a className="btn btn-secondary" href="#/admin/registrations">Back</a></div>;
  if (!reg) return <p className="card" role="status">Loading registration…</p>;

  return (
    <>
      <p><a href="#/admin/registrations">← All registrations</a></p>
      <div className="row-between wrap">
        <h1>{reg.registrationId}</h1>
        <span className={`badge badge-${reg.paymentStatus} badge-lg`}>{statusLabel(reg.paymentStatus)}</span>
      </div>
      {message && <p className={`notice ${message.kind === 'ok' ? 'notice-ok' : 'notice-warn'}`} role="status">{message.text}</p>}

      <div className="grid-2">
        <section className="card">
          <h2>Student</h2>
          <dl className="details">
            <div><dt>Name</dt><dd>{reg.fullName}</dd></div>
            <div><dt>School</dt><dd>{reg.schoolName}</dd></div>
            <div><dt>Roll number</dt><dd>{reg.rollNumber}</dd></div>
            <div><dt>Mobile</dt><dd>{reg.mobile}</dd></div>
            <div><dt>Class &amp; shift</dt><dd>Class {reg.classLevel} — Shift {reg.shift}</dd></div>
            <div><dt>Exam</dt><dd>{formatDateLong(reg.examDate)}, {examWindow(reg.examStart, reg.examEnd)}</dd></div>
            <div><dt>Reporting</dt><dd>{time12(reg.reportingTime)}</dd></div>
            <div><dt>Registered</dt><dd>{formatDateTimeIST(reg.createdAt)}</dd></div>
            <div><dt>Declaration</dt><dd>{reg.declarationAccepted ? `Accepted ${formatDateTimeIST(reg.declarationAcceptedAt)}` : 'Not accepted'}</dd></div>
            {reg.paymentReviewedAt && (
              <div><dt>Last reviewed</dt><dd>{formatDateTimeIST(reg.paymentReviewedAt)} by {reg.paymentReviewedByEmail ?? 'unknown'}</dd></div>
            )}
            {reg.paymentRejectReason && <div><dt>Rejection reason</dt><dd>{reg.paymentRejectReason}</dd></div>}
          </dl>
        </section>

        <section className="card">
          <h2>Payment proof</h2>
          <p className="hint">{reg.hasProof ? `${reg.proofContentType} · ${bytesLabel(reg.proofSizeBytes)} · stored privately` : 'No proof stored.'} Viewing is logged. Access links expire after about a minute.</p>
          {reg.hasProof && !proof && <button className="btn" onClick={() => void viewProof()}>View payment proof</button>}
          {proofError && <p className="error" role="alert">{proofError}</p>}
          {proof && (
            <div>
              <img className="proof" src={proof.url} alt="Payment screenshot submitted by the student" referrerPolicy="no-referrer" />
              <p className="hint">Link expires in {proofLeft}s. <button className="btn btn-secondary" onClick={() => setProof(null)}>Hide</button></p>
            </div>
          )}
        </section>
      </div>

      <section className="card">
        <h2>Verify payment</h2>
        <p className="hint">A screenshot is not proof of payment. Confirm the amount in your bank / UPI statement before verifying.</p>
        <div className="field">
          <label htmlFor="note">Internal verification note (admins only, never exported unless you tick “include notes”)</label>
          <textarea id="note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} aria-invalid={Boolean(fieldErrors.note)} />
          {fieldErrors.note && <p className="error">{fieldErrors.note}</p>}
        </div>
        <div className="actions">
          <button className="btn btn-secondary" disabled={busy || note.trim() === (reg.paymentNote ?? '')} onClick={() => void run(() => admin.updateNote(reg.registrationId, note.trim() || null), 'Note saved.')}>Save note only</button>
          {reg.paymentStatus !== 'verified' && (
            <button className="btn btn-primary" disabled={busy} onClick={() => void run(() => admin.setPaymentStatus({ registrationId: reg.registrationId, expectedStatus: reg.paymentStatus, newStatus: 'verified', note: note.trim() || null }), 'Payment marked as verified.')}>Mark payment verified</button>
          )}
          {reg.paymentStatus !== 'rejected' && !rejecting && (
            <button className="btn btn-danger" disabled={busy} onClick={() => setRejecting(true)}>Reject proof…</button>
          )}
        </div>
        {rejecting && (
          <div className="reject-box">
            <div className="field">
              <label htmlFor="reason">Reason for rejection (required)</label>
              <textarea id="reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} aria-invalid={Boolean(fieldErrors.reason)} aria-describedby={fieldErrors.reason ? 'reason-err' : undefined} />
              {fieldErrors.reason && <p className="error" id="reason-err" role="alert">{fieldErrors.reason}</p>}
            </div>
            <div className="actions">
              <button className="btn btn-danger" disabled={busy} onClick={() => void run(() => admin.setPaymentStatus({ registrationId: reg.registrationId, expectedStatus: reg.paymentStatus, newStatus: 'rejected', reason: reason.trim(), note: note.trim() || null }), 'Payment proof rejected.')}>Confirm rejection</button>
              <button className="btn btn-secondary" onClick={() => { setRejecting(false); setFieldErrors({}); }}>Cancel</button>
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <h2>History</h2>
        <ol className="history">
          {reg.history.map((h) => (
            <li key={h.id}>
              <strong>{ACTION_LABEL[h.action] ?? h.action}</strong>
              {h.previousStatus || h.newStatus ? <> — {h.previousStatus ? statusLabel(h.previousStatus) : '—'} → {h.newStatus ? statusLabel(h.newStatus) : '—'}</> : null}
              <br />
              <span className="hint">{formatDateTimeIST(h.createdAt)} · {h.actorEmail ?? 'system / student'}</span>
              {h.reason && <div>Reason: {h.reason}</div>}
              {h.note && <div>Note: {h.note}</div>}
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
