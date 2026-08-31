-- 0003_add_sport365.sql
-- Add Sport365 as a global football source.
-- Discovery is global (/football365); club relevance remains per-club in Phase A.

PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO sources
  (id, name, homepage_url, country_code, language, source_type, scope,
   discovery_url, discovery_method, authority_tier, enabled)
VALUES
  ('sport365', 'Sport365', 'https://www.sport365.fr/', 'FR', 'fr',
   'media', 'national_football', 'https://www.sport365.fr/football365',
   'html_links', 'C', 1);

INSERT OR IGNORE INTO club_sources
  (club_id, source_id, relation_type, priority)
VALUES
  ('ol', 'sport365', 'relevant', 30);
