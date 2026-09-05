# Phase B.2.1.2 — Benchmark des briques d’extraction

Date : 5 septembre 2026

## But

Mesurer les briques candidates prévues par la spécification vivante sur les données réelles Club Actu avant de les intégrer à l’architecture.

Ce benchmark ne modifie ni Phase A, ni D1, ni le Worker de production. Les dépendances testées sont installées uniquement dans le workflow manuel.

## Constat préalable : absence de corps d’article dans D1

Le corpus Phase B comprend 180 lignes OL / PSG / OM, correspondant à 176 articles uniques.

Pour les 180 lignes :

- `normalized_content` / `raw_content` disponible : **0 / 180** ;
- events issus du corps : **0** ;
- le preview travaille donc actuellement uniquement sur titre + extrait.

Le code de collecte explique ce résultat : les articles sont découverts et stockés au niveau `metadata`; le pipeline courant ne refetch pas encore chaque page article pour en extraire le corps.

Conséquence : les benchmarks de segmentation wink sur le corpus D1 actuel ne peuvent pas être interprétés tant qu’une étape d’enrichissement de contenu n’existe pas.

## Baseline extracteur Phase B v0.2

Sur 60 articles par club :

| Club | Events | Articles sans event | Multi-event | Events corps |
|---|---:|---:|---:|---:|
| OL | 52 | 8 | 0 | 0 |
| PSG | 46 | 14 | 0 | 0 |
| OM | 51 | 9 | 0 | 0 |

La calibration v0.2 a réduit plusieurs faux `primary_people`, mais ne peut pas résoudre la détection multi-event sans corps d’article.

## Mozilla Readability vs Postlight Parser

Benchmark : 3 articles récents par source active, soit 39 pages. Le même HTML préchargé est fourni aux deux extracteurs. Un résultat est compté comme exploitable à partir de 200 caractères de texte extrait.

Les 39 URLs ont répondu HTTP 200.

### Résultats

| Source | Readability | Médiane caractères | Postlight | Médiane caractères |
|---|---:|---:|---:|---:|
| butfootballclub | 3/3 | 2051 | 3/3 | 2003 |
| ferveur_lyonnaise | 3/3 | 4418 | 3/3 | 1682 |
| foot01 | 3/3 | 1816 | 3/3 | 1823 |
| footmercato | 3/3 | 2107 | 2/3 | 2025 |
| leprogres | 3/3 | 4547 | 3/3 | 2808 |
| madeingones | 3/3 | 1197 | 3/3 | 205 |
| ol_official | 0/3 | 0 | 0/3 | 0 |
| olympique_et_lyonnais | 3/3 | 2022 | 3/3 | 1775 |
| sport365 | 3/3 | 2819 | 3/3 | 2221 |
| sport_fr | 3/3 | 2925 | 2/3 | 2419 |
| sports_fr | 3/3 | 953 | 3/3 | 890 |
| sports_orange | 3/3 | 2300 | 3/3 | 2248 |
| topmercato | 3/3 | 3746 | 3/3 | 3238 |

### Décision de benchmark

**Mozilla Readability est le meilleur candidat générique actuel** :

- 36 / 39 pages exploitables ;
- 12 / 13 sources couvertes sur ce petit échantillon ;
- résultats généralement plus longs que Postlight ;
- moins d’échecs / extractions tronquées observés.

**Postlight Parser n’apporte pas de gain global mesuré**. Il reste éventuellement une référence de comparaison mais n’est pas justifié comme second fallback systématique à ce stade.

`ol_official` est le seul échec complet des deux extracteurs génériques. Cette source dispose déjà d’un mode de découverte API et doit être traitée par une voie spécifique/API pour le contenu plutôt que forcée dans un parseur HTML générique.

Ce benchmark à 3 pages par source est un signal technique, pas encore une garantie de couverture à 100 %. Une validation sur un échantillon plus large sera nécessaire avant mise en production de l’enrichissement.

## wink-nlp

Le modèle officiel testé est anglais. Pour cette raison :

- POS et NER wink ne sont **pas** traités comme vérité terrain sur les articles français ;
- seules la segmentation de phrases et les custom entities littérales ont été prévues au benchmark ;
- leur gain ne peut pas être évalué sur le corpus Phase B actuel tant que le corps des articles est absent.

Décision : **ne pas intégrer wink au runtime à ce stade**. Rebenchmark après disponibilité du contenu complet.

## TF-IDF

Sur les 149 event candidates actuels (titre + extrait), le benchmark produit 199 paires au-dessus d’un seuil exploratoire de 0,18.

Le proxy de cohérence `même famille + acteur/club partagé` n’est satisfait que pour environ 53 % des 30 premières paires. Ce chiffre n’est pas un score de qualité vérité-terrain : il confirme simplement que TF-IDF seul ne peut pas décider d’un rattachement story.

Décision : **conserver TF-IDF comme signal lexical candidat pour le futur matching hybride**, jamais comme arbitre unique.

## Conséquence architecturale

Avant de poursuivre sérieusement la segmentation multi-event et le matching de stories, Club Actu a besoin d’une étape d’**enrichissement du contenu des articles pertinents**.

Principes à préserver :

1. ne pas refetcher inutilement tous les articles découverts ;
2. enrichir en priorité les articles déjà jugés pertinents pour au moins un club ;
3. ne fetcher le corps qu’une seule fois par article source, même s’il concerne plusieurs clubs ;
4. conserver Phase A et son `content_hash` actuel stables ;
5. ne pas faire dépendre l’extraction du contenu de la future logique Story ;
6. utiliser un extracteur spécifique/API lorsqu’il existe, sinon Readability comme candidat générique, puis journaliser les échecs.

La conception du stockage et de la file d’enrichissement doit être décidée séparément avant toute migration D1.
