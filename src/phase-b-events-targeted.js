import { normalizeTopicText } from './grouper.js';
import { extractEventCandidates as extractV04Candidates } from './phase-b-events-centrality.js';

export const EVENT_EXTRACTOR_VERSION = 'phase-b-event-extractor-v0.5';

const ROUNDUP_TITLE = /\b(?:jt foot mercato|les infos du jour|le point mercato|point mercato|\d+ transferts?|\d+ joueurs libres)\b/i;
const TITLE_INJURY = /\b(?:bless\w*|forfait|infirmerie|diagnostic|l[eé]sion|indisponib\w*)\b/i;
const TITLE_GENERIC_INJURY = /\b(?:gros\s+)?coup dur\b/i;
const TITLE_DISCIPLINE = /\b(?:suspend\w*|sanction\w*|commission de discipline|carton rouge|expuls\w*)\b/i;
const TITLE_FINANCE = /\b(?:dncg|dette|budget|comptes?|finances?|masse salariale|capital|actionnaire|propri[eé]taire|rachat|cession)\b/i;
const TITLE_STAFF = /(?:\b(?:entra[iî]neur|coach|manager|directeur sportif|staff)\b.*\b(?:avenir|d[eé]part|quitt\w*|limog\w*|licenci\w*|nomm\w*|remplac\w*|succession)\b)|(?:\b(?:limog\w*|licenci\w*|nomm\w*|remplac\w*)\b.*\b(?:entra[iî]neur|coach|manager|directeur sportif|staff)\b)/i;
const TITLE_CONTRACT = /\b(?:prolong\w*|renouvel\w*|contrat|jusqu['’ ]?en 20\d{2})\b/i;
const TITLE_TRANSFER = /\b(?:mercato|transfert|recrut\w*|offre|sign(?:e|é|ée|er|ature)?|rejoint|quitt\w*|d[eé]part|cibl\w*|n[eé]goci\w*|pr[eê]t)\b/i;
const TITLE_STATEMENT = /\b(?:phrase choc|petite phrase|d[eé]claration|d[eé]clare|r[eé]agit|r[eé]action|d[eé]nonce\w*|accus\w*|critique\w*|r[eé]pond\w*|confidence\w*|interview|conf[eé]rence de presse|se l[aâ]che|mensonge)\b/i;
const STRONG_EVENT_ACTION = /\b(?:officialis\w*|sign\w*|rejoint|quitt\w*|transf[eè]r\w*|accord|offre|n[eé]goci\w*|discut\w*|cibl\w*|pr[eê]t|prolong\w*|renouvel\w*|bless\w*|forfait|diagnostic|indisponib\w*|suspend\w*|sanction\w*|limog\w*|licenci\w*|nomm\w*|d[eé]mis|rachat|cession|dncg|qualifi\w*|[eé]limin\w*|victoire|d[eé]faite|score|reste\w*|refus\w*)\b/i;
const EXTRA_REJECTED_PERSON = /^(?:l['’ ]?(?:incertitude|h[eé]ritier|absence|inversion)|diable rouge|ch['’ ]?ti|au[- ]del(?:a|à)?|bratislava)$/i;

const FAMILY_COMPATIBILITY = {
  transfer: new Set(['contract', 'finance', 'staff']),
  contract: new Set(['transfer', 'staff']),
  injury: new Set(['transfer', 'match']),
  discipline: new Set(['match', 'institutional']),
  staff: new Set(['transfer', 'contract', 'institutional']),
  finance: new Set(['transfer', 'institutional']),
  statement: new Set(['unknown', 'institutional', 'transfer', 'finance', 'staff', 'contract', 'competition', 'match'])
};

function uniqNormalized(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const normalized = normalizeTopicText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(value);
  }
  return out;
}

function normalizedSet(values = []) {
  return new Set(values.map(normalizeTopicText).filter(Boolean));
}

function intersectionCount(a, b) {
  let count = 0;
  for (const value of a) if (b.has(value)) count++;
  return count;
}

function sanitizePeople(values = []) {
  return uniqNormalized(values).filter((value) => !EXTRA_REJECTED_PERSON.test(String(value || '').trim()));
}

function cloneEvent(event) {
  const primary_people = sanitizePeople(event.primary_people || []);
  const primary_clubs = uniqNormalized(event.primary_clubs || []);
  return {
    ...event,
    primary_people,
    primary_clubs,
    evidence: {
      ...(event.evidence || {}),
      fragments: [...(event.evidence?.fragments || [])]
    },
    relation_hints: { ...(event.relation_hints || {}) },
    lexical_fingerprint: {
      ...(event.lexical_fingerprint || {}),
      people: primary_people,
      clubs: primary_clubs
    }
  };
}

function personMentionedInTitle(person, title = '') {
  const personNorm = normalizeTopicText(person);
  const titleNorm = normalizeTopicText(title);
  if (!personNorm || !titleNorm) return false;
  if (` ${titleNorm} `.includes(` ${personNorm} `)) return true;
  const parts = personNorm.split(' ').filter(Boolean);
  const surname = parts.at(-1) || '';
  return surname.length >= 5 && new RegExp(`(?:^|\\s)${surname}(?:$|\\s)`).test(titleNorm);
}

function mainPerson(lead, title = '') {
  const people = sanitizePeople(lead?.primary_people || []);
  return people.find((person) => personMentionedInTitle(person, title)) || people[0] || null;
}

function explicitDominantFamily(article, events) {
  const title = String(article?.title || '');
  if (!title || ROUNDUP_TITLE.test(title)) return null;

  if (TITLE_INJURY.test(title)) return 'injury';
  if (TITLE_GENERIC_INJURY.test(title) && events.some((event) => event.family === 'injury')) return 'injury';
  if (TITLE_DISCIPLINE.test(title)) return 'discipline';

  // Specific factual domains must beat generic transfer vocabulary such as
  // "accord", "départ" or "signature" when the title is really about the
  // DNCG/finances, a staff move or a contract renewal.
  if (TITLE_FINANCE.test(title)) return 'finance';
  if (TITLE_STAFF.test(title)) return 'staff';
  if (TITLE_CONTRACT.test(title)) return 'contract';
  if (TITLE_TRANSFER.test(title)) return 'transfer';
  if (TITLE_STATEMENT.test(title)) return 'statement';

  return null;
}

function familiesCompatible(dominant, family) {
  if (!dominant) return false;
  if (family === dominant || family === 'unknown' || family === 'statement') return true;
  return FAMILY_COMPATIBILITY[dominant]?.has(family) || false;
}

function sharesAnyPerson(a = [], b = []) {
  return intersectionCount(normalizedSet(a), normalizedSet(b)) > 0;
}

function sharedClubCount(a = [], b = []) {
  return intersectionCount(normalizedSet(a), normalizedSet(b));
}

function connectedToLead(event, lead, protagonist, dominant) {
  if (!lead || !event) return false;
  if (event === lead || event?.evidence?.kind === 'lead') return true;
  if (!familiesCompatible(dominant, event.family)) return false;

  if (protagonist && normalizedSet(event.primary_people || []).has(normalizeTopicText(protagonist))) return true;
  if (sharesAnyPerson(event.primary_people || [], lead.primary_people || [])) return true;

  const sharedClubs = sharedClubCount(event.primary_clubs || [], lead.primary_clubs || []);
  if (!sharedClubs) return false;

  // A body continuation often switches to "il", "le joueur" or a quoted post
  // and therefore has no extracted person. v0.4 kept these fragments but could
  // not merge them back into the title dossier. At this stage they have already
  // passed centrality filtering, so shared club + compatible family is enough
  // when the paragraph carries a factual action (or exactly the dominant family).
  if (!(event.primary_people || []).length) {
    const text = String(event?.evidence?.text || '');
    return event.family === dominant || STRONG_EVENT_ACTION.test(text);
  }

  // Generic titles can omit the actor entirely. If the lead also has no useful
  // person, keep one same-domain body continuation anchored to the same club.
  if (!(lead.primary_people || []).length && event.family === dominant) return true;

  return false;
}

function coerceFamily(event, family) {
  if (!family || event.family === family) return event;
  return {
    ...event,
    family,
    stage: 'unknown',
    family_discriminator: null,
    relation_hints: {},
    lexical_fingerprint: {
      ...(event.lexical_fingerprint || {}),
      family
    }
  };
}

function addImplicitPerson(event, protagonist) {
  if (!protagonist || (event.primary_people || []).length) return event;
  const primary_people = [protagonist];
  return {
    ...event,
    primary_people,
    lexical_fingerprint: {
      ...(event.lexical_fingerprint || {}),
      people: primary_people
    }
  };
}

function mergeInto(target, source) {
  target.primary_people = uniqNormalized([...(target.primary_people || []), ...(source.primary_people || [])]).slice(0, 3);
  target.primary_clubs = uniqNormalized([...(target.primary_clubs || []), ...(source.primary_clubs || [])]).slice(0, 4);

  const fragments = uniqNormalized([
    ...(target.evidence?.fragments || []),
    ...(source.evidence?.fragments || [])
  ]).slice(0, 8);
  target.evidence.fragments = fragments;
  target.evidence.text = fragments.join('\n').slice(0, 1800);

  if ((!target.stage || target.stage === 'unknown') && source.stage && source.stage !== 'unknown') {
    target.stage = source.stage;
  }

  target.lexical_fingerprint = {
    ...(target.lexical_fingerprint || {}),
    family: target.family,
    people: target.primary_people,
    clubs: target.primary_clubs,
    tokens: uniqNormalized([
      ...(target.lexical_fingerprint?.tokens || []),
      ...(source.lexical_fingerprint?.tokens || [])
    ]).slice(0, 24)
  };
}

export function extractEventCandidates(article, context = {}) {
  const events = extractV04Candidates(article, context).map(cloneEvent);
  if (!events.length) return events;

  const title = String(article?.title || '');
  if (ROUNDUP_TITLE.test(title)) return events;

  const leadIndex = events.findIndex((event) => event?.evidence?.kind === 'lead');
  const lead = leadIndex >= 0 ? events[leadIndex] : events[0];
  const dominant = explicitDominantFamily(article, events);
  if (!dominant) return events;

  const protagonist = mainPerson(lead, title);
  const normalized = [];
  const connected = [];

  for (const event of events) {
    const isConnected = connectedToLead(event, lead, protagonist, dominant);
    let next = event;
    if (isConnected && familiesCompatible(dominant, event.family)) {
      next = coerceFamily(next, dominant);
      if (event?.evidence?.kind !== 'lead') next = addImplicitPerson(next, protagonist);
    }
    normalized.push(next);
    connected.push(isConnected);
  }

  const normalizedLeadIndex = normalized.findIndex((event) => event?.evidence?.kind === 'lead');
  if (normalizedLeadIndex < 0 || !connected[normalizedLeadIndex]) return normalized;

  const main = normalized[normalizedLeadIndex];
  const out = [];
  for (let i = 0; i < normalized.length; i++) {
    const event = normalized[i];
    if (i === normalizedLeadIndex) {
      out.push(main);
      continue;
    }

    if (connected[i] && event.family === main.family) {
      mergeInto(main, event);
      continue;
    }
    out.push(event);
  }

  return out;
}
