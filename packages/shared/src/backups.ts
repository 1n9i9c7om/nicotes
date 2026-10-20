/**
 * Automatic backups: timestamped `.tar.gz` archives of the database, the attachments and the
 * secret key file, written by the server into its backup directory.
 */

export interface BackupInfo {
  /** File name in the backup directory, e.g. `nicotes-2026-10-20T03-15-00Z.tar.gz`. */
  name: string;
  createdAt: number;
  size: number;
}

export interface BackupStatus {
  /** Backup directory as the server sees it (in Docker a container path such as /backups). */
  dir: string;
  /** Hours between automatic backups; 0 when automatic backups are off. */
  intervalHours: number;
  keepDaily: number;
  keepWeekly: number;
  running: boolean;
  /** When the next automatic backup is due (null when they are off). */
  nextAt: number | null;
  /** The last failed attempt, cleared by the next successful backup. */
  lastError: { at: number; message: string } | null;
  /** Newest first. */
  backups: BackupInfo[];
}
