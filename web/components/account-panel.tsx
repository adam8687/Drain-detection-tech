'use client';

import { useState } from 'react';
import { supabase, useSession } from '../lib/supabase';
import styles from './account-panel.module.css';

export default function AccountPanel({recovery=false}:{recovery?:boolean}) {
  const session = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy,setBusy]=useState(false);
  const [newPassword,setNewPassword]=useState('');
  const [repeatPassword,setRepeatPassword]=useState('');
  if (!supabase) return <p className={styles.panel}>Sign-in is temporarily unavailable. Please try again later or contact your installer.</p>;
  const auth = supabase.auth;

  if(recovery)return <section className={styles.panel} aria-label="Reset password"><h1>Set a new password</h1>{session?<form onSubmit={async e=>{e.preventDefault();if(newPassword!==repeatPassword){setMessage('The passwords do not match.');return;}setBusy(true);try{const{error}=await auth.updateUser({password:newPassword});setMessage(error?error.message:'Password updated. You can return to your dashboard.');}catch{setMessage('Could not update your password. Try again.');}finally{setBusy(false);}}}><label>New password<input type="password" autoComplete="new-password" required minLength={8} value={newPassword} onChange={e=>setNewPassword(e.target.value)}/></label><label>Repeat new password<input type="password" autoComplete="new-password" required minLength={8} value={repeatPassword} onChange={e=>setRepeatPassword(e.target.value)}/></label><button disabled={busy}>Update password</button></form>:<p>Open the password reset link in your email. If it has expired, request a new one from Sign in.</p>}{message&&<p role="status">{message}</p>}<a href="/login">Back to sign in</a></section>;
  if (!session) return <section className={styles.panel} aria-label="Account">
    <h2>Sign in</h2>
    <form onSubmit={async event => {
      event.preventDefault();
      setBusy(true);try{const { error } = await auth.signInWithPassword({ email, password });setMessage(error ? error.message : '');}catch{setMessage('Could not sign in. Check your connection and try again.');}finally{setBusy(false);}
    }}>
      <label>Email <input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} /></label>{' '}
      <label>Password <input type="password" autoComplete="current-password" required minLength={8} value={password} onChange={e => setPassword(e.target.value)} /></label>{' '}
      <button type="submit" disabled={busy}>Sign in</button>{' '}
      <button type="button" disabled={busy} onClick={async () => {
        if(password.length<8){setMessage('Use a password with at least 8 characters.');return;}setBusy(true);try{const { data, error } = await auth.signUp({ email, password,options:{emailRedirectTo:window.location.origin+'/login'} });setMessage(error ? error.message : data.session ? '' : 'Check your email to confirm your account, then sign in.');}catch{setMessage('Could not create your account. Try again.');}finally{setBusy(false);}
      }}>Create account</button>
      <button type="button" disabled={busy} onClick={async()=>{if(!email||!email.includes('@')){setMessage('Enter your email address first.');return;}setBusy(true);try{const{error}=await auth.resetPasswordForEmail(email,{redirectTo:window.location.origin+'/reset-password'});setMessage(error?error.message:'If an account uses this email, a password reset link is on its way.');}catch{setMessage('Could not request a reset link. Try again.');}finally{setBusy(false);}}}>Forgot password?</button>
    </form>
    {message && <p role="alert">{message}</p>}
  </section>;

  return <section className={styles.panel} aria-label="Account">
    <p>Signed in as {session.user.email}.{' '}<button type="button" onClick={() => { void auth.signOut(); }}>Sign out</button></p>
    <a href="/add-unit">Set up a unit</a>
  </section>;
}
