import { useEffect, useState } from 'react';

/**
 * Hash routing (#/admin/...). GitHub Pages only serves real files, so a reload or a
 * deep link to a path route would 404; hash routes always load index.html.
 */
export function currentPath(): string {
  const h = window.location.hash.replace(/^#/, '');
  const path = h.split('?')[0] ?? '';
  return path === '' ? '/' : path.startsWith('/') ? path : `/${path}`;
}

export function usePath(): string {
  const [path, setPath] = useState(currentPath());
  useEffect(() => {
    const on = () => setPath(currentPath());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return path;
}

export function navigate(path: string): void {
  window.location.hash = path;
}
