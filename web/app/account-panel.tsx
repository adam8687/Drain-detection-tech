'use client';

import { useState } from 'react';
import { DrainApi, DrainApiError } from '../lib/api';
import { supabase, useSession } from '../lib/supabase';

const baseUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';

export default function AccountPanel() {
  const session = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [name, setName] = useState('');
  const [newKey, setNewKey] = useState<{ device_id: string; key: string } | null>(null);

  if (!supabase) return <p>Sign-in is off. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in web/.env.local.</p>;
  const auth = supabase.auth;

  if (!session) return <section aria-label="Account">
    <h2>Sign in</h2>
    <form onSubmit={async event => {
      event.preventDefault();
      const { error } = await auth.signInWithPassword({ email, password });
      setMessage(error ? error.message : '');
    }}>
      <label>Email <input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} /></label>{' '}
      <label>Password <input type="password" autoComplete="current-password" required minLength={8} value={password} onChange={e => setPassword(e.target.value)} /></label>{' '}
      <button type="submit">Sign in</button>{' '}
      <button type="button" onClick={async () => {
        const { data, error } = await auth.signUp({ email, password });
        setMessage(error ? error.message : data.session ? '' : 'Check your email to confirm your account, then sign in.');
      }}>Create account</button>
    </form>
    {message && <p role="alert">{message}</p>}
  </section>;

  return <section aria-label="Account">
    <p>Signed in as {session.user.email}.{' '}<button type="button" onClick={() => { setNewKey(null); void auth.signOut(); }}>Sign out</button></p>
    <details>
      <summary>Add a sensor</summary>
      <form onSubmit={async event => {
        event.preventDefault();
        const api = new DrainApi(baseUrl, session.access_token);
        try {
          await api.register(deviceId, name);
          setNewKey(await api.createDeviceKey(deviceId));
          setMessage(''); setDeviceId(''); setName('');
        } catch (err) {
          setMessage(err instanceof DrainApiError && err.status === 409 ? 'That device ID is already taken.' : err instanceof Error ? err.message : 'Could not add the sensor.');
        }
      }}>
        <label>Device ID <input required pattern="[a-zA-Z0-9_\-]{1,64}" value={deviceId} onChange={e => setDeviceId(e.target.value)} /></label>{' '}
        <label>Name <input required maxLength={100} value={name} onChange={e => setName(e.target.value)} /></label>{' '}
        <button type="submit">Add sensor</button>
      </form>
      {message && <p role="alert">{message}</p>}
      {newKey && <p>Device key for {newKey.device_id} (shown only once; put it in the sensor&apos;s firmware): <code>{newKey.key}</code></p>}
    </details>
  </section>;
}
