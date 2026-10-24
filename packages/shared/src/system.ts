/** Version, build and runtime facts for Settings → About (GET /api/system). */
export interface SystemInfo {
  /** Release version, e.g. "0.1.0". */
  version: string;
  build: {
    /** Branch or tag the image was built from ("main", "develop", "v0.1.0"); null for local builds. */
    ref: string | null;
    commit: string | null;
    /** ISO date of the CI pipeline. */
    date: string | null;
  };
  server: {
    node: string;
    os: string;
    arch: string;
    /** Running in a container. */
    docker: boolean;
    /** Seconds since the server started. */
    uptime: number;
  };
  database: {
    sqlite: string;
    /** Bytes. */
    size: number;
    migrations: number;
  };
  /** The signed-in user's data. */
  data: {
    notebooks: number;
    pages: number;
    attachments: number;
    attachmentBytes: number;
    versions: number;
    trash: number;
  };
  dataDir: string;
}
