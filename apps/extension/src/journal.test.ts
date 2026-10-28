import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Journal } from './journal';
import { Recorder } from './recorder';

const temporary: string[] = [];
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(),'autoblogger-journal-')); temporary.push(dir);
  const journal = await Journal.create(dir,{schemaVersion:1,id:'session-test',rootPath:dir,name:'test',startedAt:new Date().toISOString(),lastActivityAt:new Date().toISOString(),recording:true,excludePatterns:[]});
  return {dir,journal};
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(dir => rm(dir,{recursive:true,force:true}))); });

describe('durable local journal',() => {
  it('serializes concurrent events and retries only unacknowledged gaps after restart',async () => {
    const {journal} = await fixture();
    await Promise.all(Array.from({length:6},(_,i) => journal.append({type:'memo',occurredAt:new Date().toISOString(),data:{text:String(i)}})));
    expect(journal.all().map(event => event.sequence)).toEqual([1,2,3,4,5,6]);
    await journal.acknowledge({ackThrough:2,received:[1,2,4,5],gaps:[3]},[1,2,3,4,5]);
    const restored = await Journal.load(journal.directory);
    expect(restored.pending().map(event => event.sequence)).toEqual([3,6]);
    expect(restored.all()).toHaveLength(6);
    await restored.acknowledge({ackThrough:6,received:[3,6],gaps:[]},[3,6]);
    expect(restored.pendingCount()).toBe(0);
    expect((await Journal.load(journal.directory)).all()).toHaveLength(6);
  });
  it('does not trust an acknowledgement for an unsent later event',async () => {
    const {journal} = await fixture();
    for (let i = 0; i < 3; i++) await journal.append({type:'memo',occurredAt:new Date().toISOString(),data:{text:'x'}});
    await journal.acknowledge({ackThrough:3,received:[1,2,3],gaps:[]},[1]);
    expect(journal.pending().map(event => event.sequence)).toEqual([2,3]);
    await expect(journal.acknowledge({ackThrough:100,received:[],gaps:[]},[2])).rejects.toThrow();
  });
  it('recovers a partial trailing write without dropping complete events',async () => {
    const {journal} = await fixture();
    await journal.append({type:'memo',occurredAt:new Date().toISOString(),data:{text:'safe'}});
    await appendFile(path.join(journal.directory,'events.jsonl'),'{"id":"partial');
    const restored = await Journal.load(journal.directory);
    expect(restored.all()).toHaveLength(1);
    await restored.append({type:'memo',occurredAt:new Date().toISOString(),data:{text:'next'}});
    expect((await Journal.load(journal.directory)).all().map(event => event.sequence)).toEqual([1,2]);
  });
});

describe('source version evidence',() => {
  it('retains the newly compiled executable version after a combined command runtime crash',async () => {
    const {dir,journal} = await fixture(); const recorder = new Recorder(journal);
    await writeFile(path.join(dir,'crash.cpp'),'int main(){return 1;}');
    const run = await recorder.beginRun('g++ crash.cpp && ./a.out',dir);
    await recorder.endRun(run!,139,'Segmentation fault');
    const restarted = new Recorder(await Journal.load(journal.directory));
    expect((await restarted.beginRun('./a.out',dir))!.snapshotId).toBe(run!.snapshotId);
  });
  it('bounds large edit payloads with explicit truncation instead of blocking queue transmission',async () => {
    const {dir,journal} = await fixture(); const recorder = new Recorder(journal);
    await recorder.edit(path.join(dir,'large.py'),'a'.repeat(800000),'b'.repeat(800000),2,true);
    const event = journal.all()[0];
    expect(event.data.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(1024 * 1024);
  });
  it('recovers in-flight terminal executions as unknown exactly once after a killed host',async () => {
    const {dir,journal} = await fixture();
    await writeFile(path.join(dir,'solve.py'),'print(1)');
    const recorder = new Recorder(journal);
    const context = await recorder.beginRun('python3 solve.py',dir);
    const recovered = new Recorder(await Journal.load(journal.directory));
    await recovered.recoverInterruptedRuns();
    const events = recovered.journal.all().filter(event => event.type === 'run');
    expect(events).toHaveLength(1);
    expect(events[0].data.status).toBe('unknown');
    expect(events[0].data.snapshotId).toBe(context!.snapshotId);
    await new Recorder(await Journal.load(journal.directory)).recoverInterruptedRuns();
    expect((await Journal.load(journal.directory)).all().filter(event => event.type === 'run')).toHaveLength(1);
  });
  it('keeps executable linked to successful compile even when disk later changes',async () => {
    const {dir,journal} = await fixture();
    const file = path.join(dir,'answer.cpp');
    await writeFile(file,'int main(){return 0;}');
    const recorder = new Recorder(journal);
    const compile = await recorder.beginRun('g++ answer.cpp -o answer',dir);
    await recorder.endRun(compile!,0,'');
    const firstSnapshot = compile!.snapshotId;
    await writeFile(file,'int main(){INVALID}');
    await recorder.snapshot(file,2);
    const fail = await recorder.beginRun('g++ answer.cpp -o answer',dir);
    await recorder.endRun(fail!,1,'answer.cpp:1:12: error: INVALID');
    const execution = await recorder.beginRun('./answer',dir);
    expect(execution!.snapshotId).toBe(firstSnapshot);
    expect(fail!.snapshotId).not.toBe(firstSnapshot);
    await recorder.endRun(execution!,0,'');
    const restarted = new Recorder(await Journal.load(journal.directory));
    expect((await restarted.beginRun('./answer',dir))!.snapshotId).toBe(firstSnapshot);
  });
  it('deduplicates identical saves, captures Python disk at start, redacts input and preserves unknown',async () => {
    const {dir,journal} = await fixture(); const recorder = new Recorder(journal);
    await writeFile(path.join(dir,'solve.py'),'print(1)');
    await writeFile(path.join(dir,'input.txt'),`token = sk-or-v1-${'a'.repeat(32)}`);
    await recorder.snapshot(path.join(dir,'solve.py'),1); await recorder.snapshot(path.join(dir,'solve.py'),2);
    expect(journal.all().filter(event => event.type === 'snapshot')).toHaveLength(1);
    const run = await recorder.beginRun('python3 solve.py < input.txt',dir);
    await writeFile(path.join(dir,'solve.py'),'print(2)');
    await recorder.endRun(run!,undefined,'interrupted');
    const event = journal.all().find(event => event.type === 'run')!;
    expect(event.data.status).toBe('unknown');
    expect(JSON.stringify(event.data.inputSnapshot)).not.toContain('a'.repeat(32));
    const snapshot = journal.all().find(event => event.id === run!.snapshotId)!;
    expect(snapshot.data.content).toBe('print(1)');
    expect(await readFile(path.join(dir,'solve.py'),'utf8')).toBe('print(2)');
  });
});
