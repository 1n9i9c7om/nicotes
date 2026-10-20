import { Link } from 'react-router';

export function NotFound({ what = 'Page' }: { what?: string }) {
  return (
    <div className="empty-state">
      <h2>{what} not found</h2>
      <p className="muted">It may have been deleted or moved.</p>
      <Link className="btn" to="/">
        Go home
      </Link>
    </div>
  );
}
