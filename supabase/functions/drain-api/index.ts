import {providerConfiguration} from '../_shared/email-notifications.js';
import { createCloudHandler } from '../_shared/cloud-handler.js';

const config = {
  emailWorkerToken:Deno.env.get('DRAIN_EMAIL_WORKER_TOKEN')||'',
  email:providerConfiguration(Deno.env.toObject()),
  waitUntil:(task:Promise<unknown>)=>EdgeRuntime.waitUntil(task),
  url: Deno.env.get('SUPABASE_URL')!,
  serviceKey: Deno.env.get('DRAIN_SERVICE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  adminToken: Deno.env.get('DRAIN_ADMIN_TOKEN') || '',
  origins: (Deno.env.get('DRAIN_ALLOWED_ORIGINS') || 'http://localhost:3000,http://127.0.0.1:3000').split(',').map(v => v.trim()),
};
const handler = createCloudHandler(config);
Deno.serve(handler);
