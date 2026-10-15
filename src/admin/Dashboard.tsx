import { useCallback, useEffect, useState } from 'react';
import type { StatsResult } from '../../supabase/functions/_shared/api.ts';
import { admin } from '../lib/api';
import { formatDateTimeIST } from '../lib/format';
import { useAdmin } from './context';

export function Dashboard() {
  const { onError } = useAdmin();
  const [stats, setStats] = useState<StatsResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    admin.stats().then(setStats).catch((e: unknown) => setError(onError(e)));
  }, [onError]);
  useEffect(load, [load]);

  if (error) return <div className="card" role="alert"><p>{error}</p><button className="btn" onClick={load}>Retry</button></div>;
  if (!stats) return <p className="card" role="status">Loading dashboard…</p>;

  const tiles: [string, number, string][] = [
    ['Total registrations', stats.total, '/admin/registrations'],
    ['Pending payment proofs', stats.pending, '/admin/registrations?status=pending'],
    ['Verified payments', stats.verified, '/admin/registrations?status=verified'],
    ['Rejected payments', stats.rejected, '/admin/registrations?status=rejected'],
    ['Need attention', stats.attention, '/admin/registrations?status=rejected'],
  ];

  return (
    <>
      <div className="row-between">
        <h1>Dashboard</h1>
        <button className="btn btn-secondary" onClick={load}>Refresh</button>
      </div>
      <p className="hint">Live counts from the database · updated {formatDateTimeIST(stats.generatedAt)}</p>
      <ul className="tiles">
        {tiles.map(([label, n, href]) => (
          <li key={label} className="tile"><a href={`#${href}`}><span className="tile-n">{n}</span><span>{label}</span></a></li>
        ))}
      </ul>
      <p className="hint">“Need attention” = rejected payments, plus pending proofs older than {stats.staleHours} hours ({stats.stalePending} pending-overdue).</p>

      <div className="grid-2">
        <section className="card">
          <h2>By class</h2>
          <table>
            <thead><tr><th>Class</th><th>Shift</th><th className="num">Registrations</th></tr></thead>
            <tbody>
              {stats.byClass.map((c) => (
                <tr key={c.classLevel}><td>Class {c.classLevel}</td><td>Shift {c.shift}</td><td className="num">{c.count}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card">
          <h2>By school</h2>
          {stats.bySchool.length === 0 ? <p>No registrations yet.</p> : (
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Registrations by school">
              <table>
                <thead><tr><th>School</th><th className="num">Registrations</th></tr></thead>
                <tbody>{stats.bySchool.map((s) => <tr key={s.school}><td>{s.school}</td><td className="num">{s.count}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
