// Operator-only maintenance. Never runs on a browser request or sensor upload.
import {configFromEnv} from '../backend/src/config.js';
import {createRecordStore} from '../backend/src/records-storage.js';
import {deviceId} from '../backend/src/validation.js';
import {reconcileDrainHistory} from '../supabase/functions/_shared/rollover.js';

async function main() {
  const args=process.argv.slice(2),options={apply:false,source:'sensor'};
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--apply')options.apply=true;
    else if(args[i]==='--fixture')options.fixture=deviceId(args[++i]);
    else if(args[i]==='--source'&&['sensor','simulation'].includes(args[i+1]))options.source=args[++i];
    else throw Error('Use --fixture UNIT [--source sensor|simulation] [--apply]. Without --apply this only previews.');
  }
  if(!options.fixture)throw Error('Specify --fixture UNIT to bound maintenance to one fixture.');
  const store=createRecordStore(configFromEnv());
  try { console.log(JSON.stringify(await reconcileDrainHistory(store,options))); }
  finally { await store.close(); }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
