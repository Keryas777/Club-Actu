-- 0006_purge_sports_orange_videos.sql
-- Remove Sports Orange video pages collected before the adapter exclusion.
-- raw_articles cascades to article_versions/extractions/assessments where applicable.

PRAGMA foreign_keys = ON;

DELETE FROM raw_articles
WHERE source_id = 'sports_orange'
  AND canonical_url LIKE 'https://sports.orange.fr/videos/football/%';
