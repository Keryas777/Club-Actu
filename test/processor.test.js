import test from "node:test";
import assert from "node:assert/strict";
import { assessClubRelevance, classifyTechnicalArticle, previewV3Decision } from "../src/processor.js";

function assertDecision(actual, decision, reasonCode) {
  assert.equal(actual.decision, decision);
  assert.equal(actual.reason_code, reasonCode);
}

const strongAliases = [
  { alias: "Olympique Lyonnais", strength: "strong" },
  { alias: "OL", strength: "strong" },
  { alias: "Lyon", strength: "weak" }
];

test("direct club sources are relevant without alias matching", () => {
  assertDecision(
    assessClubRelevance({
      relationType: "direct",
      aliases: strongAliases,
      title: "Communiqué du club",
      excerpt: "Une actualité publiée directement par le club.",
      content: ""
    }),
    "relevant",
    "direct_club_source"
  );
});

test("strong alias makes a national-source article relevant", () => {
  const result = assessClubRelevance({
    relationType: "relevant",
    aliases: strongAliases,
    title: "Mercato : l'OL avance sur un défenseur",
    excerpt: "",
    content: ""
  });
  assertDecision(result, "relevant", "strong_alias_title");
  assert.match(result.reason_detail, /"matched_field":"title"/);
});

test("weak alias stays reviewable rather than forced relevant", () => {
  assertDecision(
    assessClubRelevance({
      relationType: "relevant",
      aliases: strongAliases,
      title: "Lyon prépare une grande soirée européenne",
      excerpt: "",
      content: ""
    }),
    "needs_review",
    "weak_alias_title"
  );
});

test("unrelated national article is rejected for the club", () => {
  assertDecision(
    assessClubRelevance({
      relationType: "relevant",
      aliases: strongAliases,
      title: "Marseille prépare son prochain match",
      excerpt: "Les joueurs phocéens se sont entraînés ce matin.",
      content: ""
    }),
    "rejected",
    "club_not_relevant"
  );
});

test("navigation pages are rejected deterministically", () => {
  assert.deepEqual(
    classifyTechnicalArticle(
      {
        canonical_url: "https://example.com/classement",
        title: "Classement Ligue 1"
      },
      {
        normalized_title: "Classement Ligue 1",
        normalized_excerpt: "",
        normalized_content: ""
      }
    ),
    { status: "rejected", reason_code: "navigation_page" }
  );
});

test("metadata with a useful excerpt is usable without page fetch", () => {
  assert.deepEqual(
    classifyTechnicalArticle(
      {
        canonical_url: "https://example.com/article",
        title: "L'Olympique Lyonnais prépare son prochain rendez-vous"
      },
      {
        normalized_title: "L'Olympique Lyonnais prépare son prochain rendez-vous",
        normalized_excerpt: "Le club a communiqué plusieurs informations utiles avant la rencontre de dimanche.",
        normalized_content: ""
      }
    ),
    { status: "usable", reason_code: null }
  );
});

test("title-only metadata requests content extraction", () => {
  assert.deepEqual(
    classifyTechnicalArticle(
      {
        canonical_url: "https://example.com/article",
        title: "Une actualité football suffisamment longue"
      },
      {
        normalized_title: "Une actualité football suffisamment longue",
        normalized_excerpt: "",
        normalized_content: ""
      }
    ),
    { status: "needs_content", reason_code: "insufficient_content" }
  );
});


test("Le Progres subscription tunnel artifacts are navigation pages", () => {
  assert.deepEqual(
    classifyTechnicalArticle(
      {
        canonical_url: "https://www.leprogres.fr/sport/%7Burl_tunnel%7D",
        title: "REFUSER & S'ABONNER"
      },
      {
        normalized_title: "REFUSER & S'ABONNER",
        normalized_excerpt: "",
        normalized_content: ""
      }
    ),
    { status: "rejected", reason_code: "navigation_page" }
  );
});

test("Le Progres logout artifacts are navigation pages", () => {
  assert.deepEqual(
    classifyTechnicalArticle(
      {
        canonical_url: "https://www.leprogres.fr/sport/%7Burl_logout%7D",
        title: "Se déconnecter"
      },
      {
        normalized_title: "Se déconnecter",
        normalized_excerpt: "",
        normalized_content: ""
      }
    ),
    { status: "rejected", reason_code: "navigation_page" }
  );
});


test("PSG aliases do not treat generic Paris as relevant", () => {
  const aliases = [
    { alias: "Paris Saint-Germain", strength: "strong" },
    { alias: "Paris Saint Germain", strength: "strong" },
    { alias: "Paris SG", strength: "strong" },
    { alias: "PSG", strength: "strong" }
  ];

  assertDecision(
    assessClubRelevance({
      relationType: "relevant",
      aliases,
      title: "Paris FC domine Nice en Ligue 1",
      excerpt: "",
      content: ""
    }),
    "rejected",
    "club_not_relevant"
  );

  assertDecision(
    assessClubRelevance({
      relationType: "relevant",
      aliases,
      title: "Le PSG prépare son prochain rendez-vous européen",
      excerpt: "",
      content: ""
    }),
    "relevant",
    "strong_alias_title"
  );
});

test("OM aliases recognize Marseille without OL-specific assumptions", () => {
  const aliases = [
    { alias: "Olympique de Marseille", strength: "strong" },
    { alias: "Olympique Marseille", strength: "strong" },
    { alias: "OM", strength: "strong" },
    { alias: "Marseille", strength: "strong" }
  ];

  assertDecision(
    assessClubRelevance({
      relationType: "relevant",
      aliases,
      title: "Mercato : Marseille avance sur un défenseur",
      excerpt: "",
      content: ""
    }),
    "relevant",
    "strong_alias_title"
  );
});


test("clickbait title can still be relevant when the club is central in the excerpt", () => {
  const result = assessClubRelevance({
    relationType: "relevant",
    aliases: [{ alias: "PSG", strength: "strong" }],
    title: "Coup de tonnerre, il a pris sa décision !",
    excerpt: "Le PSG a reçu la réponse du joueur ce dimanche.",
    content: ""
  });
  assertDecision(result, "relevant", "strong_alias_excerpt");
});

test("clickbait title can still be relevant when the club appears immediately in the article lead", () => {
  const result = assessClubRelevance({
    relationType: "relevant",
    aliases: [{ alias: "OM", strength: "strong" }],
    title: "C'est terminé, le verdict est tombé",
    excerpt: "",
    content: "L'OM a décidé de mettre fin aux discussions avec le joueur. Les dirigeants marseillais veulent avancer rapidement."
  });
  assertDecision(result, "relevant", "strong_alias_lead");
});

test("a club mentioned only deep in the body is not auto-promoted to relevant", () => {
  const result = assessClubRelevance({
    relationType: "relevant",
    aliases: [{ alias: "PSG", strength: "strong" }],
    title: "Stade Rennais : du gros monde sur Estéban Lepaul",
    excerpt: "Plusieurs clubs suivent l'attaquant rennais.",
    content: ("Le dossier concerne avant tout Rennes et plusieurs clubs étrangers. ".repeat(20)) +
      "Le PSG a également été cité parmi les équipes attentives."
  });
  assertDecision(result, "needs_review", "strong_alias_body_only");
});

test("repeated body-only mentions remain reviewable instead of automatically relevant", () => {
  const result = assessClubRelevance({
    relationType: "relevant",
    aliases: [{ alias: "OM", strength: "strong" }],
    title: "La Premier League pose un gros chèque à l'OL !",
    excerpt: "Lyon pourrait recevoir une offre importante.",
    content: ("Le dossier lyonnais occupe l'essentiel de l'article. ".repeat(20)) +
      "L'OM est cité pour comparaison. Plus loin, l'OM apparaît encore dans un rappel de contexte."
  });
  assertDecision(result, "needs_review", "strong_alias_body_repeated");
});

test("weak aliases mentioned only deep in body do not create review noise", () => {
  const result = assessClubRelevance({
    relationType: "relevant",
    aliases: [{ alias: "Lyon", strength: "weak" }],
    title: "Une actualité sans rapport avec le club",
    excerpt: "Le sujet concerne une autre équipe.",
    content: ("Le texte développe un autre sujet sportif. ".repeat(30)) + "Un déplacement à Lyon est évoqué en fin d'article."
  });
  assertDecision(result, "rejected", "club_not_relevant");
});


test("reason detail exposes the triggering excerpt context", () => {
  const result = assessClubRelevance({
    relationType: "relevant",
    aliases: [{ alias: "PSG", strength: "strong" }],
    title: "Stade Rennais : une nouvelle piste au mercato",
    excerpt: "Après leur rencontre face au PSG, les Rennais ont repris les discussions avec plusieurs clubs.",
    content: ""
  });

  assertDecision(result, "relevant", "strong_alias_excerpt");
  const detail = JSON.parse(result.reason_detail);
  assert.equal(detail.matched_alias, "PSG");
  assert.equal(detail.matched_field, "excerpt");
  assert.match(detail.match_context, /rencontre face au PSG/i);
  assert.match(detail.match_context, /Rennais/i);
});

test("reason detail exposes context for a deep body-only mention", () => {
  const prefix = "Le dossier concerne uniquement le Stade Rennais et son mercato. ".repeat(20);
  const result = assessClubRelevance({
    relationType: "relevant",
    aliases: [{ alias: "PSG", strength: "strong" }],
    title: "Stade Rennais : le mercato continue",
    excerpt: "Plusieurs mouvements sont encore envisagés.",
    content: prefix + "Après un rappel de la rencontre face au PSG, le sujet revient immédiatement au recrutement rennais."
  });

  assertDecision(result, "needs_review", "strong_alias_body_only");
  const detail = JSON.parse(result.reason_detail);
  assert.equal(detail.matched_field, "body");
  assert.match(detail.match_context, /rencontre face au PSG/i);
});


test("Phase A v3 preview keeps direct and title relevance unchanged", () => {
  assert.deepEqual(
    previewV3Decision("relevant", "direct_club_source"),
    { decision: "relevant", reason_code: "direct_club_source" }
  );
  assert.deepEqual(
    previewV3Decision("relevant", "strong_alias_title"),
    { decision: "relevant", reason_code: "strong_alias_title" }
  );
});

test("Phase A v3 preview moves excerpt and lead auto-relevance to review", () => {
  assert.deepEqual(
    previewV3Decision("relevant", "strong_alias_excerpt"),
    {
      decision: "needs_review",
      reason_code: "strong_alias_excerpt_role_review"
    }
  );
  assert.deepEqual(
    previewV3Decision("relevant", "strong_alias_lead"),
    {
      decision: "needs_review",
      reason_code: "strong_alias_lead_role_review"
    }
  );
});

test("Phase A v3 preview leaves existing review and rejected decisions unchanged", () => {
  assert.deepEqual(
    previewV3Decision("needs_review", "strong_alias_body_only"),
    { decision: "needs_review", reason_code: "strong_alias_body_only" }
  );
  assert.deepEqual(
    previewV3Decision("rejected", "club_not_relevant"),
    { decision: "rejected", reason_code: "club_not_relevant" }
  );
});
