import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/theme.css';
import './styles/app.css';
import './styles/editor.css';
import './styles/linking.css';
import './styles/import.css';
import './styles/history.css';
import './styles/ai.css';
import './styles/graph.css';
import './styles/journal.css';
import './styles/tasks.css';
import './styles/ask.css';
import './styles/chat.css';
import './styles/layouts.css';
import './styles/assistant.css';
import './styles/models.css';
import './styles/colors.css';
import './styles/shared.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { Root } from './App';
import { ApiError } from './lib/api';
import './lib/install';
import { registerSW } from 'virtual:pwa-register';

// The service worker serves the app from its cache. After an update, the first load would
// still run the previous version against the new server, so the page reloads as soon as the
// new version has taken over (once, right after opening; edits are saved before unloading).
// The browser may install the update before the registration code runs, so the takeover is
// watched directly rather than through the registration's events.
if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}
registerSW({ immediate: true });

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Root />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
