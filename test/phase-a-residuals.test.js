import test from "node:test";
import assert from "node:assert/strict";
import {
  isObviousNonFootballReview,
  statusFromAssessmentCounts
} from "../src/phase-a-residuals.js";

test("obvious rugby and non-football Lyon noise is rejected deterministically", () => {
  assert.equal(
    isObviousNonFootballReview({
      title: "Top 14 : après le coup Cros, Lyon accélère",
      url: "https://www.sport.fr/rugby/top-14-lyon-accelere.shtm"
    }),
    true
  );

  assert.equal(
    isObviousNonFootballReview({
      title: "Ultra-trail. UTMB 2026 : Le Lyonnais Baptiste Chassagne",
      url: "https://www.leprogres.fr/sport/2026/08/29/utmb-2026"
    }),
    true
  );

  assert.equal(
    isObviousNonFootballReview({
      title: "Lyon Urban Trail",
      url: "https://www.leprogres.fr/sport/lyon-urban-trail"
    }),
    true
  );
});

test("football articles containing Lyon remain eligible for semantic review", () => {
  assert.equal(
    isObviousNonFootballReview({
      title: "Ligue 1 : compos probables pour Lyon – AJ Auxerre",
      url: "https://www.sport.fr/football/ligue-1-lyon-auxerre.shtm"
    }),
    false
  );
});

test("coarse processing status prefers relevant then review then rejected", () => {
  assert.equal(statusFromAssessmentCounts({ relevant: 1, needs_review: 2, rejected: 3 }), "phase_a_ready");
  assert.equal(statusFromAssessmentCounts({ relevant: 0, needs_review: 2, rejected: 3 }), "phase_a_review");
  assert.equal(statusFromAssessmentCounts({ relevant: 0, needs_review: 0, rejected: 3 }), "phase_a_rejected");
  assert.equal(statusFromAssessmentCounts({}), "phase_a_processed");
});
