import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import { Menu as MenuIcon } from 'lucide-react';
import type { User } from '@nicotes/shared';
import { Sidebar } from './Sidebar';

export function AppShell({ user }: { user: User }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();

  // On narrow screens the sidebar is a drawer; close it whenever the user navigates.
  useEffect(() => setSidebarOpen(false), [location.pathname]);

  return (
    <div className={`shell${sidebarOpen ? ' sidebar-open' : ''}`}>
      <Sidebar user={user} onClose={() => setSidebarOpen(false)} />
      <div className="drawer-backdrop" onClick={() => setSidebarOpen(false)} />
      <main className="main">
        <div className="mobile-bar">
          <button className="icon-btn" aria-label="Open sidebar" onClick={() => setSidebarOpen(true)}>
            <MenuIcon size={20} />
          </button>
          <span className="sidebar-brand">Nicotes</span>
        </div>
        <Outlet />
      </main>
    </div>
  );
}
