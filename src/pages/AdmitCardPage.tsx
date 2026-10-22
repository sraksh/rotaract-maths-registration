import { useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import type { AdmitCard } from '../../supabase/functions/_shared/api.ts';
import { normalizeIndianMobile } from '../../supabase/functions/_shared/validation.ts';
import { Field } from '../components/Field';
import { ApiError, fetchAdmitCard } from '../lib/api';
import { examWindow, formatDateLong, time12 } from '../lib/format';

const ID_RE = /^PRM34-[0-9A-F]{10}$/;

/**
 * Instructions printed on every card. EDIT THIS LIST to match the organisers' real
 * rules before the cards are issued (e.g. calculators, stationery, ID proof).
 */
export const ADMIT_CARD_INSTRUCTIONS: readonly string[] = [
  'Bring this admit card (printed or on your phone) to the examination centre.',
  'Reach the centre by the reporting time shown above.',
  'Carry your school identity card.',
];

function QrSvg({ text }: { text: string }) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  // The SVG is generated locally from the validated registration ID only.
  return <div className="qr-box" role="img" aria-label={`QR code of registration ID ${text}`} dangerouslySetInnerHTML={{ __html: qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true }) }} />;
}

function Card({ card }: { card: AdmitCard }) {
  return (
    <article className="admit-card" aria-label="Admit card">
      <header>
        <p className="eyebrow">{card.organiser}</p>
        <h2>{card.eventName}</h2>
        <p className="admit-title">ADMIT CARD</p>
      </header>
      <div className="admit-body">
        <dl className="details">
          <div><dt>Student name</dt><dd>{card.fullName}</dd></div>
          <div><dt>School</dt><dd>{card.schoolName}</dd></div>
          <div><dt>Roll number</dt><dd>{card.rollNumber}</dd></div>
          <div><dt>Class &amp; shift</dt><dd>Class {card.classLevel} — Shift {card.shift}</dd></div>
          <div><dt>Examination date</dt><dd>{formatDateLong(card.examDate)}</dd></div>
          <div><dt>Examination time</dt><dd>{examWindow(card.examStart, card.examEnd)}</dd></div>
          <div><dt>Reporting time</dt><dd><strong>{time12(card.reportingTime)}</strong></dd></div>
          <div><dt>Centre</dt><dd>{card.venue}</dd></div>
        </dl>
        <div className="admit-id">
          <QrSvg text={card.registrationId} />
          <p className="hint">Registration ID</p>
          <code>{card.registrationId}</code>
        </div>
      </div>
      <h3>Instructions</h3>
      <ul>{ADMIT_CARD_INSTRUCTIONS.map((t) => <li key={t}>{t}</li>)}</ul>
    </article>
  );
}

export function AdmitCardPage() {
  const [id, setId] = useState('');
  const [mobile, setMobile] = useState('');
  const [errors, setErrors] = useState<{ registrationId?: string; mobile?: string }>({});
  const [message, setMessage] = useState<{ kind: 'warn' | 'info'; text: string } | null>(null);
  const [card, setCard] = useState<AdmitCard | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    const cleanId = id.trim().toUpperCase();
    const norm = normalizeIndianMobile(mobile);
    const errs: typeof errors = {};
    if (!ID_RE.test(cleanId)) errs.registrationId = 'Enter your registration ID, for example PRM34-3F9A07C1D2.';
    if (!norm) errs.mobile = 'Enter the 10-digit mobile number used while registering.';
    setErrors(errs);
    setMessage(null);
    if (Object.keys(errs).length > 0 || !norm) return;

    inFlight.current = true;
    setBusy(true);
    try {
      setCard(await fetchAdmitCard(cleanId, norm));
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      if (apiErr?.code === 'VALIDATION_FAILED') setErrors({ registrationId: apiErr.fields.registrationId, mobile: apiErr.fields.mobile });
      setMessage({ kind: apiErr?.code === 'ADMIT_CARD_NOT_AVAILABLE' ? 'info' : 'warn', text: apiErr?.message ?? 'Something went wrong. Please try again.' });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (card) {
    return (
      <main className="shell">
        <div className="no-print actions">
          <button className="btn btn-primary" onClick={() => window.print()}>Print / Save as PDF</button>
          <button className="btn btn-secondary" onClick={() => setCard(null)}>Back</button>
        </div>
        <p className="hint no-print">Tip: in the print window choose “Save as PDF” as the printer to get a file you can keep on your phone.</p>
        <Card card={card} />
      </main>
    );
  }

  return (
    <main className="shell narrow">
      <form className="card form" onSubmit={submit} noValidate aria-busy={busy}>
        <h1>Download your admit card</h1>
        <p className="hint">Enter the registration ID you received after registering, and the mobile number you used. The admit card is available once the organisers have verified your payment.</p>
        {message && <p className={`notice ${message.kind === 'info' ? 'notice-info' : 'notice-warn'}`} role="alert">{message.text}</p>}
        <Field id="ac-id" label="Registration ID" error={errors.registrationId}>
          {(a) => <input {...a} type="text" autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="PRM34-XXXXXXXXXX" value={id} onChange={(e) => setId(e.target.value)} maxLength={20} />}
        </Field>
        <Field id="ac-mobile" label="Mobile number" error={errors.mobile}>
          {(a) => <input {...a} type="tel" inputMode="tel" autoComplete="tel" value={mobile} onChange={(e) => setMobile(e.target.value)} maxLength={20} />}
        </Field>
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Looking up…' : 'Show my admit card'}</button>
        <p className="hint"><a href="#/">← Back to registration</a></p>
      </form>
    </main>
  );
}
