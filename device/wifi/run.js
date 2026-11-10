import { readFile, writeFile, copyFile, mkdir, rename, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { configFromEnv } from '../../backend/src/config.js';
import { createRecordStore } from '../../backend/src/records-storage.js';
import { settings, firmwareHeader, checkTables, prepareRecord, api, verifyStoredPoint } from './testing.js';

const root = new URL('../../', import.meta.url);
const folder = new URL('./', import.meta.url);
const headerPath = new URL('../us100_wifi_upload/secrets.h', import.meta.url);
const statePath = new URL('data/state.json', folder);
const [command, ...args] = process.argv.slice(2);
const path = value => fileURLToPath(new URL(value, root));
async function optionalFile(url) { try { return await readFile(url, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } }
async function privateWrite(url, text) {
  await mkdir(new URL('./', url), { recursive: true });
  const temporary = new URL(`${url.href}.tmp`);
  await writeFile(temporary, text, { mode: 0o600 }); await chmod(temporary, 0o600); await rename(temporary, url);
}
async function freePort(port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(Error(`Port ${port} is unavailable. Stop the old process using it, or update the configured port. No automatic port switching.`)));
    server.listen(port, '0.0.0.0', () => server.close(resolve));
  });
}
async function ready(url, child) {
  for (let n = 0; n < 90; n++) {
    if (child.exitCode !== null || child.signalCode !== null) throw Error('A server stopped. Check its output above.');
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (response.ok) return; } catch {}
    await pause(500);
  }
  throw Error(`Server did not become ready at ${url}.`);
}
async function start(config) {
  await freePort(config.apiPort); await freePort(config.webPort);
  if (!await optionalFile(new URL('web/node_modules/next/package.json', root))) throw Error('Install the website first: npm --prefix web ci');
  const children = [];
  let stopping = false;
  const shutdown = () => { if (stopping) return; stopping = true; for (const child of children) child.kill('SIGTERM'); };
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, shutdown);
  function launch(argv, cwd, extra) {
    const child = spawn(process.execPath, argv, { cwd, stdio: 'inherit', env: { ...process.env, ...extra } });
    children.push(child);
    child.on('error', () => { console.error('Could not launch a server.'); process.exitCode = 1; shutdown(); });
    child.on('exit', code => { if (!stopping) { console.error(`A server exited (${code}); stopping its companion.`); process.exitCode = 1; shutdown(); } });
    return child;
  }
  try {
    // These explicit runtime overrides preserve every environment file while
    // making the ESP, API and Next proxy agree on the same backend port.
    const backend = launch(['--env-file-if-exists=.env','src/server.js'], path('backend/'), { HOST: '0.0.0.0', PORT: String(config.apiPort), STORAGE_BACKEND: 'supabase' });
    await ready(`${config.local}/ready`, backend);
    const frontend = launch(['node_modules/next/dist/bin/next','dev','--port',String(config.webPort),'--hostname','0.0.0.0'], path('web/'), { BACKEND_URL: config.local });
    await ready(`${config.web}/dashboard`, frontend);
    console.log(`\nREADY — ESP API: ${config.base}; dashboard: ${config.web}/dashboard`);
    console.log('Backend listens on all interfaces. Same computer stays awake. Ctrl+C stops both servers.');
  } catch (error) { shutdown(); throw error; }
}

try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Use Node.js 24 or newer.');
  if (command === 'init') {
    try {
      await copyFile(new URL('.env.example', folder), new URL('.env', folder), constants.COPYFILE_EXCL);
      await chmod(new URL('.env', folder), 0o600);
      console.log('Created device/wifi/.env. Fill Wi-Fi name/password and opt in to trusted-LAN HTTP.');
    } catch (error) { if (error.code !== 'EEXIST') throw error; console.log('Kept existing device/wifi/.env unchanged.'); }
    console.log('Backend credentials remain in backend/.env. No other environment file was changed.');
  } else {
    const source = await optionalFile(new URL('.env', folder));
    if (!source) throw Error('Run npm run wifi:init, then edit device/wifi/.env.');
    const wifi = parseEnv(source);
    const config = settings(process.env, wifi);
    if (config.cloud) config.rootCa = await optionalFile(new URL(wifi.API_ROOT_CA_FILE || 'device/wifi/data/supabase-root-ca.pem', root));
    const cloudSecrets = parseEnv(await optionalFile(new URL('supabase/.env.cloud', root)));
    const dbConfig = configFromEnv({ ...process.env, STORAGE_BACKEND: 'supabase' });
    const token = process.env.OWNER_TOKEN || (config.cloud ? cloudSecrets.DRAIN_ADMIN_TOKEN : process.env.API_KEY) || '';
    let saved = JSON.parse(await optionalFile(statePath) || '{"fixtures":{}}');
    const saveState = () => privateWrite(statePath, JSON.stringify(saved, null, 2) + '\n');
    console.log(`API ${config.base} | Website ${config.web} | A: D1/D0, B: D3/D2 | USB monitor: 115200 baud`);
    if (command === 'start') {
      if (config.cloud) throw Error('Cloud mode does not need the local backend. Start only the website with npm run cloud:start.');
      await checkTables(dbConfig);
      await start(config);
    } else if (command === 'check') {
      await checkTables(dbConfig);
      console.log('PASS: recording and fixture-access tables are reachable (read-only).');
      for (const url of [`${config.base}/ready`, `${config.web}/dashboard`]) {
        try { const response = await fetch(url, { signal: AbortSignal.timeout(10000) }); if (!response.ok) throw Error(); }
        catch { throw Error(`Cannot reach ${url}. Start npm run wifi:start; check WIFI_HOST, firewall and configured ports.`); }
      }
      await api(`${config.web}/api/backend`, token, '/devices');
      console.log('PASS: LAN API, dashboard and authenticated website-to-backend proxy respond.');
      console.log('From a phone on the same Wi-Fi, open ' + config.base + '/health to test cross-device reachability.');
      console.log('This check sends no measurements and does not prove the ESP is connected.');
    } else if (command === 'prepare') {
      const positional = args.filter(a => !a.startsWith('--'));
      const fixture = positional[0] || 'wifi-bench', type = positional[1] || 'monitoring';
      // Validate credential strings and protect manually maintained headers BEFORE
      // any fixture/key/record creation in the backend.
      firmwareHeader(config, '00000000-0000-4000-8000-000000000000', 'dk_validation');
      const previousHeader = await optionalFile(headerPath);
      if (previousHeader && !previousHeader.startsWith('// Generated by wifi:prepare.') && !args.includes('--replace-config')) throw Error('Existing secrets.h is manually maintained. Back it up, ensure no pending board reading, then add --replace-config to generate a new one.');
      await checkTables(dbConfig);
      const slot = `${config.base}|${fixture}`;
      const previous = saved.fixtures[slot];
      const result = await prepareRecord({ config, token, fixture, type, confirmEmpty: args.includes('--confirm-empty'), previous: {
        key: previous?.key,
        saveKey: async key => { saved.fixtures[slot] = { ...previous, fixture, key }; await saveState(); },
      } });
      saved.fixtures[slot] = { fixture, key: result.key, recordId: result.record.record_id, type };
      saved.current = slot; await saveState();
      await privateWrite(headerPath, firmwareHeader(config, result.record.record_id, result.key));
      console.log(`READY: ${fixture}, ${type}, record ${result.record.record_id}.`);
      console.log('Generated ignored secrets.h. Wi-Fi credentials and fixture key were NOT printed.');
      console.log(`Sensor mode: ${config.uart ? 'UART; rear jumpers ON' : 'trigger/echo; rear jumpers OFF'}; second sensor ${config.second ? 'enabled' : 'disabled'}.`);
      console.log('Open device/us100_wifi_upload/us100_wifi_upload.ino in Arduino IDE; select Nano ESP32, its USB port, and Upload.');
      console.log('Do not run the USB uploader. If this ID was already sampled before a board restart, finish it and prepare a new recording.');
    } else if (command === 'finish' || command === 'watch') {
      const entry = saved.fixtures[saved.current];
      if (!entry?.recordId) throw Error('Run npm run wifi:prepare first.');
      if (saved.current !== `${config.base}|${entry.fixture}`) throw Error('LAN address/port changed. Restore the previous configuration to recover pending board data before preparing another recording.');
      if (command === 'finish') {
        await api(config.local, token, `/records/${entry.recordId}/finish`, {});
        console.log('Recording finished. Keep the board stopped; prepare a new recording before the next upload.');
      } else {
        const initial = await api(config.local, token, `/records/${entry.recordId}`);
        const previousIds = new Set(initial.record.measurements.map(p => p.reading_id));
        console.log(`Waiting up to 60 seconds for a NEW physical-sensor point for ${entry.fixture}. No test measurements are generated.`);
        const store = createRecordStore(dbConfig);
        try {
          const until = Date.now() + 60000;
          let found = false;
          while (Date.now() < until) {
            const view = await api(config.local, token, `/records/${entry.recordId}`);
            if (view.record.measurements.some(p => !previousIds.has(p.reading_id))) {
              const dbRecord = await store.get(entry.recordId);
              const frontend = await api(`${config.web}/api/backend`, token, `/records/${entry.recordId}`);
              const point = verifyStoredPoint({ apiRecord: view.record, dbRecord, frontendRecord: frontend.record,
                fixture: entry.fixture, recordId: entry.recordId, previousIds });
              if (point) {
                console.log('PASS: a new sensor point matches exactly in the API, hosted Supabase and website proxy.');
                for (const name of ['sensor_a','sensor_b']) console.log(`${name}: ${point[name].status === 'ok' ? point[name].distance_mm + ' mm' : point[name].status + ' (no valid distance)'}`);
                console.log('Transport verified. Validate sensor distances against a ruler separately.');
                found = true; break;
              }
            }
            if (view.record.recording_status === 'finished') throw Error('Recording finished before a new point arrived. Prepare a new recording, upload, and run watch while it is active.');
            await pause(1000);
          }
          if (!found) throw Error('No new sensor point arrived in 60 seconds. Check Serial Monitor, Wi-Fi, API address, fixture key and recording ID.');
        } finally { await store.close(); }
      }
    } else throw Error('Use wifi:init, wifi:start, wifi:check, wifi:prepare, wifi:watch or wifi:finish.');
  }
} catch (error) {
  // Avoid printing request headers, raw environment/config files or server traces.
  console.error(error.message); process.exitCode = 1;
}
