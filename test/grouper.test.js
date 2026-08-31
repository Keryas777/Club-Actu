import test from "node:test";
import assert from "node:assert/strict";
import { buildPreviewPairs, normalizeTopicText } from "../src/grouper.js";

test("topic normalization removes accents and punctuation", () => {
  assert.equal(
    normalizeTopicText("PSG : Énorme offre pour Désiré Doué !"),
    "psg enorme offre pour desire doue"
  );
});

test("same transfer story from different sources is suggested", () => {
  const rows = [
    {
      id: "a",
      source_id: "source_a",
      title: "Liverpool prépare une offre pour Bradley Barcola",
      excerpt: "Le club anglais veut recruter l'ailier du PSG cet été.",
      content: "",
      published_at: "2026-08-31T06:00:00Z"
    },
    {
      id: "b",
      source_id: "source_b",
      title: "Barcola vers Liverpool, une offre se prépare",
      excerpt: "Bradley Barcola est ciblé par Liverpool pour un transfert.",
      content: "",
      published_at: "2026-08-31T07:00:00Z"
    }
  ];

  const pairs = buildPreviewPairs(rows, ["PSG", "Paris Saint-Germain"], 10);
  assert.equal(pairs.length, 1);
  assert.ok(["strong", "possible"].includes(pairs[0].confidence));
  assert.ok(pairs[0].shared_context_tokens.includes("barcola"));
  assert.ok(pairs[0].shared_context_tokens.includes("liverpool"));
});

test("club name alone does not merge unrelated stories", () => {
  const rows = [
    {
      id: "a",
      source_id: "source_a",
      title: "PSG : un défenseur ciblé au mercato",
      excerpt: "Le Paris Saint-Germain suit un défenseur central.",
      content: "",
      published_at: "2026-08-31T06:00:00Z"
    },
    {
      id: "b",
      source_id: "source_b",
      title: "PSG : le calendrier européen se précise",
      excerpt: "Le Paris Saint-Germain connaît ses prochains adversaires.",
      content: "",
      published_at: "2026-08-31T06:30:00Z"
    }
  ];

  const pairs = buildPreviewPairs(rows, ["PSG", "Paris Saint-Germain"], 10);
  assert.equal(pairs.length, 0);
});

test("clickbait titles can still match from article context", () => {
  const rows = [
    {
      id: "a",
      source_id: "source_a",
      title: "Coup de tonnerre, Barcola a pris sa décision !",
      excerpt: "Bradley Barcola a donné son accord à Liverpool, qui discute avec le PSG.",
      content: "",
      published_at: "2026-08-31T06:00:00Z"
    },
    {
      id: "b",
      source_id: "source_b",
      title: "Barcola se rapproche de Liverpool",
      excerpt: "Liverpool avance pour Bradley Barcola après des discussions.",
      content: "",
      published_at: "2026-08-31T06:20:00Z"
    }
  ];

  const pairs = buildPreviewPairs(rows, ["PSG", "Paris Saint-Germain"], 10);
  assert.equal(pairs.length, 1);
  assert.ok(pairs[0].shared_context_tokens.includes("barcola"));
  assert.ok(pairs[0].shared_context_tokens.includes("liverpool"));
});

test("similar stories outside time window are ignored", () => {
  const rows = [
    {
      id: "a",
      source_id: "source_a",
      title: "Barcola se rapproche de Liverpool",
      excerpt: "Liverpool avance pour Bradley Barcola.",
      content: "",
      published_at: "2026-08-20T06:00:00Z"
    },
    {
      id: "b",
      source_id: "source_b",
      title: "Barcola se rapproche de Liverpool",
      excerpt: "Liverpool avance pour Bradley Barcola.",
      content: "",
      published_at: "2026-08-31T06:00:00Z"
    }
  ];

  const pairs = buildPreviewPairs(rows, ["PSG"], 10);
  assert.equal(pairs.length, 0);
});
