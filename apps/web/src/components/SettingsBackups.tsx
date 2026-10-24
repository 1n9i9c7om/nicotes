import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DatabaseBackup, FileDown, XCircle } from 'lucide-react';
import type { BackupInfo, BackupStatus } from '@nicotes/shared';
import { api } from '../lib/api';
import { formatSize, timeAgo } from '../lib/format';

const statusKey = ['backups'] as const;

/** "in about 5 hours" for a future time. */
const timeUntil = (time: number) => (time <= Date.now() ? 'soon' : timeAgo(time));

function schedule(s: BackupStatus): string {
  const every = s.intervalHours === 24 ? 'Daily' : `Every ${s.intervalHours} hours,`;
  return `${every} kept for ${s.keepDaily} days and ${s.keepWeekly} weeks.`;
}

/** Settings card: automatic backups of the whole instance, "Back up now" and recent archives. */
export function SettingsBackups() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: statusKey, queryFn: () => api.get<BackupStatus>('/backups') });
  const backUp = useMutation({
    mutationFn: () => api.post<BackupInfo>('/backups'),
    onSettled: () => qc.invalidateQueries({ queryKey: statusKey }),
  });
  const s = status.data;
  if (!s) return null;
  const error = backUp.error?.message ?? (s.lastError && `Last automatic backup failed ${timeAgo(s.lastError.at)}: ${s.lastError.message}`);

  return (
    <section className="settings-card" id="backups">
      <h2>
        <DatabaseBackup size={18} /> Backups
      </h2>
      <p className="muted">
        A complete copy of all notebooks, history, attachments and the key for stored API keys, which can be restored on
        the server (see “Backups” in the README).{' '}
        {s.intervalHours > 0 ? schedule(s) : 'Automatic backups are off (NICOTES_BACKUP_INTERVAL_HOURS=0).'}
      </p>
      <p className="setting-hint">
        Stored on the server in <code>{s.dir}</code>. Backups contain everything, so keep them somewhere safe — ideally
        on another disk or a NAS.
      </p>
      <div className="setting-actions">
        <button className="btn btn-primary" disabled={backUp.isPending || s.running} onClick={() => backUp.mutate()}>
          <DatabaseBackup size={15} /> {backUp.isPending || s.running ? 'Backing up…' : 'Back up now'}
        </button>
        {s.nextAt !== null && !backUp.isPending && <span className="muted">Next automatic backup {timeUntil(s.nextAt)}</span>}
      </div>
      {error && (
        <p className="check fail">
          <XCircle size={15} /> {error}
        </p>
      )}
      {s.backups.length > 0 && (
        <div className="setting">
          <span className="setting-label">Latest backups</span>
          <ul className="trash-list">
            {s.backups.slice(0, 6).map((b) => (
              <li key={b.name} className="trash-item">
                <div className="trash-info">
                  <span className="trash-title" title={b.name}>
                    {new Date(b.createdAt).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' })}
                  </span>
                  <span className="trash-meta">
                    {timeAgo(b.createdAt)} · {formatSize(b.size)}
                  </span>
                </div>
                <a className="btn btn-sm" href={`/api/backups/${encodeURIComponent(b.name)}`} download>
                  <FileDown size={14} /> Download
                </a>
              </li>
            ))}
          </ul>
          {s.backups.length > 6 && <p className="setting-hint">{s.backups.length - 6} older backups in the folder.</p>}
        </div>
      )}
    </section>
  );
}
