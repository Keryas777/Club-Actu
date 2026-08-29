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

## Endpoints

- `GET /health`
- `GET /api/sources`
- `GET /api/articles?limit=25`
- `GET /api/collection-runs?limit=10`

## Pipeline cible

Collecte des sources → stockage brut → préfiltrage club → extraction de contenu → validation club → regroupement sémantique → validation → synthèse IA → validation qualité → publication.

L'Olympique Lyonnais est le premier club utilisé pour valider le pipeline.

## Important

La collecte actuelle ne fait encore qu'une découverte de liens et de titres sur les sources explicitement activées. Elle ne réalise ni extraction intégrale d'articles, ni filtrage OL final, ni synthèse IA.

<!-- Cloudflare deployment trigger: D1 pipeline validation -->
