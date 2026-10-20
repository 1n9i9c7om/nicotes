import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Route, Routes } from 'react-router';
import { AppShell } from './components/AppShell';
import { ApiError } from './lib/api';
import { keys, useAuthStatus } from './lib/queries';
import { Home } from './pages/Home';
import { Login } from './pages/Login';
import { NotebookView } from './pages/NotebookView';
import { NotFound } from './pages/NotFound';
import { PageView } from './pages/PageView';
import { ImportPage } from './pages/ImportPage';
import { SettingsPage } from './pages/SettingsPage';
import { TagView } from './pages/TagView';

export function App() {
  const { data, isPending, isError, refetch } = useAuthStatus();
  useSessionExpiry();

  if (isPending) return <div className="splash" aria-busy="true" />;
  if (isError) {
    return (
      <div className="splash">
        <p>Nicotes can't reach the server.</p>
        <button className="btn" onClick={() => refetch()}>
          Try again
        </button>
      </div>
    );
  }
  if (!data.user) return <Login mode={data.setupRequired ? 'setup' : 'login'} />;

  return (
    <Routes>
      <Route element={<AppShell user={data.user} />}>
        <Route index element={<Home />} />
        <Route path="n/:notebookId" element={<NotebookView />} />
        <Route path="p/:pageId" element={<PageView />} />
        <Route path="t/:tagName" element={<TagView />} />
        <Route path="import" element={<ImportPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

/** Any 401 from the API means the session is gone: show the login screen. */
function useSessionExpiry() {
  const qc = useQueryClient();
  useEffect(() => {
    const onError = (error: unknown) => {
      if (error instanceof ApiError && error.status === 401) {
        qc.invalidateQueries({ queryKey: keys.auth });
      }
    };
    const unsubQueries = qc.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') onError(event.action.error);
    });
    const unsubMutations = qc.getMutationCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') onError(event.action.error);
    });
    return () => {
      unsubQueries();
      unsubMutations();
    };
  }, [qc]);
}
