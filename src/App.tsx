import { lazy, Suspense, useEffect } from 'react';
import { usePath } from './lib/router';
import { backendConfigured, secretKeyDetected } from './lib/env';
import { RegisterPage } from './pages/RegisterPage';
// The admin area (tables, export code) is only downloaded when /admin is opened.
const AdmitCardPage = lazy(() => import('./pages/AdmitCardPage').then((m) => ({ default: m.AdmitCardPage })));
const AdminApp = lazy(() => import('./admin/AdminApp').then((m) => ({ default: m.AdminApp })));

function SetupNotice({ secret }: { secret: boolean }) {
  return (
    <main className="shell">
      <div className="card" role="alert">
        <h1>{secret ? 'Unsafe configuration' : 'Registration is not available yet'}</h1>
        <p>
          {secret
            ? 'A secret (service-role) key was supplied to the public build. It has been ignored. Rebuild using only the publishable key.'
            : 'This site has not been connected to its registration service yet. Please check back later or contact the organisers.'}
        </p>
      </div>
    </main>
  );
}

export function App() {
  const path = usePath();
  const isAdmin = path === '/admin' || path.startsWith('/admin/');
  const isAdmit = path === '/admit-card';

  useEffect(() => {
    window.scrollTo(0, 0);
    document.title = isAdmin
      ? 'Admin — Rotaract Maths Registration 2026'
      : isAdmit
        ? 'Admit card — 34th Padmabai Rungta Mathematics Competition 2026'
        : 'Registration — 34th Padmabai Rungta Mathematics Competition 2026';
  }, [path, isAdmin, isAdmit]);

  if (secretKeyDetected) return <SetupNotice secret />;
  if (!backendConfigured) return <SetupNotice secret={false} />;
  if (isAdmin || isAdmit) {
    return (
      <Suspense fallback={<main className="shell"><p className="card" role="status">Loading…</p></main>}>
        {isAdmin ? <AdminApp path={path} /> : <AdmitCardPage />}
      </Suspense>
    );
  }
  return <RegisterPage />;
}
