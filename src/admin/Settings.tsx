import { useCallback, useEffect, useState } from 'react';
import type { AdminConfig } from '../../supabase/functions/_shared/api.ts';
import { validateDeclaredFile, MAX_QR_BYTES } from '../../supabase/functions/_shared/files.ts';
import { scheduleLabel, type ExamSchedule } from '../../supabase/functions/_shared/schedule.ts';
import { ApiError, admin, publicQrUrl, uploadQr } from '../lib/api';
import { useAdmin } from './context';

const MISSING_LABEL: Record<string, string> = {
  fee: 'Registration fee',
  upiPayeeName: 'UPI payee name',
  upiId: 'UPI ID',
  qrImage: 'Official UPI QR image',
  schedules: 'Examination schedules',
  eventConfig: 'Event configuration',
};

interface Form {
  eventName: string;
  organiser: string;
  eventDate: string;
  venue: string;
  venueConfirmed: boolean;
  registrationOpen: boolean;
  feeAmount: string;
  upiPayeeName: string;
  upiId: string;
  schools: string;
  schedules: ExamSchedule[];
}

function toForm(c: AdminConfig): Form {
  return {
    eventName: c.eventName,
    organiser: c.organiser,
    eventDate: c.eventDate,
    venue: c.venue ?? '',
    venueConfirmed: c.venueConfirmed,
    registrationOpen: c.registrationOpen,
    feeAmount: c.feeAmount === null ? '' : String(c.feeAmount),
    upiPayeeName: c.upiPayeeName ?? '',
    upiId: c.upiId ?? '',
    schools: c.schools.join('\n'),
    schedules: c.schedules,
  };
}

export function Settings() {
  const { onError } = useAdmin();
  const [cfg, setCfg] = useState<AdminConfig | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [qrBusy, setQrBusy] = useState(false);

  const apply = useCallback((c: AdminConfig) => {
    setCfg(c);
    setForm(toForm(c));
  }, []);
  const load = useCallback(() => {
    setError(null);
    admin.getConfig().then(apply).catch((e: unknown) => setError(onError(e)));
  }, [apply, onError]);
  useEffect(load, [load]);

  if (error) return <div className="card" role="alert"><p>{error}</p><button className="btn" onClick={load}>Retry</button></div>;
  if (!cfg || !form) return <p className="card" role="status">Loading settings…</p>;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v });
  const setSched = (i: number, patch: Partial<ExamSchedule>) =>
    set('schedules', form.schedules.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !form) return;
    setBusy(true);
    setMsg(null);
    setFieldErrors({});
    try {
      const fee = form.feeAmount.trim();
      const saved = await admin.updateConfig({
        eventName: form.eventName,
        organiser: form.organiser,
        eventDate: form.eventDate,
        venue: form.venue.trim() === '' ? null : form.venue,
        venueConfirmed: form.venueConfirmed,
        registrationOpen: form.registrationOpen,
        feeAmount: fee === '' ? null : Number(fee),
        upiPayeeName: form.upiPayeeName.trim() === '' ? null : form.upiPayeeName,
        upiId: form.upiId.trim() === '' ? null : form.upiId,
        schools: form.schools.split('\n'),
        schedules: form.schedules,
      });
      apply(saved);
      setMsg({ kind: 'ok', text: 'Settings saved.' });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') {
        setFieldErrors(err.fields);
        setMsg({ kind: 'warn', text: 'Some settings are invalid. Please review the highlighted fields.' });
      } else if (err instanceof ApiError && err.code === 'NOT_READY') {
        const missing = ((err.details?.missing as string[] | undefined) ?? []).map((m) => MISSING_LABEL[m] ?? m).join(', ');
        setForm({ ...form, registrationOpen: false });
        setMsg({ kind: 'warn', text: `Registration cannot be opened yet. Still missing: ${missing || 'payment details'}. Other changes were NOT saved — fix this and save again.` });
      } else {
        setMsg({ kind: 'warn', text: onError(err) });
      }
    } finally {
      setBusy(false);
    }
  }

  async function onQr(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const problem = validateDeclaredFile({ fileName: f.name, contentType: f.type, sizeBytes: f.size }, MAX_QR_BYTES);
    if (problem) return setMsg({ kind: 'warn', text: problem });
    setQrBusy(true);
    setMsg(null);
    try {
      await uploadQr(f);
      load();
      setMsg({ kind: 'ok', text: 'QR image updated.' });
    } catch (err) {
      setMsg({ kind: 'warn', text: onError(err) });
    } finally {
      setQrBusy(false);
    }
  }

  const err = (k: string) => fieldErrors[k];
  const text = (id: keyof Form & string, label: string, opts: { type?: string; hint?: string } = {}) => (
    <div className={`field${err(id) ? ' has-error' : ''}`}>
      <label htmlFor={`s-${id}`}>{label}</label>
      {opts.hint && <p className="hint">{opts.hint}</p>}
      <input id={`s-${id}`} type={opts.type ?? 'text'} value={form[id] as string} onChange={(e) => set(id, e.target.value as never)} aria-invalid={Boolean(err(id))} />
      {err(id) && <p className="error">{err(id)}</p>}
    </div>
  );

  return (
    <>
      <h1>Settings</h1>
      {cfg.missing.length > 0 ? (
        <div className="card notice notice-warn">
          <h2>Before registration can open</h2>
          <p>Still missing: <strong>{cfg.missing.map((m) => MISSING_LABEL[m] ?? m).join(', ')}</strong>. Registration cannot be opened and no payment details are shown to students until these are set.</p>
        </div>
      ) : (
        <p className="notice notice-ok">All essential payment settings are configured.</p>
      )}
      {msg && <p className={`notice ${msg.kind === 'ok' ? 'notice-ok' : 'notice-warn'}`} role="status">{msg.text}</p>}

      <form className="card form" onSubmit={save} noValidate>
        <h2>Event</h2>
        {text('eventName', 'Event name')}
        {text('organiser', 'Organiser')}
        {text('eventDate', 'Event date', { type: 'date' })}
        {text('venue', 'Examination centre')}
        <label className="checkbox"><input type="checkbox" checked={form.venueConfirmed} onChange={(e) => set('venueConfirmed', e.target.checked)} /> The centre is final (untick to show “tentative” to students)</label>

        <h2>Payment (UPI)</h2>
        {text('feeAmount', 'Registration fee (₹)', { type: 'number', hint: 'Set by the organisers. Nothing is assumed.' })}
        {text('upiPayeeName', 'UPI payee name')}
        {text('upiId', 'UPI ID', { hint: 'For example name@bank' })}

        <h2>Schools</h2>
        <div className={`field${err('schools') ? ' has-error' : ''}`}>
          <label htmlFor="s-schools">Approved school list (one per line)</label>
          <p className="hint">Leave empty to let students type their school name. When filled, students must choose from this list. Removing a school never changes existing registrations.</p>
          <textarea id="s-schools" rows={8} value={form.schools} onChange={(e) => set('schools', e.target.value)} />
          {err('schools') && <p className="error">{err('schools')}</p>}
        </div>

        <h2>Examination schedule</h2>
        <p className="hint">The class decides the shift; students cannot choose a different one. Times are Asia/Kolkata (24-hour fields).</p>
        {err('schedules') && <p className="error" role="alert">{err('schedules')}</p>}
        <div className="table-wrap">
          <table>
            <thead><tr><th>Class</th><th>Shift</th><th>Start</th><th>End</th><th>Reporting</th></tr></thead>
            <tbody>
              {form.schedules.map((s, i) => (
                <tr key={s.classLevel}>
                  <td>Class {s.classLevel}</td>
                  <td><select aria-label={`Class ${s.classLevel} shift`} value={s.shift} onChange={(e) => setSched(i, { shift: Number(e.target.value) as 1 | 2 })}><option value={1}>1</option><option value={2}>2</option></select></td>
                  <td><input aria-label={`Class ${s.classLevel} start`} type="time" value={s.examStart} onChange={(e) => setSched(i, { examStart: e.target.value })} /></td>
                  <td><input aria-label={`Class ${s.classLevel} end`} type="time" value={s.examEnd} onChange={(e) => setSched(i, { examEnd: e.target.value })} /></td>
                  <td><input aria-label={`Class ${s.classLevel} reporting`} type="time" value={s.reportingTime} onChange={(e) => setSched(i, { reportingTime: e.target.value })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="hint">{form.schedules.map((s) => <li key={s.classLevel}>{scheduleLabel(s)}</li>)}</ul>

        <h2>Registration status</h2>
        <label className="checkbox"><input type="checkbox" checked={form.registrationOpen} onChange={(e) => set('registrationOpen', e.target.checked)} /> Registration is open to the public</label>

        <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button>
      </form>

      <section className="card">
        <h2>Official UPI QR image</h2>
        <p className="hint">Upload the organisers’ own QR image (JPG, PNG or WEBP, up to 2 MB). It is shown to students exactly as provided — it is never generated by this app.</p>
        {cfg.qrImagePath ? <img className="qr" src={`${publicQrUrl(cfg.qrImagePath)}`} alt="Current official UPI QR code" width={200} height={200} /> : <p className="notice notice-warn">No QR image uploaded yet.</p>}
        <div className="field">
          <label htmlFor="qr-file">{cfg.qrImagePath ? 'Replace QR image' : 'Upload QR image'}</label>
          <input id="qr-file" type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" onChange={(e) => void onQr(e)} disabled={qrBusy} />
        </div>
        {qrBusy && <p role="status">Uploading…</p>}
      </section>
    </>
  );
}
