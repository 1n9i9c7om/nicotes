import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Fingerprint } from 'lucide-react';
import { isTwoFactorChallenge, type TwoFactorChallenge, type User } from '@nicotes/shared';
import logo from '../logo.svg';
import { api } from '../lib/api';
import { passkeysSupported, signInWithPasskey } from '../lib/passkeys';
import { useFinishSignIn, useSignIn } from '../lib/queries';

export function Login({ mode }: { mode: 'login' | 'setup' }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<TwoFactorChallenge | null>(null);
  const signIn = useSignIn(mode);
  const finish = useFinishSignIn();
  const passkey = useMutation({ mutationFn: () => signInWithPasskey(), onSuccess: finish });
  const setup = mode === 'setup';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    passkey.reset();
    signIn.mutate({ username, password }, { onSuccess: (r) => isTwoFactorChallenge(r) && setChallenge(r) });
  };

  if (challenge) {
    return (
      <SecondStep
        challenge={challenge}
        onBack={() => {
          setChallenge(null);
          setPassword('');
          signIn.reset();
        }}
      />
    );
  }

  const error = signIn.error ?? passkey.error;
  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <img src={logo} alt="" className="auth-logo" />
        <h1>{setup ? 'Welcome to Nicotes' : 'Sign in to Nicotes'}</h1>
        {setup && <p className="muted">Create your account to get started.</p>}

        <label className="field">
          <span>Username</span>
          <input
            autoFocus
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete={setup ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={setup ? 8 : undefined}
            required
          />
        </label>

        {error && <p className="error">{error.message}</p>}

        <button className="btn btn-primary btn-block" disabled={signIn.isPending}>
          {setup ? 'Create account' : 'Sign in'}
        </button>

        {!setup && passkeysSupported() && (
          <>
            <div className="auth-or">or</div>
            <button
              type="button"
              className="btn btn-block"
              disabled={passkey.isPending}
              onClick={() => {
                signIn.reset();
                passkey.mutate();
              }}
            >
              <Fingerprint size={16} /> Sign in with a passkey
            </button>
          </>
        )}
      </form>
    </div>
  );
}

/** After the password: a code from the authenticator app, a recovery code, or a passkey. */
function SecondStep({ challenge, onBack }: { challenge: TwoFactorChallenge; onBack: () => void }) {
  const finish = useFinishSignIn();
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const submitCode = useMutation({
    mutationFn: () => api.post<User>('/auth/login/code', { ticket: challenge.ticket, code }),
    onSuccess: finish,
    onError: () => setCode(''),
  });
  const passkey = useMutation({ mutationFn: () => signInWithPasskey(challenge.ticket), onSuccess: finish });
  const error = submitCode.error ?? passkey.error;
  // A lost ticket (too slow, too many wrong codes) means starting over with the password.
  const expired = error && /took too long/.test(error.message);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    passkey.reset();
    submitCode.mutate();
  };

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <img src={logo} alt="" className="auth-logo" />
        <h1>Two-step sign-in</h1>
        <p className="muted">
          {recovery
            ? 'Enter one of the recovery codes you saved when you set up two-step sign-in. Each code works once.'
            : 'Enter the 6-digit code from your authenticator app.'}
        </p>

        <label className="field">
          <span>{recovery ? 'Recovery code' : 'Code'}</span>
          <input
            key={recovery ? 'recovery' : 'code'}
            autoFocus
            autoComplete="one-time-code"
            inputMode={recovery ? 'text' : 'numeric'}
            pattern={recovery ? undefined : '[0-9 ]{6,7}'}
            maxLength={recovery ? 40 : 7}
            placeholder={recovery ? 'xxxxx-xxxxx' : '123456'}
            className="auth-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
          />
        </label>

        {error && <p className="error">{error.message}</p>}

        {expired ? (
          <button type="button" className="btn btn-primary btn-block" onClick={onBack}>
            Back to the password
          </button>
        ) : (
          <button className="btn btn-primary btn-block" disabled={submitCode.isPending || !code.trim()}>
            Continue
          </button>
        )}

        {challenge.passkey && passkeysSupported() && !expired && (
          <button
            type="button"
            className="btn btn-block"
            disabled={passkey.isPending}
            onClick={() => {
              submitCode.reset();
              passkey.mutate();
            }}
          >
            <Fingerprint size={16} /> Use a passkey instead
          </button>
        )}

        <div className="auth-links">
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setRecovery(!recovery);
              setCode('');
              submitCode.reset();
            }}
          >
            {recovery ? 'Use the authenticator app' : 'Use a recovery code'}
          </button>
          <button type="button" className="link-btn" onClick={onBack}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
