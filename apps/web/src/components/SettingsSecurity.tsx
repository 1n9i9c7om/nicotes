import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCircle2, Copy, Download, Fingerprint, ShieldCheck, XCircle } from 'lucide-react';
import type { Passkey, RecoveryCodes, SecurityStatus, TotpSetup } from '@nicotes/shared';
import { api, ApiError } from '../lib/api';
import { timeAgo } from '../lib/format';
import { deviceName } from '../lib/device';
import { createPasskey, passkeysSupported } from '../lib/passkeys';
import { useAuthStatus } from '../lib/queries';

const securityKey = ['security'] as const;

/** Something to do once the password has been entered again. */
type Guard = (what: string, run: () => void) => void;

const dateOf = (time: number) => new Date(time).toLocaleDateString('en', { dateStyle: 'medium' });

/**
 * Settings card: two-step sign-in with an authenticator app, and passkeys. Changes need the
 * password again (the server keeps that for 10 minutes), so an unattended session cannot
 * lock the owner out.
 */
export function SettingsSecurity() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: securityKey, queryFn: () => api.get<SecurityStatus>('/security') });
  const [waiting, setWaiting] = useState<{ what: string; run: () => void } | null>(null);

  const guard: Guard = (what, run) => (status.data?.confirmed ? run() : setWaiting({ what, run }));
  /** A 403 means the confirmation ran out while the page was open: ask again, then retry. */
  const locked = (err: Error, what: string, retry: () => void) => {
    if (err instanceof ApiError && err.status === 403) {
      void qc.invalidateQueries({ queryKey: securityKey });
      setWaiting({ what, run: retry });
      return true;
    }
    return false;
  };

  return (
    <section className="settings-card" id="security">
      <h2>
        <ShieldCheck size={18} /> Sign-in security
      </h2>
      <p className="muted">
        Keep your notes safe even if your password leaks. API tokens and calendar addresses are not affected: they keep
        working on their own.
      </p>

      {waiting && (
        <ConfirmPassword
          what={waiting.what}
          onConfirmed={async () => {
            await qc.invalidateQueries({ queryKey: securityKey });
            const run = waiting.run;
            setWaiting(null);
            run();
          }}
          onCancel={() => setWaiting(null)}
        />
      )}

      {status.data && (
        <>
          <TotpSetting status={status.data} guard={guard} locked={locked} />
          <PasskeySetting passkeys={status.data.passkeys} guard={guard} locked={locked} />
        </>
      )}
    </section>
  );
}

function ConfirmPassword({ what, onConfirmed, onCancel }: { what: string; onConfirmed: () => Promise<void>; onCancel: () => void }) {
  const [password, setPassword] = useState('');
  const confirm = useMutation({
    mutationFn: () => api.post('/security/confirm', { password }),
    onSuccess: onConfirmed,
    onError: () => setPassword(''),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    confirm.mutate();
  };
  return (
    <form className="token-created" onSubmit={submit}>
      <p>Enter your password to {what}.</p>
      <div className="setting-row">
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          aria-label="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button className="btn btn-primary" disabled={!password || confirm.isPending}>
          Continue
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {confirm.error && (
        <p className="check fail">
          <XCircle size={15} /> {confirm.error.message}
        </p>
      )}
    </form>
  );
}

type Locked = (err: Error, what: string, retry: () => void) => boolean;

function TotpSetting({ status, guard, locked }: { status: SecurityStatus; guard: Guard; locked: Locked }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: securityKey });
  const [code, setCode] = useState('');
  const [qr, setQr] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [turningOff, setTurningOff] = useState(false);

  const start = useMutation({
    mutationFn: () => api.post<TotpSetup>('/security/totp'),
    onError: (err) => locked(err, 'set up two-step sign-in', () => start.mutate()),
  });
  const enable = useMutation({
    mutationFn: () => api.post<RecoveryCodes>('/security/totp/enable', { code }),
    onSuccess: (r) => {
      setCodes(r.codes);
      start.reset();
      setCode('');
      void refresh();
    },
    onError: (err) => locked(err, 'turn on two-step sign-in', () => enable.mutate()),
  });
  const renew = useMutation({
    mutationFn: () => api.post<RecoveryCodes>('/security/recovery-codes'),
    onSuccess: (r) => {
      setCodes(r.codes);
      void refresh();
    },
    onError: (err) => locked(err, 'create new recovery codes', () => renew.mutate()),
  });
  const disable = useMutation({
    mutationFn: () => api.delete('/security/totp'),
    onSuccess: () => {
      setTurningOff(false);
      setCodes(null);
      void refresh();
    },
    onError: (err) => locked(err, 'turn off two-step sign-in', () => disable.mutate()),
  });

  const setup = start.data;
  useEffect(() => {
    if (!setup) return setQr(null);
    let live = true;
    // Loaded on demand: only needed for this one screen.
    void import('qrcode')
      .then((qrcode) => qrcode.toDataURL(setup.uri, { margin: 1, width: 200 }))
      .then((url) => live && setQr(url));
    return () => {
      live = false;
    };
  }, [setup]);

  const { enabled, enabledAt } = status.totp;
  const error = start.error ?? enable.error ?? renew.error ?? disable.error;

  return (
    <div className="setting">
      <span className="setting-label">Two-step sign-in</span>
      <p className="setting-hint">
        After your password, Nicotes asks for a 6-digit code from an authenticator app on your phone, such as Google
        Authenticator, Microsoft Authenticator, Aegis or 2FAS.
      </p>

      {codes && <RecoveryCodeList codes={codes} onDone={() => setCodes(null)} />}

      {setup ? (
        <form
          className="totp-setup"
          onSubmit={(e) => {
            e.preventDefault();
            enable.mutate();
          }}
        >
          <div className="totp-qr">{qr ? <img src={qr} alt="QR code for your authenticator app" /> : null}</div>
          <div className="totp-steps">
            <p>
              <strong>1.</strong> Scan the code with your authenticator app, or enter this key by hand:
            </p>
            <code className="totp-secret">{setup.secret.match(/.{1,4}/g)?.join(' ')}</code>
            {window.matchMedia('(pointer: coarse)').matches && (
              // A phone cannot scan its own screen; authenticator apps open otpauth:// links.
              <p className="setting-hint">
                On this phone? <a href={setup.uri}>Open it in your authenticator app</a>.
              </p>
            )}
            <p>
              <strong>2.</strong> Enter the 6-digit code the app shows:
            </p>
            <div className="setting-row">
              <input
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="123456"
                aria-label="Code from the app"
                className="totp-code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
              <button className="btn btn-primary" disabled={code.length !== 6 || enable.isPending}>
                Turn on
              </button>
              <button type="button" className="btn" onClick={() => start.reset()}>
                Cancel
              </button>
            </div>
          </div>
        </form>
      ) : enabled ? (
        <>
          <p className="check ok">
            <CheckCircle2 size={15} /> On since {dateOf(enabledAt!)}
            {' · '}
            {status.recoveryCodesLeft === 1 ? '1 recovery code left' : `${status.recoveryCodesLeft} recovery codes left`}
          </p>
          {status.recoveryCodesLeft <= 2 && (
            <p className="setting-hint">Running low on recovery codes: create new ones and keep them somewhere safe.</p>
          )}
          <div className="setting-actions">
            <button className="btn" disabled={renew.isPending} onClick={() => guard('create new recovery codes', () => renew.mutate())}>
              New recovery codes
            </button>
            {turningOff ? (
              <span className="token-confirm">
                <button
                  className="btn btn-danger"
                  disabled={disable.isPending}
                  onClick={() => guard('turn off two-step sign-in', () => disable.mutate())}
                >
                  Turn off now
                </button>
                <button className="btn" onClick={() => setTurningOff(false)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button className="btn" onClick={() => setTurningOff(true)}>
                Turn off
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="setting-actions">
          <button
            className="btn btn-primary"
            disabled={start.isPending}
            onClick={() => {
              setCodes(null);
              guard('set up two-step sign-in', () => start.mutate());
            }}
          >
            Set up
          </button>
        </div>
      )}

      {error && !(error instanceof ApiError && error.status === 403) && (
        <p className="check fail">
          <XCircle size={15} /> {error.message}
        </p>
      )}
    </div>
  );
}

/** Fresh recovery codes, shown once: copy, download, or write them down. */
function RecoveryCodeList({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const username = useAuthStatus().data?.user?.username ?? '';
  const [copied, setCopied] = useState(false);
  const text = [
    `Nicotes recovery codes for ${username} at ${window.location.host}`,
    'Each code signs in once in place of the authenticator app.',
    '',
    ...codes,
    '',
    `Created ${new Date().toLocaleString('en')}`,
    '',
  ].join('\n');
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'nicotes-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="token-created" role="status">
      <p>
        <strong>Save your recovery codes.</strong> If your phone is lost, each one signs in once in place of a code. They
        won't be shown again.
      </p>
      <ul className="recovery-codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="setting-actions">
        <button type="button" className="btn" onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}>
          {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="btn" onClick={download}>
          <Download size={14} /> Download
        </button>
        <button type="button" className="link-btn" onClick={onDone}>
          I've saved them
        </button>
      </div>
    </div>
  );
}

function PasskeySetting({ passkeys, guard, locked }: { passkeys: Passkey[]; guard: Guard; locked: Locked }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: securityKey });
  const [name, setName] = useState(deviceName);
  const [confirming, setConfirming] = useState<string | null>(null);
  const supported = passkeysSupported();

  const add = useMutation({
    mutationFn: () => createPasskey(name.trim()),
    onSuccess: () => {
      setName(deviceName());
      void refresh();
    },
    onError: (err) => locked(err, 'add a passkey', () => add.mutate()),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/security/passkeys/${id}`),
    onSettled: () => {
      setConfirming(null);
      void refresh();
    },
    onError: (err, id) => locked(err, 'remove the passkey', () => remove.mutate(id)),
  });
  const error = add.error ?? remove.error;

  return (
    <div className="setting" id="passkeys">
      <span className="setting-label">Passkeys</span>
      <p className="setting-hint">
        Sign in with your fingerprint, face or screen lock instead of a password and code. A passkey only works at the
        address it was made at ({window.location.hostname}).
      </p>

      {passkeys.length > 0 && (
        <ul className="trash-list">
          {passkeys.map((p) => (
            <li key={p.id} className="trash-item">
              <div className="trash-info">
                <span className="trash-title">{p.name}</span>
                <span className="trash-meta">
                  {p.backedUp ? 'Synced between devices' : 'On one device'} · added {dateOf(p.createdAt)} ·{' '}
                  {p.lastUsedAt ? `last used ${timeAgo(p.lastUsedAt)}` : 'never used'}
                </span>
              </div>
              {confirming === p.id ? (
                <span className="token-confirm">
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={remove.isPending}
                    onClick={() => guard('remove the passkey', () => remove.mutate(p.id))}
                  >
                    Remove now
                  </button>
                  <button className="btn btn-sm" onClick={() => setConfirming(null)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button className="btn btn-sm" onClick={() => setConfirming(p.id)}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {supported ? (
        <form
          className="setting-row"
          onSubmit={(e) => {
            e.preventDefault();
            guard('add a passkey', () => add.mutate());
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label="Passkey name" />
          <button className="btn" disabled={!name.trim() || add.isPending}>
            <Fingerprint size={15} /> Add a passkey
          </button>
        </form>
      ) : (
        <p className="setting-hint">
          {window.isSecureContext ? 'This browser does not support passkeys.' : 'Passkeys need Nicotes to be opened over HTTPS.'}
        </p>
      )}

      {error && !(error instanceof ApiError && error.status === 403) && (
        <p className="check fail">
          <XCircle size={15} /> {error.message}
        </p>
      )}
    </div>
  );
}
