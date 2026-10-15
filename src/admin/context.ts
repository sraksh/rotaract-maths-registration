import { createContext, useContext } from 'react';

export interface AdminContextValue {
  email: string | null;
  /** Converts any error into a safe message; signs the user out on 401/403. */
  onError: (e: unknown) => string;
}

export const AdminContext = createContext<AdminContextValue | null>(null);

export function useAdmin(): AdminContextValue {
  const v = useContext(AdminContext);
  if (!v) throw new Error('useAdmin outside AdminApp');
  return v;
}
