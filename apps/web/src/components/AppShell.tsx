import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Outlet, useLocation } from 'react-router';
import { CloudOff, Menu as MenuIcon, Search, X } from 'lucide-react';
import type { User } from '@nicotes/shared';
import { dismissCopies, onOfflineSaved, startOfflineSync, useOfflineStatus } from '../lib/offline';
import { keys } from '../lib/queries';
import { CommandPalette } from './CommandPalette';
import { Sidebar } from './Sidebar';

export function AppShell({ user }: { user: User }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const location = useLocation();

  // A copy of the notes on this device (if switched on), and edits made offline sent later.
  const qc = useQueryClient();
  useEffect(() => startOfflineSync(user), [user.id]);
  useEffect(() => onOfflineSaved(() => void qc.invalidateQueries({ queryKey: keys.pages })), [qc]);

  // On narrow screens the sidebar is a drawer; close it whenever the user navigates.
  useEffect(() => setSidebarOpen(false), [location.pathname]);

  // Ctrl/Cmd+K opens the command palette from anywhere, including inside the editors.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={`shell${sidebarOpen ? ' sidebar-open' : ''}`}>
      <Sidebar user={user} onClose={() => setSidebarOpen(false)} onSearch={() => setSearchOpen(true)} />
      <div className="drawer-backdrop" onClick={() => setSidebarOpen(false)} />
      <main className="main">
        <div className="mobile-bar">
          <button className="icon-btn" aria-label="Open sidebar" onClick={() => setSidebarOpen(true)}>
            <MenuIcon size={20} />
          </button>
          <span className="sidebar-brand">Nicotes</span>
          <button className="icon-btn" aria-label="Search" onClick={() => setSearchOpen(true)}>
            <Search size={20} />
          </button>
        </div>
        <OfflineBanner />
        <Outlet />
      </main>
      {searchOpen && <CommandPalette onClose={() => setSearchOpen(false)} />}
    </div>
  );
}

/** Says when Nicotes works from this device's copy, and what happened to offline edits. */
function OfflineBanner() {
  const offline = useOfflineStatus();
  if (offline.copies.length) {
    return (
      <div className="banner banner-warning offline-banner" role="alert">
        <span>
          Your offline edits of {offline.copies.map((t) => `“${t}”`).join(', ')} clashed with changes made elsewhere. They are kept as
          a subpage “… (offline copy)”.
        </span>
        <button className="icon-btn" aria-label="Dismiss" onClick={dismissCopies}>
          <X size={16} />
        </button>
      </div>
    );
  }
  if (offline.online) return null;
  return (
    <div className="banner offline-banner" role="status">
      <CloudOff size={16} />
      <span>
        {offline.enabled
          ? `Offline: showing the notes saved on this device. Edits to pages are kept and sent when the server is back${offline.pending ? ` (${offline.pending} waiting)` : ''}.`
          : 'Offline: Nicotes cannot reach the server. Keep notes on this device (Settings → App) to read and edit them offline.'}
      </span>
    </div>
  );
}
