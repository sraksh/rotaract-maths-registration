import type { ReactNode } from 'react';

export function Field(props: { id: string; label: string; error?: string | undefined; hint?: string; children: (aria: { id: string; 'aria-invalid': boolean; 'aria-describedby': string | undefined }) => ReactNode }) {
  const errId = `${props.id}-error`;
  const hintId = `${props.id}-hint`;
  const describedBy = [props.error ? errId : null, props.hint ? hintId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field${props.error ? ' has-error' : ''}`}>
      <label htmlFor={props.id}>{props.label}</label>
      {props.hint && <p className="hint" id={hintId}>{props.hint}</p>}
      {props.children({ id: props.id, 'aria-invalid': Boolean(props.error), 'aria-describedby': describedBy })}
      {props.error && <p className="error" id={errId}>{props.error}</p>}
    </div>
  );
}
