import { normalizeTopicText } from './grouper.js';
import { extractEventCandidates as extractBaseCandidates } from './phase-b-events.js';

export const EVENT_EXTRACTOR_VERSION = 'phase-b-event-extractor-v0.3';

const PREVIEW_TITLE = /\b(?:pronostic|avant[- ]match|composition probable|compo probable)\b/i;
const ROUNDUP_TITLE = /\b(?:jt foot mercato|les infos du jour|le point mercato|point mercato|\d+ transferts?|\d+ joueurs libres)\b/i;
const BODY_NOISE = /^(?:composition probable|historique\b|classement\b|les cotes\b|notre pronostic\b|pronostic\b|effectif\b|l['’ ]?infirmerie\b|infirmerie\b|les derni[eè]res confrontations\b|face[- ]a[- ]face\b|voir aussi\b|lire aussi\b)/i;
const HISTORICAL_CONTEXT = /\b(?:saison derni[eè]re|saison pass[eé]e|l['’ ]an dernier|avait d[eé]j[aà]|avaient d[eé]j[aà]|lors de la premi[eè]re journ[eé]e|la saison pr[eé]c[eé]dente)\b/i;
const STRONG_EVENT_ACTION = /\b(?:officialis|sign(?:e|é|ée|er|ent)?|rejoint|quitt(?:e|é|ée|er|ent)?|transf[eè]r|accord|offre|n[eé]goci|cibl|pr[eê]t|prolong|renouvel|bless|forfait|diagnostic|suspend|sanction|limog|licenci|nomm|d[eé]mis|rachat|cession|dncg|qualifi|[eé]limin|victoire|d[eé]faite|score)\b/i;
const REJECTED_PERSON = /^(?:c['’ ]?est|pronostic|premier|pourquoi|est[- ]ce|l['’ ]?effectif|l['’ ]?historique|l['’ ]?infirmerie|l['’ ]?arriv[eé]e|l['’ ]?ailier|les parisiens|les gones|les marseillais|les eagles|les black cats|les bianconeri)$/i;
const TOKEN_STOP = new Set([
  'mercato','football','match','club','equipe','joueur','joueurs','officiel','officielle','ligue','championnat','saison','direct','info','news','transfert',
  'pour','avec','dans','sur','des','les','une','est','sont','plus','apres','avant','mais','aux','par','que','qui','son','ses','leur','leurs','du','de','la','le','un','et'
]);

function uniq(values) {
  return [...new Set((values || []).filter(Boolean))];
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

function sanitizePeople(values = []) {
  return uniq(values).filter((value) => !REJECTED_PERSON.test(String(value || '').trim()));
}

function cloneWithSanitizedPeople(event) {
  const primary_people = sanitizePeople(event.primary_people);
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

function isCentralBodyEvent(event, article, lead) {
  const text = String(event?.evidence?.text || '');
  if (bodyLooksEditorial(text)) return false;

  const title = String(article?.title || '');
  if (PREVIEW_TITLE.test(title)) {
    // A preview/pronostic article is itself one match dossier. Its historical
    // results, probable line-ups, injuries and form guide are context, not
    // independent event candidates.
    return false;
  }

  const eventPeople = normalizedSet(event.primary_people || []);
  const eventClubs = normalizedSet(event.primary_clubs || []);
  const leadPeople = normalizedSet(lead?.primary_people || []);
  const leadClubs = normalizedSet(lead?.primary_clubs || []);
  const sharedPeople = intersectionCount(eventPeople, leadPeople);
  const sharedClubs = intersectionCount(eventClubs, leadClubs);
  const sameFamily = Boolean(lead && event.family === lead.family);
  const lexicalOverlap = intersectionCount(tokens(title), tokens(text));
  const explicitAction = STRONG_EVENT_ACTION.test(text);
  const historical = HISTORICAL_CONTEXT.test(text);

  // Strongest signal: the body continues the dossier's named protagonist.
  if (sharedPeople > 0) return true;

  // Roundups are intentionally multi-event, but each retained item still needs
  // a factual action. Mere mentions/headings are discarded.
  if (ROUNDUP_TITLE.test(title)) {
    return event.family !== 'unknown' && explicitAction && !historical;
  }

  // When the title has no named protagonist (finance/institutional/match), two
  // shared clubs plus the same family is a strong enough central anchor.
  if (sameFamily && sharedClubs >= 2) return true;

  // A body paragraph can reveal the concrete actor omitted from a generic title,
  // but it must stay lexically tied to that title and express a factual action.
  if (sameFamily && lexicalOverlap >= 2 && explicitAction && !historical) return true;
  if (!leadPeople.size && sameFamily && sharedClubs >= 1 && lexicalOverlap >= 1 && explicitAction && !historical) return true;

  // Independent sub-events require stronger evidence than a contextual mention.
  if (event.family !== 'unknown' && lexicalOverlap >= 3 && explicitAction && !historical) return true;

  return false;
}

function eventMergeKey(event) {
  const person = normalizeTopicText(event.primary_people?.[0] || '');
  if (person) return `${event.family}|person:${person}`;
  const clubs = (event.primary_clubs || []).map(normalizeTopicText).filter(Boolean).sort().slice(0, 2);
  return `${event.family}|clubs:${clubs.join('+')}`;
}

function mergeSameDossier(events) {
  const out = [];
  const byKey = new Map();
  for (const event of events) {
    const key = eventMergeKey(event);
    const existing = byKey.get(key);
    if (!existing || !key) {
      out.push(event);
      if (key) byKey.set(key, event);
      continue;
    }

    existing.primary_people = uniq([...existing.primary_people, ...event.primary_people]).slice(0, 3);
    existing.primary_clubs = uniq([...existing.primary_clubs, ...event.primary_clubs]).slice(0, 4);
    existing.evidence.fragments = uniq([
      ...(existing.evidence?.fragments || []),
      ...(event.evidence?.fragments || [])
    ]).slice(0, 8);
    existing.evidence.text = existing.evidence.fragments.join('\n').slice(0, 1800);

    const stages = [existing.stage, event.stage].filter(Boolean).filter((stage) => stage !== 'unknown');
    if (stages.length) existing.stage = stages[stages.length - 1];

    existing.lexical_fingerprint = {
      ...(existing.lexical_fingerprint || {}),
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
  const retained = baseEvents.filter((event) => {
    if (event?.evidence?.kind === 'lead') return true;
    return isCentralBodyEvent(event, article, lead);
  });

  return mergeSameDossier(retained);
}
