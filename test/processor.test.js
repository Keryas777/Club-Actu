import test from "node:test";
import assert from "node:assert/strict";
import { assessClubRelevance, classifyTechnicalArticle } from "../src/processor.js";

const strongAliases = [
  { alias: "Olympique Lyonnais", strength: "strong" },
  { alias: "OL", strength: "strong" },
  { alias: "Lyon", strength: "weak" }
];

test("direct club sources are relevant without alias matching", () => {
  assert.deepEqual(
    assessClubRelevance({
      relationType: "direct",
      aliases: strongAliases,
      title: "Communiqué du club",
      excerpt: "Une actualité publiée directement par le club.",
      content: ""
    }),
    { decision: "relevant", reason_code: "direct_club_source" }
  );
});

test("strong alias makes a national-source article relevant", () => {
  assert.deepEqual(
    assessClubRelevance({
      relationType: "relevant",
      aliases: strongAliases,
      title: "Mercato : l'OL avance sur un défenseur",
      excerpt: "",
      content: ""
    }),
    { decision: "relevant", reason_code: "strong_club_alias" }
  );
});

test("weak alias stays reviewable rather than forced relevant", () => {
  assert.deepEqual(
    assessClubRelevance({
      relationType: "relevant",
      aliases: strongAliases,
      title: "Lyon prépare une grande soirée européenne",
      excerpt: "",
      content: ""
    }),
    { decision: "needs_review", reason_code: "weak_club_alias" }
  );
});

test("unrelated national article is rejected for the club", () => {
  assert.deepEqual(
    assessClubRelevance({
      relationType: "relevant",
      aliases: strongAliases,
      title: "Marseille prépare son prochain match",
      excerpt: "Les joueurs phocéens se sont entraînés ce matin.",
      content: ""
    }),
    { decision: "rejected", reason_code: "club_not_relevant" }
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
