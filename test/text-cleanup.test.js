import test from "node:test";
import assert from "node:assert/strict";

import { cleanEditorialText, decodeHtmlEntities, hasKnownEditorialNoise } from "../src/text-cleanup.js";

test("decodes decimal, hexadecimal, named and nested HTML entities", () => {
  assert.equal(
    decodeHtmlEntities("L&amp;rsquo;OL &#039;avance&#x2026; &eacute;t&eacute;"),
    "L’OL 'avance… été"
  );
});

test("cleans But Football Club RSS boilerplate", () => {
  const input = "Une information utile ... Lire plus <p>The post Un titre first appeared on But! Football Club .</p>";
  assert.equal(cleanEditorialText(input, "butfootballclub"), "Une information utile ...");
});

test("removes Le Progrès paywall payload", () => {
  const input = "Le début de l'article... pour lire la suite, rejoignez notre communauté d'abonnés et accédez à tout {'skus': ['premium']}";
  assert.equal(cleanEditorialText(input, "leprogres"), "Le début de l'article");
});

test("removes Le Progrès cookie interstitial while keeping surrounding editorial text", () => {
  const input = "Premier paragraphe. Ce contenu est bloqué car vous n'avez pas accepté les cookies et autres traceurs. Texte de consentement. Gérer mes choix Deuxième paragraphe.";
  assert.equal(cleanEditorialText(input, "leprogres"), "Premier paragraphe. Deuxième paragraphe.");
});

test("detects known stored noise", () => {
  assert.equal(hasKnownEditorialNoise("Le PSG s&amp;rsquo;active"), true);
  assert.equal(hasKnownEditorialNoise("Texte éditorial propre"), false);
});
