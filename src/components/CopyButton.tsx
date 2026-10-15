import { useState } from 'react';

export function CopyButton({ text, label = 'Copy', copiedLabel = 'Copied' }: { text: string; label?: string; copiedLabel?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      // Fallback for older browsers / insecure contexts.
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        setState(ok ? 'copied' : 'failed');
      } catch {
        setState('failed');
      }
    }
    setTimeout(() => setState('idle'), 2500);
  }
  return (
    <>
      <button type="button" className="btn btn-secondary" onClick={copy}>
        {state === 'copied' ? copiedLabel : state === 'failed' ? 'Copy failed — select and copy manually' : label}
      </button>
      <span className="sr-only" role="status" aria-live="polite">{state === 'copied' ? 'Copied to clipboard' : ''}</span>
    </>
  );
}
