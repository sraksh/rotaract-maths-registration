import type { PublicConfig, Receipt } from '../../supabase/functions/_shared/api.ts';
import { CopyButton } from '../components/CopyButton';
import { examWindow, formatDateLong, formatDateTimeIST, statusLabel, time12 } from '../lib/format';

export function Confirmation({ receipt, config }: { receipt: Receipt; config: PublicConfig }) {
  return (
    <main className="shell">
      <section className="card" aria-labelledby="done-title">
        <h1 id="done-title" tabIndex={-1} ref={(el) => el?.focus()}>Registration submitted successfully!</h1>
        <p>Thank you for registering for the {config.event.name}.</p>
        <p>Your registration ID is displayed below. Please save it for future reference.</p>

        <div className="reg-id" aria-label="Registration ID">
          <code data-testid="registration-id">{receipt.registrationId}</code>
          <CopyButton text={receipt.registrationId} label="Copy ID" copiedLabel="ID copied" />
        </div>

        <p className="notice notice-info">
          Your payment is pending verification. Your registration will be marked as payment-verified only after the organising
          team confirms the payment.
        </p>
        <p>Please follow the reporting time mentioned for your class.</p>

        <dl className="details">
          <div><dt>Student</dt><dd>{receipt.fullName}</dd></div>
          <div><dt>School</dt><dd>{receipt.schoolName}</dd></div>
          <div><dt>Class &amp; shift</dt><dd>Class {receipt.classLevel} — Shift {receipt.shift}</dd></div>
          <div><dt>Examination date</dt><dd>{formatDateLong(receipt.examDate)}</dd></div>
          <div><dt>Examination time</dt><dd>{examWindow(receipt.examStart, receipt.examEnd)}</dd></div>
          <div><dt>Reporting time</dt><dd><strong>{time12(receipt.reportingTime)}</strong></dd></div>
          {config.event.venue && (
            <div><dt>Centre</dt><dd>{config.event.venue}{config.event.venueConfirmed ? '' : ' (tentative — to be confirmed)'}</dd></div>
          )}
          <div><dt>Payment status</dt><dd><span className={`badge badge-${receipt.paymentStatus}`}>{statusLabel(receipt.paymentStatus)}</span></dd></div>
          <div><dt>Submitted</dt><dd>{formatDateTimeIST(receipt.createdAt)}</dd></div>
        </dl>
        <p>Once the organisers verify your payment, you can <a href="#/admit-card">download your admit card</a> using your registration ID and mobile number.</p>
        <p className="hint">Keep your registration ID safe — the organisers may ask for it. You can close this page.</p>
      </section>
    </main>
  );
}
