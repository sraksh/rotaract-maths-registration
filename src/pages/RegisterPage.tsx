import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PublicConfig, Receipt } from '../../supabase/functions/_shared/api.ts';
import { scheduleLabel } from '../../supabase/functions/_shared/schedule.ts';
import { validateDeclaredFile } from '../../supabase/functions/_shared/files.ts';
import {
  DECLARATION_TEXT,
  validateRegistrationInput,
  type FieldErrors,
  type FieldName,
} from '../../supabase/functions/_shared/validation.ts';
import { Field } from '../components/Field';
import { CopyButton } from '../components/CopyButton';
import { ApiError, fetchPublicConfig, initUpload, publicQrUrl, submitRegistration, uploadProof } from '../lib/api';
import { bytesLabel, formatDateLong, formatRupees } from '../lib/format';
import { Confirmation } from './Confirmation';

type Stage = 'idle' | 'preparing' | 'uploading' | 'saving';

const STAGE_TEXT: Record<Stage, string> = {
  idle: '',
  preparing: 'Preparing your submission…',
  uploading: 'Uploading your payment screenshot…',
  saving: 'Saving your registration…',
};

const FIELD_ORDER: FieldName[] = ['fullName', 'schoolName', 'rollNumber', 'mobile', 'classShift', 'paymentScreenshot', 'declaration'];
const FIELD_LABELS: Record<FieldName, string> = {
  fullName: 'Full name',
  schoolName: 'School name',
  rollNumber: 'Roll number',
  mobile: 'Mobile number',
  classShift: 'Class and examination shift',
  paymentScreenshot: 'Payment screenshot',
  declaration: 'Declaration',
};
const FIELD_ANCHOR: Record<FieldName, string> = {
  fullName: 'f-fullName',
  schoolName: 'f-schoolName',
  rollNumber: 'f-rollNumber',
  mobile: 'f-mobile',
  classShift: 'f-class-7',
  paymentScreenshot: 'f-proof',
  declaration: 'f-declaration',
};

export function RegisterPage() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    fetchPublicConfig()
      .then(setConfig)
      .catch((e: unknown) => setLoadError(e instanceof ApiError ? e.message : 'Could not load the registration form.'));
  }, []);
  useEffect(load, [load]);

  if (receipt && config) return <Confirmation receipt={receipt} config={config} />;

  return (
    <main className="shell">
      <header className="page-header">
        <p className="eyebrow">{config?.event.organiser ?? 'Rotaract Club of Chaibasa'}</p>
        <h1>{config?.event.name ?? '34th Padmabai Rungta Inter-District Mathematics Competition 2026'}</h1>
        {config && (
          <p className="meta">
            {formatDateLong(config.event.date)}
            {config.event.venue ? ` · ${config.event.venue}${config.event.venueConfirmed ? '' : ' (tentative centre)'}` : ''}
          </p>
        )}
      </header>

      {loadError && (
        <div className="card" role="alert">
          <p>{loadError}</p>
          <button type="button" className="btn" onClick={load}>Try again</button>
        </div>
      )}
      {!config && !loadError && <p className="card" role="status">Loading registration form…</p>}

      {config && !config.registrationOpen && (
        <div className="card notice notice-warn" role="status">
          <h2>Registration is currently closed</h2>
          <p>Online registration is not open right now. Please check back later or contact the organising team.</p>
        </div>
      )}
      {config && config.registrationOpen && (!config.paymentReady || !config.payment) && (
        <div className="card notice notice-warn" role="status">
          <h2>Registration is not ready yet</h2>
          <p>The organisers are still finishing the payment setup. Please try again later.</p>
        </div>
      )}
      {config && config.registrationOpen && config.paymentReady && config.payment && (
        <RegistrationForm config={config} payment={config.payment} onDone={setReceipt} />
      )}
    </main>
  );
}

interface FormValues {
  fullName: string;
  schoolName: string;
  rollNumber: string;
  mobile: string;
  classLevel: number | null;
  declaration: boolean;
}

function RegistrationForm({
  config,
  payment,
  onDone,
}: {
  config: PublicConfig;
  payment: NonNullable<PublicConfig['payment']>;
  onDone: (r: Receipt) => void;
}) {
  const [values, setValues] = useState<FormValues>({ fullName: '', schoolName: '', rollNumber: '', mobile: '', classLevel: null, declaration: false });
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [attempt, setAttempt] = useState(0);

  // One idempotency key per form session: every retry of the same submission reuses
  // it, so the server can never create two registrations from one form.
  const idempotencyKey = useRef(crypto.randomUUID());
  const inFlight = useRef(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const schoolsListed = config.schools.length > 0;
  const qrUrl = useMemo(() => publicQrUrl(payment.qrImagePath), [payment.qrImagePath]);

  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (attempt > 0) summaryRef.current?.focus();
  }, [attempt]);

  const busy = stage !== 'idle';
  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    const fieldKey: FieldName | null =
      key === 'classLevel' ? 'classShift' : key === 'fullName' || key === 'schoolName' || key === 'rollNumber' || key === 'mobile' || key === 'declaration' ? (key as FieldName) : null;
    if (fieldKey && errors[fieldKey]) setErrors((e) => ({ ...e, [fieldKey]: undefined }));
  };

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    if (!f) return;
    const problem = validateDeclaredFile({ fileName: f.name, contentType: f.type, sizeBytes: f.size });
    if (problem) {
      setFile(null);
      setErrors((x) => ({ ...x, paymentScreenshot: problem }));
      e.target.value = '';
      return;
    }
    setErrors((x) => ({ ...x, paymentScreenshot: undefined }));
    setFile(f);
  }

  function localValidate(): FieldErrors {
    const selected = config.schedules.find((s) => s.classLevel === values.classLevel);
    const res = validateRegistrationInput(
      { ...values, shift: selected?.shift, classLevel: values.classLevel ?? undefined },
      { approvedSchools: config.schools, schedules: config.schedules },
    );
    const errs: FieldErrors = res.ok ? {} : { ...res.errors };
    if (!file) errs.paymentScreenshot = 'Upload your payment screenshot (JPG, PNG or WEBP, up to 5 MB).';
    else {
      const p = validateDeclaredFile({ fileName: file.name, contentType: file.type, sizeBytes: file.size });
      if (p) errs.paymentScreenshot = p;
    }
    return errs;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current) return; // blocks double clicks / double Enter synchronously
    const errs = localValidate();
    setFormError(null);
    setErrors(errs);
    if (Object.keys(errs).length > 0 || !file) {
      setAttempt((n) => n + 1);
      return;
    }
    inFlight.current = true;
    setStage('preparing');
    try {
      const selected = config.schedules.find((s) => s.classLevel === values.classLevel)!;
      const init = await initUpload(idempotencyKey.current, { fileName: file.name, contentType: file.type, sizeBytes: file.size });
      if (init.replay && init.registration) {
        onDone(init.registration);
        return;
      }
      if (!init.bucket || !init.path || !init.token || !init.uploadSessionId) throw new ApiError('INTERNAL', 'Unexpected response from the server. Please try again.', { retryable: true });
      setStage('uploading');
      await uploadProof({ bucket: init.bucket, path: init.path, token: init.token }, file);
      setStage('saving');
      const res = await submitRegistration({
        idempotencyKey: idempotencyKey.current,
        uploadSessionId: init.uploadSessionId,
        registration: {
          fullName: values.fullName,
          schoolName: values.schoolName,
          rollNumber: values.rollNumber,
          mobile: values.mobile,
          classLevel: selected.classLevel,
          shift: selected.shift,
          declaration: values.declaration,
        },
      });
      onDone(res.registration);
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : new ApiError('INTERNAL', 'Something went wrong. Please try again.', { retryable: true });
      const fieldErrs: FieldErrors = {};
      for (const [k, v] of Object.entries(apiErr.fields)) if ((FIELD_ORDER as string[]).includes(k)) fieldErrs[k as FieldName] = v;
      setErrors(fieldErrs);
      if (apiErr.code === 'UPLOAD_INVALID' || apiErr.code === 'UPLOAD_MISSING') setFile(null);
      if (fileInput.current && (apiErr.code === 'UPLOAD_INVALID' || apiErr.code === 'UPLOAD_MISSING')) fileInput.current.value = '';
      setFormError(Object.keys(fieldErrs).length > 0 && apiErr.code === 'VALIDATION_FAILED' ? null : apiErr.message);
      setAttempt((n) => n + 1);
    } finally {
      inFlight.current = false;
      setStage('idle');
    }
  }

  const errorList = FIELD_ORDER.filter((k) => errors[k]);

  return (
    <form className="card form" onSubmit={onSubmit} noValidate aria-busy={busy}>
      <h2>Student registration</h2>
      <p className="hint">All fields are required. Pay the fee first, then upload the screenshot.</p>

      <div ref={summaryRef} tabIndex={-1} className="error-summary" role="alert" hidden={errorList.length === 0 && !formError}>
        {formError && <p><strong>{formError}</strong></p>}
        {errorList.length > 0 && (
          <>
            <p><strong>Please fix the following:</strong></p>
            <ul>
              {errorList.map((k) => (
                <li key={k}>
                  <a href={`#${FIELD_ANCHOR[k]}`} onClick={(ev) => { ev.preventDefault(); document.getElementById(FIELD_ANCHOR[k])?.focus(); }}>
                    {FIELD_LABELS[k]}
                  </a>: {errors[k]}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <Field id="f-fullName" label="1. Full name" error={errors.fullName}>
        {(a) => <input {...a} name="fullName" type="text" autoComplete="name" value={values.fullName} onChange={(e) => set('fullName', e.target.value)} maxLength={120} />}
      </Field>

      <Field id="f-schoolName" label="2. School name" error={errors.schoolName} hint={schoolsListed ? 'Start typing to search, then choose your school from the list.' : undefined}>
        {(a) => (
          <>
            <input {...a} name="schoolName" type="text" autoComplete="off" list={schoolsListed ? 'school-options' : undefined} value={values.schoolName} onChange={(e) => set('schoolName', e.target.value)} maxLength={160} />
            {schoolsListed && <datalist id="school-options">{config.schools.map((s) => <option key={s} value={s} />)}</datalist>}
          </>
        )}
      </Field>

      <Field id="f-rollNumber" label="3. Roll number" error={errors.rollNumber} hint="Enter it exactly as on your school record — leading zeros are kept.">
        {(a) => <input {...a} name="rollNumber" type="text" inputMode="text" autoComplete="off" value={values.rollNumber} onChange={(e) => set('rollNumber', e.target.value)} maxLength={30} />}
      </Field>

      <Field id="f-mobile" label="4. Mobile number" error={errors.mobile} hint="10-digit Indian mobile number.">
        {(a) => <input {...a} name="mobile" type="tel" inputMode="tel" autoComplete="tel" value={values.mobile} onChange={(e) => set('mobile', e.target.value)} maxLength={20} />}
      </Field>

      <fieldset className={`field${errors.classShift ? ' has-error' : ''}`} aria-describedby={errors.classShift ? 'class-error' : undefined}>
        <legend>5. Class and examination shift</legend>
        {config.schedules.map((s) => (
          <label key={s.classLevel} className="radio">
            <input type="radio" id={`f-class-${s.classLevel}`} name="classShift" checked={values.classLevel === s.classLevel} onChange={() => set('classLevel', s.classLevel)} />
            <span>{scheduleLabel(s)}</span>
          </label>
        ))}
        {errors.classShift && <p className="error" id="class-error">{errors.classShift}</p>}
      </fieldset>

      <section className="payment" aria-labelledby="pay-title">
        <h3 id="pay-title">6. Registration fee payment</h3>
        <div className="payment-grid">
          <img className="qr" src={qrUrl} alt={`Official UPI QR code for ${payment.payeeName}`} width={240} height={240} />
          <div>
            <p className="fee">Registration fee: <strong>{formatRupees(payment.fee)}</strong></p>
            <dl className="details compact">
              <div><dt>Payee name</dt><dd>{payment.payeeName}</dd></div>
              <div><dt>UPI ID</dt><dd><code>{payment.upiId}</code> <CopyButton text={payment.upiId} label="Copy UPI ID" copiedLabel="Copied" /></dd></div>
            </dl>
            <ol className="steps">
              <li>Scan the QR code with any UPI app, or pay to the UPI ID above.</li>
              <li>Pay exactly {formatRupees(payment.fee)} and take a screenshot showing the successful payment.</li>
              <li>Upload that screenshot below, then submit.</li>
            </ol>
          </div>
        </div>

        <Field id="f-proof" label="7. Payment screenshot" error={errors.paymentScreenshot} hint="JPG, JPEG, PNG or WEBP, up to 5 MB. Our team verifies it after you submit.">
          {(a) => <input {...a} ref={fileInput} name="paymentScreenshot" type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" onChange={onFile} />}
        </Field>
        {file && preview && (
          <div className="preview">
            <img src={preview} alt="Preview of the selected payment screenshot" />
            <p className="hint">{file.name} · {bytesLabel(file.size)}</p>
            <button type="button" className="btn btn-secondary" onClick={() => fileInput.current?.click()}>Replace screenshot</button>
          </div>
        )}
      </section>

      <div className={`field${errors.declaration ? ' has-error' : ''}`}>
        <label className="checkbox" htmlFor="f-declaration">
          <input id="f-declaration" type="checkbox" checked={values.declaration} onChange={(e) => set('declaration', e.target.checked)} aria-invalid={Boolean(errors.declaration)} aria-describedby={errors.declaration ? 'f-declaration-error' : undefined} />
          <span><strong>8.</strong> {DECLARATION_TEXT}</span>
        </label>
        {errors.declaration && <p className="error" id="f-declaration-error">{errors.declaration}</p>}
      </div>

      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy ? STAGE_TEXT[stage] : 'Submit registration'}
      </button>
      <p className="sr-only" role="status" aria-live="polite">{STAGE_TEXT[stage]}</p>
      {busy && <p className="hint">Please keep this page open. Do not tap again.</p>}
    </form>
  );
}
