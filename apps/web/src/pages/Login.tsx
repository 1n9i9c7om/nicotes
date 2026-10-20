import { useState, type FormEvent } from 'react';
import logo from '../logo.svg';
import { useSignIn } from '../lib/queries';

export function Login({ mode }: { mode: 'login' | 'setup' }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const signIn = useSignIn(mode);
  const setup = mode === 'setup';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    signIn.mutate({ username, password });
  };

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

        {signIn.error && <p className="error">{signIn.error.message}</p>}

        <button className="btn btn-primary btn-block" disabled={signIn.isPending}>
          {setup ? 'Create account' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
