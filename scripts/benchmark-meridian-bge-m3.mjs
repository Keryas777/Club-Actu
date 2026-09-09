import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MODEL='@cf/baai/bge-m3';
const CLUBS=['ol','psg','om'];
const VARIANTS=['structured','semantic','anchors'];
const norm=(v='')=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
const uniq=(xs=[])=>{const s=new Set(),o=[];for(const x of xs){const k=norm(x);if(k&&!s.has(k)){s.add(k);o.push(String(x).replace(/\s+/g,' ').trim());}}return o;};
const set=(xs=[])=>new Set(xs.map(norm).filter(Boolean));
const inter=(a,b)=>{let n=0;for(const x of a)if(b.has(x))n++;return n;};
const hash=(v)=>crypto.createHash('sha256').update(String(v)).digest('hex');
const ts=(v)=>{const n=Date.parse(v||'');return Number.isFinite(n)?n:0;};

function evidence(e){
  const f=uniq(e?.evidence?.fragments||[]);
  return (f.length?f.join(' '):String(e?.evidence?.text||'')).replace(/\s+/g,' ').trim().slice(0,700);
}

export function record(article,event,club){
  const sig=JSON.stringify({a:article.id,f:event.family,p:uniq(event.primary_people||[]).map(norm),c:uniq(event.primary_clubs||[]).map(norm),r:event.relation_hints||{},s:event.stage||'',e:evidence(event)});
  return {id:hash(sig).slice(0,24),article:{id:article.id,source_id:article.source_id,title:article.title||'',published_at:article.published_at||null},club_ids:[club],event};
}

export function representation(r,variant='structured'){
  const e=r.event||{}, p=uniq(e.primary_people||[]), c=uniq(e.primary_clubs||[]), h=e.relation_hints||{}, t=String(r.article.title||'').replace(/\s+/g,' ').trim(), x=evidence(e), tok=uniq(e.lexical_fingerprint?.tokens||[]).slice(0,18);
  const anchors=[`family=${e.family||'unknown'}`,p.length?`people=${p.join(' ; ')}`:'',c.length?`clubs=${c.join(' ; ')}`:'',h.club_from?`from=${h.club_from}`:'',h.club_to?`to=${h.club_to}`:'',e.stage&&e.stage!=='unknown'?`stage=${e.stage}`:''].filter(Boolean);
  if(variant==='anchors') return [...anchors,tok.length?`anchors=${tok.join(' ')}`:''].filter(Boolean).join(' | ');
  if(variant==='semantic') return [`Football news event. Type: ${e.family||'unknown'}.`,p.length?`Main people: ${p.join(', ')}.`:'',c.length?`Main clubs: ${c.join(', ')}.`:'',h.club_from?`From: ${h.club_from}.`:'',h.club_to?`To: ${h.club_to}.`:'',t?`Title: ${t}.`:'',x?`Facts: ${x}`:''].filter(Boolean).join(' ');
  return [...anchors,t?`title=${t}`:'',x?`facts=${x}`:'',tok.length?`lexical=${tok.join(' ')}`:''].filter(Boolean).join(' | ');
}

export function dedupe(previews){
  const m=new Map();
  for(const p of previews)for(const row of p.articles||[])for(const e of row.events||[]){const r=record(row.article||{},e,p.club_id);const old=m.get(r.id);if(old)old.club_ids=uniq([...old.club_ids,...r.club_ids]);else m.set(r.id,r);}
  return [...m.values()].sort((a,b)=>ts(a.article.published_at)-ts(b.article.published_at)||a.id.localeCompare(b.id));
}

function anchors(r){const e=r.event||{},h=e.relation_hints||{};return {p:set(e.primary_people||[]),c:set(e.primary_clubs||[]),r:set([h.club_from,h.club_to].filter(Boolean)),l:set((e.lexical_fingerprint?.tokens||[]).filter(x=>norm(x).length>=4)),f:e.family||'unknown'};}
export function shortlistContext(records){const df=new Map();for(const r of records)for(const x of anchors(r).l)df.set(x,(df.get(x)||0)+1);return {df,maxDf:Math.max(3,Math.ceil(records.length*.03))};}
export function shortlist(a,b,ctx){
  if(String(a.article.id)===String(b.article.id))return {keep:false,reasons:[]};
  const A=anchors(a),B=anchors(b),sp=inter(A.p,B.p),sc=inter(A.c,B.c),sr=inter(A.r,B.r)+inter(A.r,B.c)+inter(B.r,A.c),same=A.f===B.f&&A.f!=='unknown';
  const sa=new Set([...A.l].filter(x=>(ctx.df.get(x)||0)<=ctx.maxDf)),sb=new Set([...B.l].filter(x=>(ctx.df.get(x)||0)<=ctx.maxDf)),sl=inter(sa,sb),reasons=[];
  if(sp)reasons.push(`person:${sp}`); if(sr)reasons.push(`from_to:${sr}`); if(sc>=2)reasons.push(`clubs:${sc}`); if(same&&sc&&sl>=2)reasons.push('family+club+salient2'); if(same&&sl>=3)reasons.push('family+salient3'); if(sl>=4)reasons.push('salient4');
  return {keep:!!reasons.length,reasons};
}

const cos=(a,b)=>{if(!a?.length||a.length!==b?.length)return 0;let d=0,aa=0,bb=0;for(let i=0;i<a.length;i++){d+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];}return aa&&bb?d/Math.sqrt(aa*bb):0;};
function lex(a,b){const A=anchors(a).l,B=anchors(b).l,u=new Set([...A,...B]);return u.size?inter(A,B)/u.size:0;}
function timeScore(a,b,sigma=7){const x=ts(a.article.published_at),y=ts(b.article.published_at);if(!x||!y)return .5;const d=Math.abs(x-y)/864e5;return Math.exp(-(d*d)/(2*sigma*sigma));}
const q=(xs,p)=>{if(!xs.length)return null;const a=[...xs].sort((x,y)=>x-y),z=(a.length-1)*p,l=Math.floor(z),h=Math.ceil(z);return l===h?a[l]:a[l]*(h-z)+a[h]*(z-l);};
function mean(vs){if(!vs.length)return[];const o=new Array(vs[0].length).fill(0);for(const v of vs)for(let i=0;i<v.length;i++)o[i]+=v[i];return o.map(x=>x/vs.length);}

function pairAudit(records,emb){
  const ctx=shortlistContext(records), all=[], kept=[], rows=[]; let possible=0;
  for(let i=0;i<records.length;i++)for(let j=i+1;j<records.length;j++){
    const a=records[i],b=records[j]; if(String(a.article.id)===String(b.article.id))continue; possible++; const es=cos(emb.get(a.id),emb.get(b.id)); all.push(es); const s=shortlist(a,b,ctx); if(!s.keep)continue; kept.push(es); const ls=lex(a,b),tm=timeScore(a,b),hy=.60*es+.25*ls+.15*tm;
    rows.push({event_a:a.id,event_b:b.id,article_a:a.article.id,article_b:b.article.id,title_a:a.article.title,title_b:b.article.title,family_a:a.event.family,family_b:b.event.family,people_a:a.event.primary_people,people_b:b.event.primary_people,clubs_a:a.event.primary_clubs,clubs_b:b.event.primary_clubs,reasons:s.reasons,embedding:+es.toFixed(6),lexical:+ls.toFixed(6),temporal:+tm.toFixed(6),hybrid:+hy.toFixed(6)});
  }
  rows.sort((a,b)=>b.hybrid-a.hybrid||b.embedding-a.embedding);
  return {possible_pairs:possible,shortlisted_pairs:kept.length,reduction_rate:possible?1-kept.length/possible:0,all_embedding_quantiles:{p50:q(all,.5),p90:q(all,.9),p95:q(all,.95),p99:q(all,.99)},shortlist_embedding_quantiles:{p50:q(kept,.5),p90:q(kept,.9),p95:q(kept,.95),p99:q(kept,.99)},threshold_counts:Object.fromEntries([.5,.55,.6,.65,.7,.75,.8,.85,.9].map(t=>[t.toFixed(2),kept.filter(x=>x>=t).length])),top_pairs:rows.slice(0,160)};
}

function simulate(records,emb,threshold=.60,anchorThreshold=.50,useAnchor=true){
  const ctx=shortlistContext(records),stories=[];let rejects=0,comparisons=0;const shortlistSizes=[];
  for(const r of records){const v=emb.get(r.id);const cand=stories.filter(s=>s.members.some(m=>shortlist(r,m.r,ctx).keep));shortlistSizes.push(cand.length);let best=null;
    for(const s of cand){comparisons++;const cs=cos(v,s.centroid),ls=Math.max(0,...s.members.map(m=>lex(r,m.r))),tm=timeScore(r,s.members.at(-1).r),score=.60*cs+.25*ls+.15*tm,as=cos(v,s.anchorV);if(!best||score>best.score)best={s,score,as};}
    if(best&&best.score>=threshold&&useAnchor&&best.as<anchorThreshold)rejects++;
    if(best&&best.score>=threshold&&(!useAnchor||best.as>=anchorThreshold)){best.s.members.push({r,v});best.s.centroid=mean(best.s.members.map(m=>m.v));best.s.last=Math.max(best.s.last,ts(r.article.published_at));}
    else stories.push({anchor:r,anchorV:v,centroid:v.slice(),members:[{r,v}],first:ts(r.article.published_at),last:ts(r.article.published_at)});
  }
  const sizes=stories.map(s=>s.members.length);
  return {story_count:stories.length,singletons:sizes.filter(x=>x===1).length,max_story_size:Math.max(0,...sizes),anchor_rejections:rejects,candidate_comparisons:comparisons,shortlist_mean:shortlistSizes.reduce((a,b)=>a+b,0)/Math.max(1,shortlistSizes.length),largest_stories:[...stories].sort((a,b)=>b.members.length-a.members.length).slice(0,10).map(s=>({size:s.members.length,span_days:s.first&&s.last?(s.last-s.first)/864e5:null,anchor_title:s.anchor.article.title,members:s.members.slice(0,12).map(m=>({id:m.r.id,title:m.r.article.title,family:m.r.event.family,people:m.r.event.primary_people,clubs:m.r.event.primary_clubs}))}))};
}

function vectors(payload,n){for(const x of [payload?.result?.data,payload?.data,payload?.result?.response,payload?.response])if(Array.isArray(x)&&x.length===n&&Array.isArray(x[0]))return x;throw new Error(`Unexpected BGE-M3 response: ${JSON.stringify(payload).slice(0,800)}`);}
async function embed(texts,account,token){const out=[],url=`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${MODEL}`;for(let i=0;i<texts.length;i+=32){const batch=texts.slice(i,i+32),res=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({text:batch})}),p=await res.json().catch(()=>({}));if(!res.ok||p?.success===false)throw new Error(`Workers AI HTTP ${res.status}: ${JSON.stringify(p).slice(0,1200)}`);out.push(...vectors(p,batch.length));}return out;}
async function fetchJson(url){const r=await fetch(url,{signal:AbortSignal.timeout(90000)}),t=await r.text();let d;try{d=JSON.parse(t);}catch{throw new Error(`Non-JSON HTTP ${r.status}: ${t.slice(0,500)}`);}if(!r.ok||d?.ok===false)throw new Error(`Preview HTTP ${r.status}: ${JSON.stringify(d).slice(0,1000)}`);return d;}
async function previews(base,limit){const out=[];for(const club of CLUBS){const articles=[];let first=null;for(let offset=0;offset<limit;offset+=20){const size=Math.min(20,limit-offset),p=await fetchJson(`${base.replace(/\/$/,'')}/api/phase-b-event-preview?club=${club}&limit=${size}&offset=${offset}`);first||=p;articles.push(...(p.articles||[]));if((p.article_count||0)<size)break;}const rows=articles.slice(0,limit);out.push({...first,club_id:club,article_count:rows.length,event_count:rows.reduce((s,r)=>s+(r.events||[]).length,0),articles:rows});}return out;}

async function main(){
  const arg=(n,d)=>{const i=process.argv.indexOf(n);return i>=0&&process.argv[i+1]?process.argv[i+1]:d;};
  const limit=Math.max(1,Math.min(120,parseInt(arg('--limit','60'),10)||60)),outDir=arg('--out-dir','phase-b-meridian'),base=arg('--base-url',process.env.CLUB_ACTU_BASE_URL||'https://club-actu.deliriousfan7.workers.dev'),account=process.env.CLOUDFLARE_ACCOUNT_ID||'',token=process.env.CLOUDFLARE_API_TOKEN||'';
  if(!account||!token)throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required');fs.mkdirSync(outDir,{recursive:true});
  const ps=await previews(base,limit),records=dedupe(ps),source=path.join(outDir,'source-previews');fs.mkdirSync(source,{recursive:true});for(const p of ps)fs.writeFileSync(path.join(source,`${p.club_id}.json`),JSON.stringify(p,null,2));
  const results={};
  for(const variant of VARIANTS){const texts=records.map(r=>representation(r,variant)),vs=await embed(texts,account,token),map=new Map(records.map((r,i)=>[r.id,vs[i]])),pairs=pairAudit(records,map);results[variant]={dimension:vs[0]?.length||0,mean_chars:texts.reduce((s,x)=>s+x.length,0)/Math.max(1,texts.length),pairs,simulations:[.55,.60,.65,.70].flatMap(t=>[.45,.50,.55,.60].map(a=>({threshold:t,anchor_threshold:a,with_anchor:simulate(records,map,t,a,true),without_anchor:simulate(records,map,t,a,false)})))};fs.writeFileSync(path.join(outDir,`representations-${variant}.json`),JSON.stringify(records.map((r,i)=>({event_id:r.id,hash:hash(texts[i]),chars:texts[i].length,text:texts[i]})),null,2));fs.writeFileSync(path.join(outDir,`pairs-${variant}.json`),JSON.stringify(pairs,null,2));fs.writeFileSync(path.join(outDir,`simulations-${variant}.json`),JSON.stringify(results[variant].simulations,null,2));}
  const summary={generated_at:new Date().toISOString(),model:MODEL,extractor_versions:[...new Set(ps.map(p=>p.version).filter(Boolean))],clubs:CLUBS,limit,preview_articles:Object.fromEntries(ps.map(p=>[p.club_id,p.article_count])),raw_preview_events:ps.reduce((s,p)=>s+(p.event_count||0),0),unique_events:records.length,variants:Object.fromEntries(Object.entries(results).map(([k,v])=>[k,{embedding_dimension:v.dimension,representation_chars_mean:v.mean_chars,possible_pairs:v.pairs.possible_pairs,shortlisted_pairs:v.pairs.shortlisted_pairs,reduction_rate:v.pairs.reduction_rate,all_embedding_quantiles:v.pairs.all_embedding_quantiles,shortlist_embedding_quantiles:v.pairs.shortlist_embedding_quantiles,threshold_counts:v.pairs.threshold_counts}]))};
  fs.writeFileSync(path.join(outDir,'summary.json'),JSON.stringify(summary,null,2));fs.writeFileSync(path.join(outDir,'events.json'),JSON.stringify(records,null,2));console.log(JSON.stringify(summary,null,2));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e?.stack||e);process.exit(1);});
