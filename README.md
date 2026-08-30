# Club Actu

Backend commun du futur réseau de sites d'actualité football par club.

## Socle actuel

- Cloudflare Worker
- déploiement depuis GitHub
- Cloudflare D1 (`club-actu-db`) via le binding `DB`
- migration SQL versionnée
- catalogue global de sources + rattachement aux clubs
- collecte brute de métadonnées sans IA
- cron toutes les 30 minutes
- endpoints de diagnostic
- Phase A déterministe : extraction/normalisation, pertinence par club, rejets explicites, retry et préparation au regroupement

## Endpoints

- `GET /health`
- `GET /api/sources`
- `GET /api/articles?limit=25`
- `GET /api/collection-runs?limit=10`
- `GET /api/processing-status?club=ol&limit=8`

## Pipeline cible

Collecte des sources → stockage brut → préfiltrage club → extraction de contenu → validation club → regroupement sémantique → validation → synthèse IA → validation qualité → publication.

L'Olympique Lyonnais est le premier club utilisé pour valider le pipeline.

## Important

La collecte reste séparée du traitement. La Phase A traite ensuite les lignes `raw_articles` de façon déterministe : elle réutilise les métadonnées structurées lorsqu'elles suffisent, extrait la page lorsque nécessaire, évalue la pertinence par club et conserve les décisions/rejets. Aucun regroupement sémantique ni aucune synthèse IA n'est encore réalisé.

<!-- Cloudflare deployment trigger: Git connection restored -->
