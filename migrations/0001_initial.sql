-- 0001_initial.sql
-- Club Actu foundational schema.
-- Raw collection is intentionally separated from later editorial processing.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS clubs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country_code TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  homepage_url TEXT NOT NULL,
  country_code TEXT,
  language TEXT,
  source_type TEXT NOT NULL,
  scope TEXT NOT NULL,
  discovery_url TEXT,
  discovery_method TEXT NOT NULL DEFAULT 'pending',
  authority_tier TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS club_sources (
  club_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'relevant',
  priority INTEGER NOT NULL DEFAULT 100,
  PRIMARY KEY (club_id, source_id),
  FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE,
  FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS raw_articles (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  title TEXT,
  author TEXT,
  published_at TEXT,
  excerpt TEXT,
  raw_content TEXT,
  image_url TEXT,
  content_level TEXT NOT NULL DEFAULT 'metadata',
  discovery_method TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  content_hash TEXT,
  processing_status TEXT NOT NULL DEFAULT 'raw',
  http_status INTEGER,
  UNIQUE(source_id, canonical_url),
  FOREIGN KEY (source_id) REFERENCES sources(id)
);

CREATE INDEX IF NOT EXISTS idx_raw_articles_seen
  ON raw_articles(last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_raw_articles_status
  ON raw_articles(processing_status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS article_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id TEXT NOT NULL,
  content_hash TEXT,
  title TEXT,
  excerpt TEXT,
  raw_content TEXT,
  captured_at TEXT NOT NULL,
  UNIQUE(article_id, content_hash),
  FOREIGN KEY (article_id) REFERENCES raw_articles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS collection_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  sources_attempted INTEGER NOT NULL DEFAULT 0,
  sources_succeeded INTEGER NOT NULL DEFAULT 0,
  articles_discovered INTEGER NOT NULL DEFAULT 0,
  articles_inserted INTEGER NOT NULL DEFAULT 0,
  articles_updated INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

INSERT OR IGNORE INTO clubs (id, name, country_code)
VALUES ('ol', 'Olympique Lyonnais', 'FR');

INSERT OR IGNORE INTO sources
  (id, name, homepage_url, country_code, language, source_type, scope, discovery_url, discovery_method, authority_tier, enabled)
VALUES
  ('ol_official', 'OL.fr', 'https://www.ol.fr/', 'FR', 'fr', 'official', 'club_specific', 'https://www.ol.fr/', 'html_links', 'A', 1),
  ('olympique_et_lyonnais', 'Olympique-et-Lyonnais', 'https://www.olympique-et-lyonnais.com/', 'FR', 'fr', 'media', 'club_specific', 'https://www.olympique-et-lyonnais.com/', 'html_links', 'B', 1),
  ('lequipe', 'L''Équipe', 'https://www.lequipe.fr/', 'FR', 'fr', 'media', 'national_football', NULL, 'pending', 'B', 0),
  ('footmercato', 'Foot Mercato', 'https://www.footmercato.net/', 'FR', 'fr', 'media', 'national_football', 'https://www.footmercato.net/club/ol/actualite', 'html_links', 'C', 1),
  ('eurosport', 'Eurosport', 'https://www.eurosport.fr/', 'FR', 'fr', 'media', 'national_sport', NULL, 'pending', 'C', 0),
  ('rmc_sport', 'RMC Sport', 'https://rmcsport.bfmtv.com/', 'FR', 'fr', 'media', 'national_sport', NULL, 'pending', 'B', 0),
  ('foot01', 'Foot01', 'https://www.foot01.com/', 'FR', 'fr', 'media', 'national_football', 'https://www.foot01.com/ol', 'html_links', 'C', 1),
  ('maxifoot', 'Maxifoot', 'https://www.maxifoot.fr/', 'FR', 'fr', 'media', 'national_football', NULL, 'pending', 'C', 0),
  ('sport_fr', 'Sport.fr', 'https://www.sport.fr/', 'FR', 'fr', 'media', 'national_sport', 'https://www.sport.fr/football', 'html_links', 'D', 1),
  ('livefoot', 'LiveFoot', 'https://www.livefoot.fr/', 'FR', 'fr', 'aggregator', 'national_football', NULL, 'pending', 'D', 0),
  ('madeingones', 'MadeInGones', 'https://www.madeingones.com/', 'FR', 'fr', 'media', 'club_specific', NULL, 'pending', 'B', 0),
  ('sports_orange', 'Sports Orange', 'https://sports.orange.fr/', 'FR', 'fr', 'media', 'national_sport', NULL, 'pending', 'C', 0),
  ('leprogres', 'Le Progrès', 'https://www.leprogres.fr/', 'FR', 'fr', 'media', 'regional', 'https://www.leprogres.fr/sport/ol-olympique-lyonnais-football', 'html_links', 'B', 1);

INSERT OR IGNORE INTO club_sources (club_id, source_id, relation_type, priority)
SELECT 'ol', id,
  CASE WHEN scope = 'club_specific' THEN 'direct' ELSE 'relevant' END,
  CASE authority_tier WHEN 'A' THEN 10 WHEN 'B' THEN 20 WHEN 'C' THEN 30 ELSE 40 END
FROM sources;
