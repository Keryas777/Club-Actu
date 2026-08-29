# Club Actu

Backend commun du futur réseau de sites d'actualité football par club.

## Socle actuel

- Cloudflare Worker
- déploiement depuis GitHub
- endpoint de santé : `/health`

## Architecture prévue

Collecte des sources → stockage brut → filtrage club → extraction de contenu → regroupement sémantique → validation → synthèse IA → validation qualité → publication.

L'Olympique Lyonnais sera le premier club utilisé pour valider le pipeline.
