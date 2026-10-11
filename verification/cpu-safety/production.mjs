// Read-only production audit. Never migrates, deploys, scans, sends mail or exhausts CPU.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { cloudflareConfig } from '../../scripts/cloudflare-config.js';
const siteUrl = new URL(process.env.BAY_JOBS_URL ?? 'https://example.invalid');
if (siteUrl.hostname === 'example.invalid' || siteUrl.protocol !== 'https:' || siteUrl.username || siteUrl.password || siteUrl.pathname !== '/' || siteUrl.search || siteUrl.hash)
    throw new Error('Set BAY_JOBS_URL to your private HTTPS site origin before running this audit.');
const report = { startedAt: new Date().toISOString(), checks: [], observations: {}, limitations: [
    'No deliberate CPU exhaustion: configured enforcement is verified, exact runtime cutoff is not.',
    'No account-wide billing or cost guarantee is established.',
    'Access redirect checks do not verify signed-in policy, every alternate hostname, or preview URLs.',
    'Source history and reservations are observations; historical successful checks can predate this deployment.',
] };
const cli = 'node_modules/wrangler/bin/wrangler.js';
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: '.wrangler/logs' };
function wrangler(args) {
    return JSON.parse(execFileSync(process.execPath, [cli, ...args, '--config', cloudflareConfig(), '--json'], { env, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }));
}
async function check(name, fn) {
    try { const evidence = await fn(); report.checks.push({ name, outcome: 'PASS', evidence }); }
    catch (error) { report.checks.push({ name, outcome: 'FAIL', error: error.message }); process.exitCode = 1; }
}
await check('Active production version has a 500 ms CPU ceiling', () => {
    const deployments = wrangler(['deployments','list']);
    const latest = deployments.sort((a,b)=>a.created_on.localeCompare(b.created_on)).at(-1);
    assert.ok(latest);
    const versions = latest.versions.filter(v=>v.percentage>0).map(v=>{
        const info = wrangler(['versions','view',v.version_id]);
        assert.equal(info.resources.script_runtime.limits.cpu_ms,500);
        return {id:v.version_id,trafficPercent:v.percentage,cpuLimitMs:info.resources.script_runtime.limits.cpu_ms,createdAt:info.metadata.created_on,usageModel:info.resources.script_runtime.usage_model};
    });
    assert.equal(versions.reduce((sum,v)=>sum+v.trafficPercent,0),100);
    report.observations.activeVersions=versions;
    return versions;
});
await check('Production accounting schema and current reservation data exist',()=>{
    const sql = `SELECT name FROM d1_migrations WHERE name = '0014_cpu_safety.sql';
        SELECT started_at FROM work_budget_tracking WHERE id = 1;
        SELECT day,reserved_ms,manual_starts FROM work_budget_days ORDER BY day;
        SELECT source_id,last_attempt_at,last_success_at,error FROM source_runs ORDER BY source_id;
        SELECT substr(checked_at,1,13) AS utc_hour,COUNT(*) AS checks,SUM(success) AS successes,COUNT(DISTINCT source_id) AS sources FROM source_checks WHERE checked_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 hours') GROUP BY utc_hour ORDER BY utc_hour;`;
    const data=wrangler(['d1','execute','DB','--remote','--command',sql]);
    assert.equal(data.length,5);assert.ok(data.every(x=>x.success));
    assert.equal(data[0].results.length,1);assert.equal(data[1].results.length,1);
    assert.ok(data[2].results.length>0);assert.ok(data[2].results.some(r=>r.reserved_ms>=500));
    report.observations.trackingStartedAt=data[1].results[0].started_at;
    report.observations.dailyReservations=data[2].results;
    report.observations.sourceHealth=data[3].results;
    report.observations.recentHours=data[4].results;
    return {migrationPresent:true,trackingStartedAt:report.observations.trackingStartedAt,dailyReservations:data[2].results};
});
for(const route of ['/','/api/jobs','/api/check']) await check(`Unauthenticated ${route} redirects to Cloudflare Access`,async()=>{
    const response=await fetch(new URL(route, siteUrl),{redirect:'manual',signal:AbortSignal.timeout(10000)});
    const location=response.headers.get('location');
    assert.equal(response.status,302);assert.ok(location);
    const url=new URL(location);assert.equal(url.protocol,'https:');assert.ok(url.hostname.endsWith('.cloudflareaccess.com'));
    return {status:response.status,redirectHost:url.hostname};
});
if(process.argv.includes('--observe')){
    const startedAt=new Date().toISOString();
    const child=spawn(process.execPath,[cli,'tail','--config',cloudflareConfig(),'--format=json'],{env,detached:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
    await new Promise(resolve=>{
        const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGINT');}catch{}},60000);
        child.once('close',()=>{clearTimeout(timer);resolve();});
        child.once('error',()=>{clearTimeout(timer);resolve();});
    });
    const events=[];let pending=stdout.trim();
    while(pending){
        let parsed=false;
        for(let i=0;i<pending.length;i++){
            if(pending[i]!=='}')continue;
            try{
                const e=JSON.parse(pending.slice(0,i+1));
                events.push({outcome:e.outcome??null,cpuTimeMs:e.cpuTimeMs??null,wallTimeMs:e.wallTimeMs??null,eventTimestamp:e.eventTimestamp??null,cron:e.event?.cron??null,
                    exceptions:(e.exceptions??[]).map(x=>x.name),logs:(e.logs??[]).map(x=>x.message).filter(x=>Array.isArray(x)&&x.some(v=>typeof v==='string'&&/Job check complete|CPU safety/.test(v)))});
                pending=pending.slice(i+1).trim();parsed=true;break;
            }catch{}
        }
        if(!parsed)break;
    }
    report.observations.liveWindow={startedAt,endedAt:new Date().toISOString(),events,unparsedOutput:pending.length>0,stderrPresent:stderr.length>0};
    report.limitations.push('A 60-second tail sample cannot establish a full scan round, CPU percentile, or future performance.');
}
report.finishedAt=new Date().toISOString();
await writeFile('verification/cpu-safety/production-results.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({checks:report.checks.map(({name,outcome})=>({name,outcome})),liveEvents:report.observations.liveWindow?.events.length??null}));
