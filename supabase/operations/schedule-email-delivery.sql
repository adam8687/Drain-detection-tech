-- Optional retry worker; apply after configuring the sender and email migration.
-- Enable pg_cron and pg_net in the Supabase dashboard first.
-- Put drain_email_api_url (full /functions/v1/drain-api URL) and
-- drain_email_worker_token (DRAIN_EMAIL_WORKER_TOKEN, not an admin/service key)
-- in Supabase Vault using trusted operator tooling. Never expose them to clients.
do $setup$
begin
 if not exists(select 1 from vault.decrypted_secrets where name='drain_email_api_url')or not exists(select 1 from vault.decrypted_secrets where name='drain_email_worker_token')then raise exception 'Configure email worker Vault secrets first';end if;
end;
$setup$;
select cron.schedule('deliver-drain-email-retries','* * * * *',$job$
 update public.drain_email_outbox set status='expired'where status in('pending','sending')and created_at<=now()-interval '23 hours';
 select net.http_post(
  url:=(select decrypted_secret from vault.decrypted_secrets where name='drain_email_api_url'limit 1)||'/api/v1/internal/email-deliveries',
  headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='drain_email_worker_token'limit 1)),body:='{}'::jsonb,timeout_milliseconds:=10000
 )where exists(select 1 from public.drain_email_outbox where status in('pending','sending')and available_at<=now()and attempts<5 and created_at>now()-interval '23 hours');
$job$);
