import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRoleClassifierPrompt,
  parseRoleClassifierOutput,
  rolePreviewDecision
} from "../src/relevance-role.js";

test("role classifier prompt uses a closed role vocabulary", () => {
  const messages = buildRoleClassifierPrompt({
    club_id: "psg",
    club_name: "Paris Saint-Germain",
    aliases: ["PSG", "Paris Saint-Germain"],
    title: "Stade Rennais : du gros monde sur Estéban Lepaul",
    excerpt: "Il a marqué contre le PSG dimanche.",
    lead: ""
  });

  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /opponent/);
  assert.match(messages[0].content, /historical_reference/);
  assert.match(messages[0].content, /financial_stakeholder/);
});

test("role classifier output parser accepts valid strict JSON", () => {
  assert.deepEqual(
    parseRoleClassifierOutput('{"role":"opponent","confidence":0.94,"rationale":"The club is only the recent opponent."}'),
    {
      role: "opponent",
      confidence: 0.94,
      rationale: "The club is only the recent opponent."
    }
  );
});

test("role classifier output parser rejects unknown roles", () => {
  assert.throws(
    () => parseRoleClassifierOutput('{"role":"famous_club","confidence":0.9,"rationale":"x"}'),
    /invalid_role/
  );
});

test("high-confidence central roles preview as relevant", () => {
  for (const role of ["subject", "transfer_party", "financial_stakeholder"]) {
    assert.equal(
      rolePreviewDecision({ role, confidence: 0.9, rationale: "central" }).decision,
      "relevant"
    );
  }
});

test("high-confidence contextual roles preview as rejected", () => {
  for (const role of ["opponent", "historical_reference", "relative_or_personal_link", "incidental"]) {
    assert.equal(
      rolePreviewDecision({ role, confidence: 0.9, rationale: "context only" }).decision,
      "rejected"
    );
  }
});

test("low confidence remains reviewable", () => {
  assert.deepEqual(
    rolePreviewDecision({ role: "opponent", confidence: 0.55, rationale: "uncertain" }),
    { decision: "needs_review", reason_code: "role_classifier_low_confidence" }
  );
});


test("role classifier prompt only sends the matched text field", () => {
  const messages = buildRoleClassifierPrompt({
    club_id: "psg",
    club_name: "Paris Saint-Germain",
    aliases: ["PSG"],
    title: "Rennes prépare son mercato",
    excerpt: "Après son match contre le PSG, Rennes prépare la suite.",
    lead: "This lead should not be sent when excerpt triggered.",
    matched_alias: "PSG",
    matched_field: "excerpt",
    match_context: "Après son match contre le PSG, Rennes prépare la suite."
  });

  const payload = JSON.parse(messages[1].content);
  assert.equal(payload.matched_field, "excerpt");
  assert.match(payload.matched_text, /match contre le PSG/);
  assert.equal(Object.hasOwn(payload, "excerpt"), false);
  assert.equal(Object.hasOwn(payload, "lead"), false);
});
