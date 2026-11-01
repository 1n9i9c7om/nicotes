import { Globe } from 'lucide-react';
import { Link } from 'react-router';
import { useShares } from '../lib/shares';
import { displayTitle } from '../lib/tree';
import { ShareLinkRow } from './ShareDialog';

/** Settings card: every read-only link, to copy or turn off in one place. */
export function SettingsShares() {
  const shares = useShares();
  const list = shares.data ?? [];
  return (
    <section className="settings-card" id="shared-links">
      <h2>
        <Globe size={18} /> Shared links
      </h2>
      <p className="muted">
        Read-only links to pages and notebooks, which anyone who has them can open without an account. Create one with
        Share… in a page's or notebook's ⋯ menu.
      </p>
      {list.length > 0 ? (
        <ul className="share-links">
          {list.map((s) => (
            <ShareLinkRow
              key={s.id}
              share={s}
              title={<Link to={s.kind === 'notebook' ? `/n/${s.targetId}` : `/p/${s.targetId}`}>{displayTitle(s.title)}</Link>}
            />
          ))}
        </ul>
      ) : (
        shares.isSuccess && <p className="setting-hint">Nothing is shared.</p>
      )}
    </section>
  );
}
