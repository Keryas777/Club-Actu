-- 0005_enable_new_football_sources.sql
-- Register and enable the football sources added to src/sources.js.
-- Keep OL-specific sources attached only to OL; share national sources with OL/OM/PSG.

PRAGMA foreign_keys = ON;

INSERT INTO sources
  (id, name, homepage_url, country_code, language, source_type, scope,
   discovery_url, discovery_method, authority_tier, enabled)
VALUES
  ('sports_fr', 'Sports.fr', 'https://www.sports.fr/', 'FR', 'fr',
   'media', 'national_football', 'https://www.sports.fr/football/feed',
   'rss', 'C', 1),
  ('topmercato', 'Top Mercato', 'https://www.topmercato.com/', 'FR', 'fr',
   'media', 'national_football', 'https://www.topmercato.com/feed',
   'rss', 'C', 1),
  ('butfootballclub', 'But! Football Club', 'https://www.butfootballclub.fr/', 'FR', 'fr',
   'media', 'national_football', 'https://www.butfootballclub.fr/feed',
   'rss', 'C', 1),
  ('ferveur_lyonnaise', 'Ferveur Lyonnaise', 'https://www.ferveurlyonnaise.fr/', 'FR', 'fr',
   'media', 'club_specific', 'https://www.ferveurlyonnaise.fr/',
   'html_links', 'B', 1),
  ('madeingones', 'MadeInGones', 'https://madeingones.ouest-france.fr/', 'FR', 'fr',
   'media', 'club_specific', 'https://madeingones.ouest-france.fr/',
   'html_links', 'B', 1),
  ('sports_orange', 'Sports Orange', 'https://sports.orange.fr/', 'FR', 'fr',
   'media', 'national_sport', 'https://sports.orange.fr/football/',
   'html_links', 'C', 1)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  homepage_url = excluded.homepage_url,
  country_code = excluded.country_code,
  language = excluded.language,
  source_type = excluded.source_type,
  scope = excluded.scope,
  discovery_url = excluded.discovery_url,
  discovery_method = excluded.discovery_method,
  authority_tier = excluded.authority_tier,
  enabled = excluded.enabled,
  updated_at = CURRENT_TIMESTAMP;

INSERT OR IGNORE INTO club_sources
  (club_id, source_id, relation_type, priority)
VALUES
  ('ol', 'sports_fr', 'relevant', 30),
  ('ol', 'topmercato', 'relevant', 30),
  ('ol', 'butfootballclub', 'relevant', 30),
  ('ol', 'ferveur_lyonnaise', 'direct', 20),
  ('ol', 'madeingones', 'direct', 20),
  ('ol', 'sports_orange', 'relevant', 30),
  ('om', 'sports_fr', 'relevant', 30),
  ('om', 'topmercato', 'relevant', 30),
  ('om', 'butfootballclub', 'relevant', 30),
  ('om', 'sports_orange', 'relevant', 30),
  ('psg', 'sports_fr', 'relevant', 30),
  ('psg', 'topmercato', 'relevant', 30),
  ('psg', 'butfootballclub', 'relevant', 30),
  ('psg', 'sports_orange', 'relevant', 30);
