import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import { Menu as MenuIcon, Search } from 'lucide-react';
import type { User } from '@nicotes/shared';
import { CommandPalette } from './CommandPalette';
import { Sidebar } from './Sidebar';

export function AppShell({ user }: { user: User }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const location = useLocation();

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
        <Outlet />
      </main>
      {searchOpen && <CommandPalette onClose={() => setSearchOpen(false)} />}
    </div>
  );
}
