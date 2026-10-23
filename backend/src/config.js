export function configFromEnv(env = process.env) {
  const config = {
    host: env.HOST || '0.0.0.0', port: Number(env.PORT || 8000),
    production: env.NODE_ENV === 'production',
    storage: env.STORAGE_BACKEND || 'supabase',
    autoCalibrate: env.AUTO_CALIBRATE !== 'false',
    sqlitePath: env.SQLITE_PATH || './data/drain-monitor.sqlite',
    apiKey: env.API_KEY || '',
    origins: (env.CORS_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173').split(',').map(s => s.trim()).filter(Boolean),
    supabaseUrl: env.SUPABASE_URL || '', supabaseKey: env.SUPABASE_SECRET_KEY || '',
  };
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw Error('Invalid PORT');
  if (!['sqlite', 'supabase'].includes(config.storage)) throw Error('Invalid STORAGE_BACKEND');
  if (config.production && config.storage !== 'supabase') throw Error('Production requires Supabase storage');
  if (config.production && config.apiKey.length < 32) throw Error('Production requires API_KEY of at least 32 characters');
  if (config.production && config.origins.includes('*')) throw Error('Production requires explicit CORS_ORIGINS');
  if (config.storage === 'supabase') {
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(config.supabaseUrl)) throw Error('Set SUPABASE_URL to your HTTPS project URL');
    if (!config.supabaseKey.startsWith('sb_secret_')) throw Error('Set a server-only SUPABASE_SECRET_KEY');
  }
  return config;
}
