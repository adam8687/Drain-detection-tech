import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=p=>fileURLToPath(new URL(p,import.meta.url));
const cxx=['c++','g++','clang++'].find(c=>spawnSync(c,['--version']).status===0);

test('the firmware drain-end detector passes its native tests',{skip:!cxx&&'no C++ compiler on this machine'},()=>{
 const dir=mkdtempSync(join(tmpdir(),'fw-'));
 try{
  const bin=join(dir,'activity-test'),build=spawnSync(cxx,['-std=c++17','-Wall','-Wextra','-Werror',here('../../device/tests/drain_activity_test.cpp'),'-o',bin],{encoding:'utf8'});
  assert.equal(build.status,0,build.stderr);
  const run=spawnSync(bin,{encoding:'utf8'});
  assert.equal(run.status,0,run.stdout);assert.match(run.stdout,/all checks passed/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('the sketch uploads at the end of a drain and writes flash once per batch',()=>{
 const sketch=readFileSync(here('../../device/us100_wifi_upload/us100_wifi_upload.ino'),'utf8');
 assert.match(sketch,/#include "drain_activity\.h"/);
 assert.match(sketch,/activity\.update\(a\.distanceMm\)/);
 assert.match(sketch,/if \(batchCount < BATCH_SIZE && !drainEnded\) return;/,'a finished drain uploads without waiting for the batch to fill');
 assert.equal(sketch.includes('journalPoint'),false,'no per-reading flash write');
 assert.equal((sketch.match(/writeJournal\(\)/g)||[]).length,2,'defined once, called once (when the batch is complete)');
});
