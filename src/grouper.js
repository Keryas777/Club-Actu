const PREVIEW_VERSION = "phase-b-preview-v2";
const DEFAULT_WINDOW_HOURS = 48;

const STOPWORDS = new Set([
  "a","afin","ainsi","alors","apres","au","aucun","aussi","autre","aux","avec","avoir",
  "car","ce","ces","cet","cette","chez","comme","comment","dans","de","des","du","elle",
  "en","encore","entre","est","et","etre","fait","font","il","ils","je","la","le","les",
  "leur","leurs","lui","mais","mes","moins","mon","ne","nos","notre","nous","on","ou",
  "par","pas","plus","pour","pourquoi","quand","que","quel","quelle","quelles","quels",
  "qui","sa","sans","se","ses","si","son","sont","sur","ta","te","tes","ton","tous",
  "tout","toute","toutes","tu","un","une","vos","votre","vous",
  "football","foot","ligue","championnat","match","club","equipe","equipe","joueur","joueurs",
  "mercato","transfert","transferts","actualite","direct","officiel","officielle","france","sport",
  "info","infos","news","dossier","dossiers","fermeture","marche","ete","hiver","avant","apres",
  "defenseur","milieu","attaquant","gardien","avance","anime","cible","ciblee","cibles",
  "million","millions","euros","euro","saison","journee","j","c1","c3"
]);

function stripAccents(value = "") {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function decodeBasicEntities(value = "") {
  return String(value || "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#8211;|&#x2013;/gi, "-")
    .replace(/&#8212;|&#x2014;/gi, "-");
}

export function normalizeTopicText(value = "") {
  return stripAccents(decodeBasicEntities(value))
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function aliasTokenSet(aliases = []) {
  const ignored = new Set(STOPWORDS);
  for (const alias of aliases) {
    for (const token of normalizeTopicText(alias).split(" ")) {
      if (token) ignored.add(token);
    }
  }
  return ignored;
}

function tokenize(value, ignored) {
  const tokens = normalizeTopicText(value).split(" ").filter(Boolean);
  return [...new Set(tokens.filter((token) =>
    token.length >= 3 &&
    !ignored.has(token) &&
    !/^\d{1,2}$/.test(token)
  ))];
}

function articleTokens(article, ignored) {
  const titleTokens = tokenize(article.title || "", ignored);
  const excerptTokens = tokenize(article.excerpt || "", ignored);
  const leadTokens = tokenize((article.content || "").slice(0, 900), ignored);
  return {
    title: titleTokens,
    context: [...new Set([...titleTokens, ...excerptTokens, ...leadTokens])]
  };
}

function entityLikeTokens(tokens = []) {
  // Rare/specific tokens are useful proxies for named entities at this cheap candidate stage.
  return tokens.filter((token) => token.length >= 4 && !/^\\d+$/.test(token));
}

function intersection(a, b) {
  const bSet = new Set(b);
  return a.filter((token) => bSet.has(token));
}

function weightedJaccard(a, b, weights) {
  const aSet = new Set(a);
  const bSet = new Set(b);
  const all = new Set([...aSet, ...bSet]);
  let inter = 0;
  let union = 0;
  for (const token of all) {
    const weight = weights.get(token) || 1;
    union += weight;
    if (aSet.has(token) && bSet.has(token)) inter += weight;
  }
  return union ? inter / union : 0;
}

function buildWeights(tokenized) {
  const df = new Map();
  for (const row of tokenized) {
    for (const token of new Set(row.context)) {
      df.set(token, (df.get(token) || 0) + 1);
    }
  }
  const n = Math.max(1, tokenized.length);
  const weights = new Map();
  for (const [token, count] of df) {
    weights.set(token, 1 + Math.log((n + 1) / (count + 1)));
  }
  return weights;
}

function timeDistanceHours(a, b) {
  const ta = Date.parse(a.published_at || a.last_seen_at || "");
  const tb = Date.parse(b.published_at || b.last_seen_at || "");
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.abs(ta - tb) / 3600000;
}

function classifyPair(score, sharedTitle, sharedContext, hours) {
  if (hours != null && hours > DEFAULT_WINDOW_HOURS) return "none";
  if (
    (score >= 0.62 && sharedContext.length >= 2) ||
    (score >= 0.54 && sharedTitle.length >= 2) ||
    (score >= 0.48 && sharedTitle.length >= 1 && sharedContext.length >= 3)
  ) return "strong";
  if (
    (score >= 0.38 && sharedContext.length >= 2) ||
    (score >= 0.32 && sharedTitle.length >= 2) ||
    (
      sharedTitle.length >= 1 &&
      sharedContext.length >= 3 &&
      (hours == null || hours <= 12)
    ) ||
    (
      sharedContext.filter((token) => token.length >= 4).length >= 2 &&
      (hours == null || hours <= 12)
    )
  ) return "possible";
  return "none";
}

export function scoreArticlePair(a, b, tokenA, tokenB, weights) {
  const titleScore = weightedJaccard(tokenA.title, tokenB.title, weights);
  const contextScore = weightedJaccard(tokenA.context, tokenB.context, weights);
  const score = 0.6 * titleScore + 0.4 * contextScore;
  const sharedTitle = intersection(tokenA.title, tokenB.title);
  const sharedContext = intersection(tokenA.context, tokenB.context);
  const hours = timeDistanceHours(a, b);
  const sharedEntities = intersection(entityLikeTokens(tokenA.context), entityLikeTokens(tokenB.context));
  const entityBonus = Math.min(0.24, sharedEntities.length * 0.08);
  const entityScore = Math.min(1, score + entityBonus);
  return {
    score: entityScore,
    title_score: titleScore,
    context_score: contextScore,
    shared_title_tokens: sharedTitle,
    shared_context_tokens: sharedContext,
    shared_entity_tokens: sharedEntities,
    hours_apart: hours,
    confidence: classifyPair(entityScore, sharedTitle, sharedContext, hours)
  };
}

export function buildPreviewPairs(articles, aliases = [], maxPairs = 30) {
  const ignored = aliasTokenSet(aliases);
  const tokenized = articles.map((article) => articleTokens(article, ignored));
  const weights = buildWeights(tokenized);
  const pairs = [];

  for (let i = 0; i < articles.length; i++) {
    for (let j = i + 1; j < articles.length; j++) {
      const scored = scoreArticlePair(
        articles[i], articles[j], tokenized[i], tokenized[j], weights
      );
      if (scored.confidence === "none") continue;
      pairs.push({
        confidence: scored.confidence,
        score: Number(scored.score.toFixed(4)),
        title_score: Number(scored.title_score.toFixed(4)),
        context_score: Number(scored.context_score.toFixed(4)),
        hours_apart: scored.hours_apart == null ? null : Number(scored.hours_apart.toFixed(2)),
        shared_title_tokens: scored.shared_title_tokens.slice(0, 12),
        shared_context_tokens: scored.shared_context_tokens.slice(0, 16),
        shared_entity_tokens: scored.shared_entity_tokens.slice(0, 10),
        left: {
          id: articles[i].id,
          source_id: articles[i].source_id,
          title: articles[i].title,
          published_at: articles[i].published_at
        },
        right: {
          id: articles[j].id,
          source_id: articles[j].source_id,
          title: articles[j].title,
          published_at: articles[j].published_at
        }
      });
    }
  }

  pairs.sort((a, b) =>
    (a.confidence === b.confidence ? 0 : a.confidence === "strong" ? -1 : 1) ||
    b.score - a.score ||
    (a.hours_apart ?? 9999) - (b.hours_apart ?? 9999)
  );

  return pairs.slice(0, maxPairs);
}

export async function getPhaseBPreview(db, clubId = "ol", articleLimit = 60, pairLimit = 30) {
  const { results: aliases } = await db.prepare(
    `SELECT alias FROM club_aliases WHERE club_id = ?`
  ).bind(clubId).all();

  const { results: articles } = await db.prepare(
    `SELECT
       r.id,
       r.source_id,
       r.last_seen_at,
       COALESCE(e.normalized_title, r.title) AS title,
       COALESCE(e.normalized_published_at, r.published_at, r.last_seen_at) AS published_at,
       COALESCE(e.normalized_excerpt, r.excerpt, '') AS excerpt,
       COALESCE(e.normalized_content, r.raw_content, '') AS content
     FROM article_club_assessments a
     JOIN raw_articles r ON r.id = a.article_id
     JOIN article_extractions e
       ON e.article_id = r.id
      AND e.source_content_hash = r.content_hash
      AND e.extractor_version = 'phase-a-extractor-v1'
      AND e.status = 'completed'
     WHERE a.club_id = ?
       AND a.decision = 'relevant'
       AND a.source_content_hash = r.content_hash
       AND a.rule_version = 'phase-a-relevance-v2'
     ORDER BY COALESCE(e.normalized_published_at, r.published_at, r.last_seen_at) DESC
     LIMIT ?`
  ).bind(clubId, articleLimit).all();

  const pairs = buildPreviewPairs(
    articles || [],
    (aliases || []).map((row) => row.alias),
    pairLimit
  );

  return {
    version: PREVIEW_VERSION,
    club_id: clubId,
    article_count: (articles || []).length,
    pair_count: pairs.length,
    strong_count: pairs.filter((p) => p.confidence === "strong").length,
    possible_count: pairs.filter((p) => p.confidence === "possible").length,
    window_hours: DEFAULT_WINDOW_HOURS,
    pairs
  };
}
