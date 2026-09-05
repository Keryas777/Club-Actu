import { normalizeTopicText } from './grouper.js';

export const EVENT_EXTRACTOR_VERSION = 'phase-b-event-extractor-v0.1';

const FAMILY_PATTERNS = {
  transfer: [/\bmercato\b/i,/\btransfert\b/i,/\brecrut(?:e|er|ement)\b/i,/\bpr[eê]t\b/i,/\boffre\b/i,/\bn[eé]goci/i,/\baccord\b/i,/\bvisite m[eé]dicale\b/i,/\bsign(?:e|er|é|ée|ent)\b/i,/\bsignature\b/i,/\bquitt(?:e|er|é|ée|ent)\b/i,/\bfile (?:à|a|vers)\b/i,/\brejoint\b/i,/\bpart(?:ir|ira|i|ent)\b/i,/\bd[eé]part\b/i,/\bcibl(?:e|é|ée|ent)\b/i,/\bdiscut(?:e|ent|ions?)\b/i],
  contract: [/\bprolong/i,/\bcontrat\b/i,/\brenouvel/i,/\bjusqu['’]?en 20\d{2}\b/i],
  injury: [/\bbless/i,/\bforfait\b/i,/\binfirmerie\b/i,/\bexamens?\b/i,/\bdiagnostic\b/i,/\bl[eé]sion\b/i,/\bentorse\b/i,/\bligament/i,/\breprise individuelle\b/i,/\breprise collective\b/i,/\bretour à l['’]entra[iî]nement\b/i,/\bretour a l['’]entrainement\b/i],
  discipline: [/\bsuspend/i,/\bsanction/i,/\bdisciplin/i,/\bcommission\b/i,/\bappel\b/i,/\bexpuls/i,/\bcarton rouge\b/i],
  finance: [/\bdncg\b/i,/\bfinanc/i,/\bdette\b/i,/\bcapital\b/i,/\bactionnaire\b/i,/\bpropri[eé]t/i,/\brachat\b/i,/\bcession\b/i],
  institutional: [/\bpr[eé]sident\b/i,/\bdirecteur g[eé]n[eé]ral\b/i,/\bgouvernance\b/i,/\bconseil d['’]administration\b/i,/\brestructuration\b/i],
  staff: [/\bentra[iî]neur\b/i,/\bcoach\b/i,/\bstaff\b/i,/\bmanager\b/i,/\bdirecteur sportif\b/i,/\blicenci/i,/\blimog/i,/\bsuccesseur\b/i,/\bsur le banc\b/i],
  competition: [/\btirage\b/i,/\bqualification\b/i,/\bqualifi[eé]\b/i,/\b[eé]limin/i,/\bbarrages?\b/i,/\bphase de ligue\b/i,/\bhuiti[eè]mes?\b/i,/\bquarts?\b/i,/\bdemi-final/i,/\bfinale\b/i],
  match: [/\bavant-match\b/i,/\bapr[eè]s-match\b/i,/\bcomposition\b/i,/\bcompo\b/i,/\bcoup d['’]envoi\b/i,/\br[eé]sultat\b/i,/\bscore\b/i,/\bvictoire\b/i,/\bd[eé]faite\b/i,/\bmatch\b/i],
  statement: [/\bd[eé]clare\b/i,/\bexplique\b/i,/\bconfie\b/i,/\binterview\b/i,/\bconf[eé]rence de presse\b/i,/\br[eé]agit\b/i,/\br[eé]ponse\b/i]
};

const FAMILY_PRIORITY = ['injury','contract','discipline','finance','institutional','staff','transfer','competition','match','statement'];
const TRANSFER_STAGES = [
  ['official', /\bofficiel(?:le)?\b|\bofficialis|\bsign[eé](?:e|er)?\b|\bsignature\b/i],
  ['medical', /\bvisite m[eé]dicale\b|\bexamens? m[eé]dicaux\b/i],
  ['agreement', /\baccord (?:trouv[eé]|total|de principe)|\baccord entre\b|\baccord avec\b/i],
  ['failed', /\b[eé]chec\b|\bcapote\b|\babandon\b|\brefus[eé]\b|\bpiste .* referm/i],
  ['negotiation', /\bn[eé]goci|\bdiscussions?\b|\bdiscut(?:e|ent)\b|\boffre\b|\bproposition\b/i],
  ['interest', /\bint[eé]r[eê]t\b|\bcibl(?:e|é|ée)\b|\bsur les rangs\b|\bpense à\b|\bpense a\b|\bsouhaite recruter\b/i]
];
const INJURY_STAGES = [
  ['match_return', /\bretour (?:dans le groupe|à la comp[eé]tition|a la competition|sur les terrains?)\b/i],
  ['training_return', /\breprise (?:individuelle|collective)|\bretour à l['’]entra[iî]nement|\bretour a l['’]entrainement/i],
  ['recovery', /\br[eé][eé]ducation\b|\br[eé]cup[eé]ration\b|\bconvalescence\b/i],
  ['diagnosis', /\bdiagnostic\b|\bexamens?\b|\bl[eé]sion\b|\bligament/i],
  ['incident', /\bbless[eé]\b|\bdouleur\b|\btorsion\b|\bentorse\b|\bchoc\b/i]
];
const KNOWN_EXTERNAL_CLUBS = [
  ['Aston Villa',['aston villa']],['Crystal Palace',['crystal palace']],['Chelsea',['chelsea']],['Liverpool',['liverpool']],['AS Monaco',['as monaco','monaco']],['LOSC',['losc','lille']],['Real Madrid',['real madrid']],['FC Barcelona',['fc barcelona','barcelone','barça','barca']],['Manchester City',['manchester city']],['Manchester United',['manchester united']],['Arsenal',['arsenal']],['Tottenham',['tottenham']],['Bayern Munich',['bayern munich','bayern']],['Inter Milan',['inter milan','inter']],['AC Milan',['ac milan']],['Juventus',['juventus']],['AS Roma',['as roma','roma','rome']],['Napoli',['napoli','naples']],['Atlético Madrid',['atletico madrid','atlético madrid']]
];
const COMPETITIONS = [
  ['Ligue 1',/\bligue 1\b/i],['Ligue des champions',/\bligue des champions\b|\bchampions league\b/i],['Ligue Europa',/\bligue europa\b|\beuropa league\b/i],['Coupe de France',/\bcoupe de france\b/i],['Trophée des Champions',/\btroph[eé]e des champions\b/i]
];
const STOP = new Set(['mercato','football','match','club','equipe','équipe','joueur','joueurs','officiel','officielle','ligue','championnat','saison','direct','info','news','transfert']);

const uniq = (values) => [...new Set(values.filter(Boolean))];
const cleanText = (value='') => String(value || '').replace(/\r/g,'').trim();

function splitSegments(article) {
  const title=cleanText(article.title), excerpt=cleanText(article.excerpt), content=cleanText(article.content);
  const rawParts=content.split(/\n\s*\n+|\n(?=#{1,4}\s|[A-ZÀ-ÖØ-Ý][^\n]{3,80}:\s*$)/).map(s=>s.trim()).filter(s=>s.length>=18);
  const parts=[];
  if (title || excerpt) parts.push({kind:'lead',text:[title,excerpt].filter(Boolean).join('. ')});
  for (const text of rawParts) parts.push({kind:'paragraph',text});
  if (!parts.length && (title || excerpt || content)) parts.push({kind:'fallback',text:[title,excerpt,content].filter(Boolean).join('. ')});
  return parts.slice(0,40);
}

function classifyFamily(text) {
  const matches=FAMILY_PRIORITY.filter(f=>FAMILY_PATTERNS[f].some(re=>re.test(text)));
  if (!matches.length) return 'unknown';
  const substantive=matches.filter(f=>f!=='statement' && f!=='match');
  if (substantive.length) return substantive[0];
  if (matches.includes('match')) return 'match';
  return matches[0] || 'unknown';
}

function makeClubDictionary(context={}) {
  const dict=[];
  for (const club of context.clubs || []) {
    const aliases=uniq([club.name,club.id,...(club.aliases||[])]);
    if (aliases.length) dict.push([club.name || club.id,aliases]);
  }
  return [...dict,...KNOWN_EXTERNAL_CLUBS];
}

function escapeRe(value) { return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
function detectClubs(text,context={}) {
  const norm=` ${normalizeTopicText(text)} `, hits=[];
  for (const [name,aliases] of makeClubDictionary(context)) {
    let best=0;
    for (const alias of aliases) {
      const a=normalizeTopicText(alias);
      if (!a || a.length<2) continue;
      if (new RegExp(`(?:^|\\s)${escapeRe(a)}(?:$|\\s)`,'i').test(norm)) best=Math.max(best,a.split(' ').length+(a.length>5?1:0));
    }
    if (best) hits.push({name,score:best});
  }
  return hits.sort((a,b)=>b.score-a.score).map(x=>x.name).slice(0,4);
}

function detectKnownPeople(text,context={}) {
  const norm=normalizeTopicText(text), hits=[];
  for (const person of context.people || []) {
    let count=0;
    for (const alias of uniq([person.name,...(person.aliases||[])])) {
      const a=normalizeTopicText(alias);
      if (!a || a.length<3) continue;
      count += [...norm.matchAll(new RegExp(`(?:^|\\s)${escapeRe(a)}(?=$|\\s)`,'g'))].length;
    }
    if (count) hits.push({name:person.name,count});
  }
  return hits.sort((a,b)=>b.count-a.count).map(x=>x.name);
}

function detectProperPeople(text,context={}) {
  const clubTerms=new Set();
  for (const [name,aliases] of makeClubDictionary(context)) for (const value of [name,...aliases]) clubTerms.add(normalizeTopicText(value));
  const rejected=new Set(['mercato','football','ligue','champions','league','coupe','france','officiel','officielle','samedi','dimanche','lundi','mardi','mercredi','jeudi','vendredi','septembre','octobre','novembre','decembre','janvier','fevrier','mars','avril','mai','juin','juillet','aout','paris','lyon','marseille']);
  const scores=new Map();
  const re=/\b([A-ZÀ-ÖØ-Ý][a-zà-öø-ÿ'’-]{2,}(?:\s+[A-ZÀ-ÖØ-Ý][a-zà-öø-ÿ'’-]{2,}){0,2})\b/g;
  for (const match of text.matchAll(re)) {
    const value=match[1].trim(), norm=normalizeTopicText(value), parts=norm.split(' ');
    if (!norm || clubTerms.has(norm) || parts.some(t=>STOP.has(t)||rejected.has(t))) continue;
    if (parts.length===1 && match.index===0) continue;
    if (parts.length===1 && value.length<5) continue;
    scores.set(value,(scores.get(value)||0)+1+(parts.length>1?2:0));
  }
  return [...scores.entries()].sort((a,b)=>b[1]-a[1]).map(([name])=>name).slice(0,4);
}
function detectPeople(text,context={}) { return uniq([...detectKnownPeople(text,context),...detectProperPeople(text,context)]).slice(0,3); }
function findStage(text,rules) { for (const [stage,re] of rules) if (re.test(text)) return stage; return 'unknown'; }
function detectCompetition(text) { for (const [name,re] of COMPETITIONS) if (re.test(text)) return name; return null; }
function extractMatchAnchor(text) {
  return text.match(/\b(\d{1,2}(?:e|er)?\s+journ[eé]e|journ[eé]e\s+\d{1,2}|huiti[eè]mes?|quarts?|demi-finales?|finale|barrages?)\b/i)?.[1]
    || text.match(/\b(\d{1,2}\s+(?:janvier|f[eé]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[eé]cembre)(?:\s+20\d{2})?)\b/i)?.[1]
    || null;
}
function relationHints(family,text,clubs) {
  if (family!=='transfer') return {};
  const norm=normalizeTopicText(text); let club_from=null,club_to=null;
  for (const club of clubs) {
    const c=escapeRe(normalizeTopicText(club));
    if (new RegExp(`(?:vers|rejoint|file a|file vers)\\s+(?:le |la |l )?${c}`).test(norm)) club_to=club;
    if (new RegExp(`(?:quitte|depart de|provenance de)\\s+(?:le |la |l )?${c}`).test(norm)) club_from=club;
  }
  return {club_from,club_to};
}
function lexicalFingerprint(text,family,people,clubs) {
  const tokens=uniq(normalizeTopicText(text).split(' ').filter(t=>t.length>=4&&!STOP.has(t)&&!/^\d+$/.test(t))).slice(0,24);
  return {family,people,clubs,tokens};
}
function shouldEmit(family,people,clubs,text) {
  if (family==='unknown') return people.length>0 && clubs.length>0 && text.length>=40;
  if (['transfer','contract','injury','staff','statement'].includes(family)) return people.length>0;
  if (family==='match'||family==='competition') return clubs.length>0;
  return people.length>0 || clubs.length>0;
}
function eventKey(event) { return [event.family,...event.primary_people,...event.primary_clubs,event.relation_hints?.club_to||''].map(normalizeTopicText).filter(Boolean).join('|'); }
function mergeAdjacent(events) {
  const out=[];
  for (const event of events) {
    const prev=out[out.length-1];
    if (prev && eventKey(prev) && eventKey(prev)===eventKey(event)) {
      prev.evidence.fragments.push(...event.evidence.fragments);
      prev.evidence.text=prev.evidence.fragments.join('\n').slice(0,1800);
      prev.lexical_fingerprint=lexicalFingerprint(prev.evidence.text,prev.family,prev.primary_people,prev.primary_clubs);
    } else out.push(event);
  }
  return out;
}

export function extractEventCandidates(article,context={}) {
  const events=[], title=cleanText(article.title);
  for (const [index,segment] of splitSegments(article).entries()) {
    const text=segment.text, family=classifyFamily(text), primary_clubs=detectClubs(text,context), primary_people=detectPeople(text,context);
    if (!shouldEmit(family,primary_people,primary_clubs,text)) continue;
    let stage=null, family_discriminator=null;
    if (family==='transfer') stage=findStage(text,TRANSFER_STAGES);
    if (family==='injury') stage=findStage(text,INJURY_STAGES);
    if (family==='match') family_discriminator={competition:detectCompetition(text),match_anchor:extractMatchAnchor(text),opponents:primary_clubs.slice(0,2)};
    else if (family==='competition') family_discriminator={competition:detectCompetition(text),phase:extractMatchAnchor(text)};
    else if (family==='discipline'||family==='finance') family_discriminator={procedure_anchor:normalizeTopicText(text).split(' ').slice(0,18).join(' ')||null};
    events.push({family,primary_people,primary_clubs,relation_hints:relationHints(family,text,primary_clubs),stage,family_discriminator,evidence:{kind:segment.kind,segment_index:index,text:text.slice(0,1800),fragments:[text.slice(0,1800)],title},lexical_fingerprint:lexicalFingerprint(text,family,primary_people,primary_clubs)});
  }
  return mergeAdjacent(events);
}

export async function getPhaseBEventPreview(db,clubId='ol',articleLimit=60,articleId=null) {
  const {results:aliases}=await db.prepare('SELECT club_id, alias, strength FROM club_aliases').all();
  const clubMap=new Map();
  for (const row of aliases||[]) {
    if (!clubMap.has(row.club_id)) clubMap.set(row.club_id,{id:row.club_id,name:row.club_id.toUpperCase(),aliases:[]});
    clubMap.get(row.club_id).aliases.push(row.alias);
  }
  const articleFilter=articleId?'AND r.id = ?':'';
  const bindings=articleId?[clubId,articleId,1]:[clubId,articleLimit];
  const {results:articles}=await db.prepare(`SELECT r.id,r.source_id,COALESCE(e.normalized_title,r.title) AS title,COALESCE(e.normalized_published_at,r.published_at,r.last_seen_at) AS published_at,COALESCE(e.normalized_excerpt,r.excerpt,'') AS excerpt,COALESCE(e.normalized_content,r.raw_content,'') AS content FROM article_club_assessments a JOIN raw_articles r ON r.id=a.article_id JOIN article_extractions e ON e.article_id=r.id AND e.source_content_hash=r.content_hash AND e.extractor_version='phase-a-extractor-v1' AND e.status='completed' WHERE a.club_id=? AND a.decision='relevant' AND a.source_content_hash=r.content_hash AND a.rule_version='phase-a-relevance-v3' ${articleFilter} ORDER BY COALESCE(e.normalized_published_at,r.published_at,r.last_seen_at) DESC LIMIT ?`).bind(...bindings).all();
  const context={clubs:[...clubMap.values()]};
  const rows=(articles||[]).map(article=>({article:{id:article.id,source_id:article.source_id,title:article.title,published_at:article.published_at},events:extractEventCandidates(article,context)}));
  const familyCounts=new Map(), eventCountDistribution={}; let zero=0,one=0,multi=0,total=0,unknown=0,missingPeople=0,missingClubs=0;
  for (const row of rows) {
    const n=row.events.length; eventCountDistribution[n]=(eventCountDistribution[n]||0)+1; if(n===0)zero++;else if(n===1)one++;else multi++; total+=n;
    for (const event of row.events) { familyCounts.set(event.family,(familyCounts.get(event.family)||0)+1); if(event.family==='unknown')unknown++; if(!event.primary_people.length)missingPeople++; if(!event.primary_clubs.length)missingClubs++; }
  }
  return {version:EVENT_EXTRACTOR_VERSION,club_id:clubId,article_id:articleId||null,article_count:rows.length,event_count:total,articles_with_0_events:zero,articles_with_1_event:one,articles_with_multiple_events:multi,multi_event_rate:rows.length?multi/rows.length:0,unknown_family_rate:total?unknown/total:0,events_without_primary_people:missingPeople,events_without_primary_clubs:missingClubs,family_distribution:Object.fromEntries([...familyCounts.entries()].sort((a,b)=>b[1]-a[1])),events_per_article_distribution:eventCountDistribution,articles:rows};
}
