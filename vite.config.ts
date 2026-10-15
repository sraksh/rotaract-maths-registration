import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * GitHub Pages serves a project site from https://<owner>.github.io/<repo>/.
 * Set VITE_BASE_PATH=/<repo>/ for that case (the CI workflow does this
 * automatically). Use VITE_BASE_PATH=/ for a custom domain or a root site.
 *
 * The app uses hash-based routing (#/admin ...), so a reload or a deep link
 * always loads index.html and no server-side rewrite rules are required.
 */
export function normaliseBase(raw: string | undefined): string {
  let base = (raw ?? '').trim();
  if (base === '' || base === '.' || base === './') return '/';
  if (!base.startsWith('/')) base = `/${base}`;
  if (!base.endsWith('/')) base = `${base}/`;
  return base;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    base: normaliseBase(env.VITE_BASE_PATH ?? process.env.VITE_BASE_PATH),
    plugins: [react()],
    build: { target: 'es2020', sourcemap: false },
  };
});
