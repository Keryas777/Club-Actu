import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import Parser from '@postlight/parser';

const inputPath = process.argv[2] || 'phase-b-content-benchmark/urls.json';
const outputDir = process.argv[3] || 'phase-b-content-benchmark/results';
const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const samples = Array.isArray(payload.articles) ? payload.articles : [];
const USER_AGENT = 'ClubActuBenchmark/0.1 (+https://github.com/Keryas777/Club-Actu)';

fs.mkdirSync(outputDir, { recursive: true });

const normalize = (s='') => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
const tokens = (s='') => new Set(normalize(s).split(' ').filter((x) => x.length >= 3));
function titleSimilarity(a,b) {
  const A=tokens(a), B=tokens(b);
  if (!A.size || !B.size) return 0;
  let inter=0; for (const x of A) if (B.has(x)) inter++;
  return inter / new Set([...A,...B]).size;
}
function median(values) {
  if (!values.length) return 0;
  const s=[...values].sort((a,b)=>a-b), m=Math.floor(s.length/2);
  return s.length%2?s[m]:(s[m-1]+s[m])/2;
}
async function fetchHtml(url) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),12000);
  try {
    const res=await fetch(url,{redirect:'follow',signal:controller.signal,headers:{'User-Agent':USER_AGENT,'Accept':'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'}});
    const html=await res.text();
    return {ok:res.ok,status:res.status,final_url:res.url,html:html.slice(0,2_500_000)};
  } finally { clearTimeout(timer); }
}

const rows=[];
for (const sample of samples) {
  const row={source_id:sample.source_id,article_id:sample.id,url:sample.url,source_title:sample.title,fetch_ok:false,fetch_status:null,html_length:0,readability:{success:false,text_length:0,word_count:0,title_similarity:0,error:null},postlight:{success:false,text_length:0,word_count:0,title_similarity:0,error:null}};
  try {
    const fetched=await fetchHtml(sample.url);
    row.fetch_ok=fetched.ok; row.fetch_status=fetched.status; row.html_length=fetched.html.length;
    if (fetched.ok && fetched.html) {
      try {
        const dom=new JSDOM(fetched.html,{url:fetched.final_url || sample.url});
        const parsed=new Readability(dom.window.document).parse();
        const text=String(parsed?.textContent || '').trim();
        row.readability={success:text.length>=200,text_length:text.length,word_count:text?text.split(/\s+/).length:0,title_similarity:titleSimilarity(sample.title,parsed?.title || ''),error:null};
      } catch (error) {
        row.readability.error=String(error?.message || error).slice(0,300);
      }
      try {
        const parsed=await Parser.parse(sample.url,{html:fetched.html,contentType:'text',fetchAllPages:false});
        const text=String(parsed?.content || '').trim();
        row.postlight={success:text.length>=200,text_length:text.length,word_count:Number(parsed?.word_count || (text?text.split(/\s+/).length:0)),title_similarity:titleSimilarity(sample.title,parsed?.title || ''),error:null};
      } catch (error) {
        row.postlight.error=String(error?.message || error).slice(0,300);
      }
    }
  } catch (error) {
    row.fetch_error=String(error?.name === 'AbortError' ? 'fetch timeout' : (error?.message || error)).slice(0,300);
  }
  rows.push(row);
  console.log(`${row.source_id} fetch=${row.fetch_status ?? 'ERR'} readability=${row.readability.text_length} postlight=${row.postlight.text_length}`);
}

const bySource={};
for (const row of rows) {
  const s=bySource[row.source_id] ||= {samples:0,fetch_success:0,readability_success:0,postlight_success:0,readability_lengths:[],postlight_lengths:[],readability_title_scores:[],postlight_title_scores:[]};
  s.samples++;
  if (row.fetch_ok) s.fetch_success++;
  if (row.readability.success) s.readability_success++;
  if (row.postlight.success) s.postlight_success++;
  if (row.readability.text_length) s.readability_lengths.push(row.readability.text_length);
  if (row.postlight.text_length) s.postlight_lengths.push(row.postlight.text_length);
  if (row.readability.title_similarity) s.readability_title_scores.push(row.readability.title_similarity);
  if (row.postlight.title_similarity) s.postlight_title_scores.push(row.postlight.title_similarity);
}
for (const s of Object.values(bySource)) {
  s.fetch_rate=s.samples?s.fetch_success/s.samples:0;
  s.readability_success_rate=s.samples?s.readability_success/s.samples:0;
  s.postlight_success_rate=s.samples?s.postlight_success/s.samples:0;
  s.readability_median_chars=median(s.readability_lengths);
  s.postlight_median_chars=median(s.postlight_lengths);
  s.readability_median_title_similarity=median(s.readability_title_scores);
  s.postlight_median_title_similarity=median(s.postlight_title_scores);
  delete s.readability_lengths; delete s.postlight_lengths; delete s.readability_title_scores; delete s.postlight_title_scores;
}

const summary={generated_at:new Date().toISOString(),sample_count:rows.length,source_count:Object.keys(bySource).length,threshold:'success requires >=200 extracted text characters',by_source:bySource};
fs.writeFileSync(path.join(outputDir,'summary.json'),JSON.stringify(summary,null,2));
fs.writeFileSync(path.join(outputDir,'samples.json'),JSON.stringify(rows,null,2));
console.log(JSON.stringify(summary,null,2));
