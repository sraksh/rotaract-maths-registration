import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { ApiError, admin } from '../lib/api';
import { getSupabase } from '../lib/supabase';
import { navigate } from '../lib/router';
import { AdminContext } from './context';
import { Dashboard } from './Dashboard';
import { Registrations } from './Registrations';
import { RegistrationDetailPage } from './RegistrationDetailPage';
import { Reports } from './Reports';
import { Settings } from './Settings';

type Gate = 'checking' | 'ok' | 'forbidden';

function Login({ notice }: { notice: string | null }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await getSupabase().auth.signInWithPassword({ email: email.trim(), password });
      // Deliberately generic: do not reveal whether the account exists.
      if (err) setError(/fetch|network/i.test(err.message) ? 'Could not reach the server. Please try again.' : 'Incorrect email or password.');
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell narrow">
      <form className="card form" onSubmit={submit} noValidate>
        <h1>Administrator sign-in</h1>
        <p className="hint">Authorised organisers only. Accounts are created by the system operator.</p>
        {(notice || error) && <p className="notice notice-warn" role="alert">{error ?? notice}</p>}
        <div className="field">
          <label htmlFor="a-email">Email</label>
          <input id="a-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="a-pass">Password</label>
          <input id="a-pass" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <button className="btn btn-primary btn-block" disabled={busy || !email || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="hint"><a href="#/">← Back to registration</a></p>
      </form>
    </main>
  );
}

export function AdminApp({ path }: { path: string }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [gate, setGate] = useState<Gate>('checking');
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const sb = getSupabase();
    void sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = sb.auth.onAuthStateChange((_evt, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  const signOut = useCallback(async (msg?: string) => {
    if (msg) setNotice(msg);
    await getSupabase().auth.signOut().catch(() => undefined);
    setSession(null);
  }, []);

  // The role check is enforced by the Edge Function on EVERY call; this probe only
  // decides which screen to show.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setGate('checking');
    admin
      .stats()
      .then(() => !cancelled && (setGate('ok'), setNotice(null)))
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.code === 'FORBIDDEN') setGate('forbidden');
        else if (e instanceof ApiError && e.code === 'UNAUTHENTICATED') void signOut('Your session has expired. Please sign in again.');
        else setGate('ok'); // transient failure: pages show their own error + retry
      });
    return () => {
      cancelled = true;
    };
  }, [session, signOut]);

  const ctx = useMemo(
    () => ({
      email: session?.user.email ?? null,
      onError: (e: unknown): string => {
        if (e instanceof ApiError) {
          if (e.code === 'UNAUTHENTICATED') void signOut('Your session has expired. Please sign in again.');
          if (e.code === 'FORBIDDEN') setGate('forbidden');
          return e.message;
        }
        return 'Something went wrong. Please try again.';
      },
    }),
    [session, signOut],
  );

  if (session === undefined) return <main className="shell"><p className="card" role="status">Loading…</p></main>;
  if (!session) return <Login notice={notice} />;
  if (gate === 'forbidden') {
    return (
      <main className="shell narrow">
        <div className="card" role="alert">
          <h1>Not authorised</h1>
          <p>This account is signed in but is not an administrator. Ask the system operator to grant access.</p>
          <button className="btn" onClick={() => void signOut()}>Sign out</button>
        </div>
      </main>
    );
  }

  const nav: [string, string][] = [
    ['/admin', 'Dashboard'],
    ['/admin/registrations', 'Registrations'],
    ['/admin/reports', 'Reports'],
    ['/admin/settings', 'Settings'],
  ];
  const active = (to: string) => (to === '/admin' ? path === '/admin' || path === '/admin/' : path.startsWith(to));
  const detailMatch = /^\/admin\/registrations\/(PRM34-[0-9A-F]{10})$/.exec(path);

  let page: React.ReactNode;
  if (gate === 'checking') page = <p className="card" role="status">Checking access…</p>;
  else if (detailMatch) page = <RegistrationDetailPage key={detailMatch[1]} registrationId={detailMatch[1]!} />;
  else if (path.startsWith('/admin/registrations')) page = <Registrations />;
  else if (path.startsWith('/admin/reports')) page = <Reports />;
  else if (path.startsWith('/admin/settings')) page = <Settings />;
  else if (path === '/admin' || path === '/admin/') page = <Dashboard />;
  else {
    navigate('/admin');
    page = null;
  }

  return (
    <AdminContext.Provider value={ctx}>
      <div className="admin">
        <header className="admin-bar no-print">
          <strong>Rungta Maths 2026 · Admin</strong>
          <nav aria-label="Admin sections">
            {nav.map(([to, label]) => (
              <a key={to} href={`#${to}`} aria-current={active(to) ? 'page' : undefined}>{label}</a>
            ))}
          </nav>
          <span className="who">{ctx.email}</span>
          <button className="btn btn-secondary" onClick={() => void signOut()}>Sign out</button>
        </header>
        <main className="admin-main">{page}</main>
      </div>
    </AdminContext.Provider>
  );
}
