import { normalizeTopicText } from './grouper.js';
import { extractEventCandidates as extractBaseCandidates } from './phase-b-events.js';

export const EVENT_EXTRACTOR_VERSION = 'phase-b-event-extractor-v0.4';

const PREVIEW_TITLE = /\b(?:pronostic|avant[- ]match|composition probable|compo probable)\b/i;
const ROUNDUP_TITLE = /\b(?:jt foot mercato|les infos du jour|le point mercato|point mercato|\d+ transferts?|\d+ joueurs libres)\b/i;
const BODY_NOISE = /^(?:composition probable|historique\b|classement\b|les cotes\b|notre pronostic\b|pronostic\b|effectif\b|l['’ ]?infirmerie\b|infirmerie\b|les derni[eè]res confrontations\b|face[- ]a[- ]face\b|voir aussi\b|lire aussi\b)/i;
const HISTORICAL_CONTEXT = /\b(?:saison derni[eè]re|saison pass[eé]e|l['’ ]an dernier|avait d[eé]j[aà]|avaient d[eé]j[aà]|lors de la premi[eè]re journ[eé]e|la saison pr[eé]c[eé]dente)\b/i;
const STRONG_EVENT_ACTION = /\b(?:officialis\w*|sign(?:e|é|ée|er|ent)?|rejoint|quitt(?:e|é|ée|er|ent)?|transf[eè]r\w*|accord|offre|n[eé]goci\w*|discut\w*|cibl\w*|pr[eê]t|prolong\w*|renouvel\w*|bless\w*|forfait|diagnostic|suspend\w*|sanction\w*|limog\w*|licenci\w*|nomm\w*|d[eé]mis|rachat|cession|dncg|qualifi\w*|[eé]limin\w*|victoire|d[eé]faite|score)\b/i;
const REJECTED_PERSON = /^(?:c['’ ]?est|pronostic|premier|pourquoi|est[- ]ce|d['’ ]?abord|l['’ ]?information|l['’ ]?autre|l['’ ]?avenir|l['’ ]?ancien|l['’ ]?attaquant|l['’ ]?arbitre|l['’ ]?effectif|l['’ ]?historique|l['’ ]?infirmerie|l['’ ]?arriv[eé]e|l['’ ]?ailier|l['’ ]?an|j['’ ]?ai|s['’ ]?il|celui-ci|celle-ci|bonne|les parisiens|les gones|les marseillais|les eagles|les black cats|les bianconeri)$/i;
const ORGANISATION_LIKE_PERSON = /\b(?:city|united|football club|\bfc\b|\bcf\b|\bafc\b|stade|olympique|ajax|slovan|borussia|sporting|palace|black cats|caught offside|actu foot|massilia zone|tunisie num[eé]rique)\b/i;
const TITLE_TRANSFER = /\b(?:mercato|transfert|recrut\w*|offre|accord|sign\w*|rejoint|quitt\w*|d[eé]part|cibl\w*|n[eé]goci\w*|pr[eê]t)\b/i;
const TITLE_CONTRACT = /\b(?:prolong\w*|renouvel\w*|contrat)\b/i;
const TITLE_INJURY = /\b(?:bless\w*|forfait|infirmerie|diagnostic|l[eé]sion)\b/i;
const TITLE_DISCIPLINE = /\b(?:suspend\w*|sanction\w*|commission de discipline|carton rouge)\b/i;
const TITLE_FINANCE = /\b(?:dncg|dette|budget|comptes?|capital|actionnaire|rachat|cession)\b/i;
const TITLE_STAFF = /\b(?:entra[iî]neur|coach|manager|directeur sportif|staff)\b.*\b(?:avenir|d[eé]part|quitt\w*|limog\w*|licenci\w*|nomm\w*|remplac\w*)\b/i;
const TITLE_COMPETITION = /\b(?:tirage|qualification|qualifi[eé]|[eé]limin\w*|barrages?|huiti[eè]mes?|quarts?|demi-final\w*|finale)\b/i;
const TITLE_MATCH = /\b(?:avant[- ]match|apr[eè]s[- ]match|composition|compo|score|victoire|d[eé]faite|match)\b/i;
const HARD_RUPTURE_FAMILIES = new Set(['injury', 'discipline', 'institutional']);
const TOKEN_STOP = new Set([
  'mercato','football','match','club','equipe','joueur','joueurs','officiel','officielle','ligue','championnat','saison','direct','info','news','transfert',
  'pour','avec','dans','sur','des','les','une','est','sont','plus','apres','avant','mais','aux','par','que','qui','son','ses','leur','leurs','du','de','la','le','un','et'
]);

function uniq(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function uniqNormalized(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const normalized = normalizeTopicText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(value);
  }
  return out;
}

function tokens(text = '') {
  return new Set(
    normalizeTopicText(text)
      .split(' ')
      .filter((token) => token.length >= 4 && !TOKEN_STOP.has(token) && !/^\d+$/.test(token))
  );
}

function intersectionCount(a, b) {
  let count = 0;
  for (const value of a) if (b.has(value)) count++;
  return count;
}

function normalizedSet(values = []) {
  return new Set(values.map(normalizeTopicText).filter(Boolean));
}

function cleanPersonValue(value = '') {
  let clean = String(value || '').replace(/\s+/g, ' ').trim();
  clean = clean.replace(/^[«“”"'`]+|[»“”"'`,:;.!?]+$/g, '').trim();
  clean = clean.replace(/^(?:avec|recruter|avantage|pour)\s+/i, '').trim();
  return clean;
}

function sanitizePeople(values = [], clubs = []) {
  const clubNames = normalizedSet(clubs);
  const out = [];
  const seen = new Set();
  for (const raw of values || []) {
    const value = cleanPersonValue(raw);
    const normalized = normalizeTopicText(value);
    if (!value || !normalized || seen.has(normalized)) continue;
    if (REJECTED_PERSON.test(value)) continue;
    if (clubNames.has(normalized)) continue;
    if (ORGANISATION_LIKE_PERSON.test(value)) continue;
    if (/^(?:celui|celle|ceux|celles|lui|elle|eux|elles)$/i.test(value)) continue;
    seen.add(normalized);
    out.push(value);
  }
  return out;
}

function cloneWithSanitizedPeople(event) {
  const primary_people = sanitizePeople(event.primary_people, event.primary_clubs);
  return {
    ...event,
    primary_people,
    lexical_fingerprint: {
      ...(event.lexical_fingerprint || {}),
      people: primary_people
    }
  };
}

function leadEvent(events) {
  return events.find((event) => event?.evidence?.kind === 'lead') || null;
}

function bodyLooksEditorial(text = '') {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (!compact) return true;
  if (BODY_NOISE.test(compact)) return true;
  if (/^.{0,120}[?]$/.test(compact) && !STRONG_EVENT_ACTION.test(compact)) return true;
  if (/^(?:un feu vert|premier signal faible)\b/i.test(compact)) return true;
  return false;
}

function personMentionedInTitle(person, title = '') {
  const personNorm = normalizeTopicText(person);
  const titleNorm = normalizeTopicText(title);
  if (!personNorm || !titleNorm) return false;
  if (` ${titleNorm} `.includes(` ${personNorm} `)) return true;
  const parts = personNorm.split(' ').filter(Boolean);
  const surname = parts[parts.length - 1] || '';
  return surname.length >= 5 && new RegExp(`(?:^|\\s)${surname}(?:$|\\s)`).test(titleNorm);
}

function mainProtagonists(lead, title = '') {
  const people = sanitizePeople(lead?.primary_people || [], lead?.primary_clubs || []);
  if (!people.length) return [];
  const titlePeople = people.filter((person) => personMentionedInTitle(person, title));
  return (titlePeople.length ? titlePeople : people.slice(0, 1)).slice(0, 3);
}

function dominantFamilyFromTitle(title = '', leadFamily = 'unknown') {
  if (TITLE_INJURY.test(title)) return 'injury';
  if (TITLE_DISCIPLINE.test(title)) return 'discipline';
  if (TITLE_TRANSFER.test(title)) return 'transfer';
  if (TITLE_CONTRACT.test(title)) return 'contract';
  if (TITLE_STAFF.test(title)) return 'staff';
  if (TITLE_FINANCE.test(title)) return 'finance';
  if (TITLE_COMPETITION.test(title)) return 'competition';
  if (TITLE_MATCH.test(title)) return 'match';
  return leadFamily || 'unknown';
}

function familiesCompatible(dominantFamily, family) {
  if (!dominantFamily || dominantFamily === 'unknown') return family === 'unknown' || family === 'statement';
  if (family === dominantFamily || family === 'unknown' || family === 'statement') return true;
  const compatible = {
    transfer: new Set(['contract', 'finance', 'staff', 'competition', 'match']),
    contract: new Set(['transfer', 'finance']),
    injury: new Set(['match']),
    discipline: new Set(['match']),
    staff: new Set(['institutional', 'contract']),
    finance: new Set(['institutional', 'transfer']),
    institutional: new Set(['finance', 'staff']),
    competition: new Set(['match']),
    match: new Set(['competition'])
  };
  return compatible[dominantFamily]?.has(family) || false;
}

function sharesProtagonist(event, protagonists) {
  if (!protagonists?.length) return false;
  const people = normalizedSet(event.primary_people || []);
  return protagonists.some((person) => people.has(normalizeTopicText(person)));
}

function isTrueRupture(event, dominantFamily, lexicalOverlap, historical) {
  if (historical || event.family === dominantFamily || event.family === 'unknown' || event.family === 'statement') return false;
  const text = String(event?.evidence?.text || '');
  const explicitAction = STRONG_EVENT_ACTION.test(text);
  if (!explicitAction) return false;
  if (HARD_RUPTURE_FAMILIES.has(event.family)) return true;
  return lexicalOverlap >= 2;
}

function isCentralBodyEvent(event, article, lead, protagonists, dominantFamily) {
  const text = String(event?.evidence?.text || '');
  if (bodyLooksEditorial(text)) return false;

  const title = String(article?.title || '');
  if (PREVIEW_TITLE.test(title)) {
    // A preview/pronostic article is itself one match dossier. Its historical
    // results, probable line-ups, injuries and form guide are context, not
    // independent event candidates.
    return false;
  }

  const eventClubs = normalizedSet(event.primary_clubs || []);
  const leadClubs = normalizedSet(lead?.primary_clubs || []);
  const sharedClubs = intersectionCount(eventClubs, leadClubs);
  const sameFamily = Boolean(lead && event.family === lead.family);
  const lexicalOverlap = intersectionCount(tokens(title), tokens(text));
  const explicitAction = STRONG_EVENT_ACTION.test(text);
  const historical = HISTORICAL_CONTEXT.test(text);

  // Roundups are intentionally multi-event, but each retained item still needs
  // a factual action. Mere mentions/headings are discarded.
  if (ROUNDUP_TITLE.test(title)) {
    return event.family !== 'unknown' && explicitAction && !historical;
  }

  // A repeated protagonist is not automatically a new event. When the body is
  // still describing the title/lead dossier, keep it so it can be coalesced
  // under the dominant family. Only a strong incompatible factual rupture may
  // survive as an independent event.
  if (sharesProtagonist(event, protagonists)) {
    if (familiesCompatible(dominantFamily, event.family)) return true;
    return isTrueRupture(event, dominantFamily, lexicalOverlap, historical);
  }

  // When the title has no named protagonist (finance/institutional/match), two
  // shared clubs plus the same family is a strong enough central anchor.
  if (sameFamily && sharedClubs >= 2) return true;

  // A body paragraph can reveal the concrete actor omitted from a generic title,
  // but it must stay lexically tied to that title and express a factual action.
  if (sameFamily && lexicalOverlap >= 2 && explicitAction && !historical) return true;
  if (!protagonists.length && sameFamily && sharedClubs >= 1 && lexicalOverlap >= 1 && explicitAction && !historical) return true;

  // Independent sub-events require stronger evidence than a contextual mention.
  if (event.family !== 'unknown' && lexicalOverlap >= 3 && explicitAction && !historical) return true;

  return false;
}

function coalesceFamily(event, family) {
  if (!family || family === 'unknown' || event.family === family) return event;
  return {
    ...event,
    family,
    lexical_fingerprint: {
      ...(event.lexical_fingerprint || {}),
      family
    }
  };
}

function coalesceMainDossier(events, article, lead, protagonists, dominantFamily) {
  const title = String(article?.title || '');
  if (!events.length || ROUNDUP_TITLE.test(title) || !protagonists.length || !dominantFamily) return events;

  return events.map((event) => {
    if (event === lead || event?.evidence?.kind === 'lead') {
      return coalesceFamily(event, dominantFamily);
    }
    if (!sharesProtagonist(event, protagonists)) return event;
    if (!familiesCompatible(dominantFamily, event.family)) return event;
    return coalesceFamily(event, dominantFamily);
  });
}

function eventMergeKey(event, protagonists = []) {
  const people = normalizedSet(event.primary_people || []);
  const preferred = protagonists.find((person) => people.has(normalizeTopicText(person)));
  const person = normalizeTopicText(preferred || event.primary_people?.[0] || '');
  if (person) return `${event.family}|person:${person}`;
  const clubs = (event.primary_clubs || []).map(normalizeTopicText).filter(Boolean).sort().slice(0, 2);
  return `${event.family}|clubs:${clubs.join('+')}`;
}

function mergeSameDossier(events, protagonists = []) {
  const out = [];
  const byKey = new Map();
  for (const event of events) {
    const key = eventMergeKey(event, protagonists);
    const existing = byKey.get(key);
    if (!existing || !key) {
      out.push(event);
      if (key) byKey.set(key, event);
      continue;
    }

    existing.primary_people = uniqNormalized([...existing.primary_people, ...event.primary_people]).slice(0, 3);
    existing.primary_clubs = uniqNormalized([...existing.primary_clubs, ...event.primary_clubs]).slice(0, 4);
    existing.evidence.fragments = uniq([
      ...(existing.evidence?.fragments || []),
      ...(event.evidence?.fragments || [])
    ]).slice(0, 8);
    existing.evidence.text = existing.evidence.fragments.join('\n').slice(0, 1800);

    const stages = [existing.stage, event.stage].filter(Boolean).filter((stage) => stage !== 'unknown');
    if (stages.length) existing.stage = stages[stages.length - 1];

    existing.relation_hints = {
      ...(existing.relation_hints || {}),
      ...Object.fromEntries(
        Object.entries(event.relation_hints || {}).filter(([, value]) => value != null)
      )
    };
    if (!existing.family_discriminator && event.family_discriminator) {
      existing.family_discriminator = event.family_discriminator;
    }

    existing.lexical_fingerprint = {
      ...(existing.lexical_fingerprint || {}),
      family: existing.family,
      people: existing.primary_people,
      clubs: existing.primary_clubs,
      tokens: uniq([
        ...(existing.lexical_fingerprint?.tokens || []),
        ...(event.lexical_fingerprint?.tokens || [])
      ]).slice(0, 24)
    };
  }
  return out;
}

export function extractEventCandidates(article, context = {}) {
  const baseEvents = extractBaseCandidates(article, context).map(cloneWithSanitizedPeople);
  const lead = leadEvent(baseEvents);
  const title = String(article?.title || '');
  const protagonists = mainProtagonists(lead, title);
  const dominantFamily = dominantFamilyFromTitle(title, lead?.family || 'unknown');

  const retained = baseEvents.filter((event) => {
    if (event?.evidence?.kind === 'lead') return true;
    return isCentralBodyEvent(event, article, lead, protagonists, dominantFamily);
  });

  const coalesced = coalesceMainDossier(retained, article, lead, protagonists, dominantFamily);
  return mergeSameDossier(coalesced, protagonists);
}
