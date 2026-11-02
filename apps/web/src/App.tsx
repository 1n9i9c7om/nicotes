import { lazy, Suspense, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { AppShell } from './components/AppShell';
import { ApiError } from './lib/api';
import { keys, useAuthStatus } from './lib/queries';
import { Home } from './pages/Home';
import { Login } from './pages/Login';
import { NotebookView } from './pages/NotebookView';
import { NotFound } from './pages/NotFound';
import { PageView } from './pages/PageView';
import { ImportPage } from './pages/ImportPage';
import { JournalPage } from './pages/JournalPage';
import { OrganizePage } from './pages/OrganizePage';
import { ResearchPage } from './pages/ResearchPage';
import { SettingsPage } from './pages/SettingsPage';
import { SharePage } from './pages/SharePage';
import { SharedView } from './pages/SharedView';
import { TagView } from './pages/TagView';
import { TasksPage } from './pages/TasksPage';
import { ChatPage } from './pages/ChatPage';

// force-graph is large; the graph page loads on demand.
const GraphPage = lazy(() => import('./pages/GraphPage').then((m) => ({ default: m.GraphPage })));
import { TrashPage } from './pages/TrashPage';

/** Shared links open without an account; everything else is the app behind the sign-in. */
export function Root() {
  return (
    <Routes>
      <Route path="s/:token/:pageId?" element={<SharedView />} />
      <Route path="*" element={<App />} />
    </Routes>
  );
}

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
        <Route path="settings/:tab?" element={<SettingsPage />} />
        <Route path="trash" element={<TrashPage />} />
        <Route path="share" element={<SharePage />} />
        <Route path="research" element={<ResearchPage />} />
        <Route path="organize" element={<OrganizePage />} />
        <Route path="journal" element={<JournalPage />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="chat" element={<ChatPage />} />
        <Route path="ask" element={<AskRedirect />} />
        <Route
          path="graph"
          element={
            <Suspense fallback={null}>
              <GraphPage />
            </Suspense>
          }
        />
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

/** "Ask your notes" became the chat; old links and bookmarks still work. */
function AskRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/chat${search}`} replace />;
}
