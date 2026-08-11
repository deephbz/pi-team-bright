import concurrent.futures, json, os, pathlib, shutil, subprocess, sys, tempfile, time
from datetime import datetime, timezone
BD = shutil.which('bd')
ROOT = pathlib.Path(tempfile.mkdtemp(prefix='pi-teams-bd-contention-120-'))
AUTH = ROOT/'authority'; AUTH.mkdir()
TEAM_LABEL='pi-teams:benchmark-120'
COUNT=120
TIMEOUT=120
commands=[]
def run(args, timeout=TIMEOUT):
    command=[BD, '-C', str(AUTH), *args]
    started=time.perf_counter()
    try:
        p=subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        record={'argv':['bd','-C','<temp-authority>',*args], 'durationMs':round((time.perf_counter()-started)*1000,1), 'exitCode':p.returncode, 'timedOut':False, 'stdoutBytes':len(p.stdout.encode()), 'stderrBytes':len(p.stderr.encode())}
        return record,p.stdout,p.stderr
    except subprocess.TimeoutExpired as e:
        return {'argv':['bd','-C','<temp-authority>',*args], 'durationMs':round((time.perf_counter()-started)*1000,1), 'exitCode':124, 'timedOut':True, 'stdoutBytes':len(e.stdout or b''), 'stderrBytes':len(e.stderr or b'')},'', ''
def require(args):
 r,o,e=run(args)
 if r['exitCode'] != 0: raise RuntimeError(f'{args}: {r} {e}')
 return o
# Authority setup uses documented init, batch create, and label-add commands.
init=subprocess.run([BD, 'init','--quiet','--non-interactive','--skip-agents','--skip-hooks'], cwd=AUTH, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=TIMEOUT)
if init.returncode != 0: raise RuntimeError(f'init failed: {init.stderr}')
ops=ROOT/'create.ops'
ops.write_text(''.join(f'create task 2 "benchmark task {i:03d}"\n' for i in range(COUNT)))
require(['batch','-f',str(ops)])
raw=json.loads(require(['--json','list','--all','--no-pager','--limit','0']))
ids=[x['id'] for x in raw]
assert len(ids)==COUNT, len(ids)
require(['label','add',*ids,TEAM_LABEL])

def list_ids():
 rec,out,err=run(['--json','list','--label',TEAM_LABEL,'--all','--no-pager','--limit','0'])
 if rec['exitCode']==0:
  try:
   value=json.loads(out); got=[x['id'] for x in value]; rec['recordCount']=len(got)
   if len(got)!=COUNT: rec['validationError']='unexpected list cardinality'
  except Exception as ex: rec['validationError']=type(ex).__name__
 return rec, (got if rec['exitCode']==0 and 'got' in locals() else [])
def snapshot():
 lr, got=list_ids()
 if lr['exitCode'] or len(got)!=COUNT: return {'list':lr,'show':None,'valid':False}
 sr,out,err=run(['--json','show','--include-dependents',*got])
 if sr['exitCode']==0:
  try:
   val=json.loads(out); sr['recordCount']=len(val)
   if len(val)!=COUNT: sr['validationError']='unexpected show cardinality'
  except Exception as ex: sr['validationError']=type(ex).__name__
 valid=lr.get('recordCount')==COUNT and sr.get('recordCount')==COUNT and not lr.get('validationError') and not sr.get('validationError')
 return {'list':lr,'show':sr,'valid':valid}
# Idle baseline. Two samples reduce elapsed time but retain p50/p95 comparable summary fields.
idle=[snapshot() for _ in range(2)]
# Four readers begin together; one writer toggles one task status during their read windows.
stop=False
def writer():
 n=0; outcomes=[]
 while not stop and n<16:
  status='in_progress' if n%2==0 else 'open'
  rec,_,_=run(['update',ids[0],'--status',status])
  outcomes.append(rec); n+=1
 return outcomes
with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:
 wf=ex.submit(writer)
 futures=[ex.submit(snapshot) for _ in range(4)]
 contended=[f.result() for f in futures]
 stop=True
 writer_records=wf.result()
def summary(samples, field):
 xs=[s[field]['durationMs'] for s in samples if s.get(field) and s[field]['exitCode']==0]
 xs.sort()
 def q(p): return xs[max(0, __import__('math').ceil(p*len(xs))-1)] if xs else None
 return {'attempted':len(samples),'successes':len(xs),'timeouts':sum(1 for s in samples if s.get(field) and s[field]['timedOut']),'p50Ms':q(.5),'p95Ms':q(.95),'maxMs':xs[-1] if xs else None}
def lane(samples): return {'completeSnapshots':sum(s['valid'] for s in samples),'list':summary(samples,'list'),'show':summary(samples,'show')}
result={'schema':'pi-team-bright/beads-100-plus-contention-benchmark/1','recordedAt':datetime.now(timezone.utc).isoformat(),'sourceRevision':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'environment':{'platform':sys.platform,'python':sys.version.split()[0],'bdVersion':subprocess.check_output([BD,'--version'],text=True,stderr=subprocess.DEVNULL).strip(),'authority':'disposable embedded Dolt','taskCount':COUNT,'dependencyEdges':0,'commandTimeoutMs':TIMEOUT},'setup':{'commands':['bd init --quiet --non-interactive --skip-agents --skip-hooks','bd batch -f <create.ops>','bd label add <120-ids> pi-teams:benchmark-120'],'validation':{'createdAndLabeledTaskCount':COUNT}},'workload':{'baseline':{'concurrentReaders':1,'concurrentWriters':0,'snapshotSamples':2},'contended':{'concurrentReaders':4,'concurrentWriters':1,'snapshotSamples':4,'writerAttempts':len(writer_records)}},'metrics':{'baseline':lane(idle),'contended':lane(contended),'writer':{'attempted':len(writer_records),'successes':sum(r['exitCode']==0 for r in writer_records),'timeouts':sum(r['timedOut'] for r in writer_records),'p50Ms':None}},'raw':{'baseline':idle,'contended':contended,'writer':writer_records},'proofLimits':['Disposable local authority; this does not prove Pi Session, Team-sync, production Task metadata, external writers, filesystem watches, OS scheduling, or capacity.','The fixed 120-task, zero-relation workload measures native bd list/show contention. It does not establish semantic equivalence for export or another backend.','Two baseline and four contended snapshots are characterization samples, not a statistically powered capacity claim.']}
# writer p50
ws=sorted(r['durationMs'] for r in writer_records if r['exitCode']==0)
if ws: result['metrics']['writer']['p50Ms']=ws[(len(ws)-1)//2]
out=pathlib.Path.cwd()/'docs/journal/artifacts/2026-08-11-beads-120-contention-benchmark.json'
out.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'artifact':str(out),'baseline':result['metrics']['baseline'],'contended':result['metrics']['contended'],'writer':result['metrics']['writer']},indent=2))
shutil.rmtree(ROOT)
