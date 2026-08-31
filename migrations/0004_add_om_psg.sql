-- 0004_add_om_psg.sql
-- Add Olympique de Marseille and Paris Saint-Germain as active clubs.
-- Reuse global/national sources; OL-specific discovery sources remain OL-only.

PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO clubs (id, name, country_code, active)
VALUES
  ('om', 'Olympique de Marseille', 'FR', 1),
  ('psg', 'Paris Saint-Germain', 'FR', 1);

INSERT OR IGNORE INTO club_aliases (club_id, alias, strength) VALUES
  ('om', 'Olympique de Marseille', 'strong'),
  ('om', 'Olympique Marseille', 'strong'),
  ('om', 'OM', 'strong'),
  ('om', 'Marseille', 'strong'),
  ('om', 'Marseillais', 'weak'),

  ('psg', 'Paris Saint-Germain', 'strong'),
  ('psg', 'Paris Saint Germain', 'strong'),
  ('psg', 'Paris SG', 'strong'),
  ('psg', 'PSG', 'strong');

-- Only sources whose discovery is global/national are shared here.
-- OL-specific adapters such as OL.fr, Olympique-et-Lyonnais, Foot Mercato / OL,
-- Foot01 / OL, Le Progrès OL, Ferveur Lyonnaise and MadeInGones stay OL-only.
INSERT OR IGNORE INTO club_sources (club_id, source_id, relation_type, priority)
SELECT c.id, s.id, 'relevant',
  CASE s.authority_tier WHEN 'A' THEN 10 WHEN 'B' THEN 20 WHEN 'C' THEN 30 ELSE 40 END
FROM clubs c
JOIN sources s
  ON s.id IN (
    'lequipe',
    'eurosport',
    'rmc_sport',
    'maxifoot',
    'sport_fr',
    'livefoot',
    'sports_orange',
    'sport365'
  )
WHERE c.id IN ('om', 'psg');
