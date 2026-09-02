import test from "node:test";
import assert from "node:assert/strict";

import { decodeEntities, normalizeSourceTitle } from "../src/collector.js";

test("decodes numeric HTML entities", () => {
  assert.equal(
    decodeEntities("Aubameyang, c&#8217;est fou&#8230;"),
    "Aubameyang, c’est fou…"
  );
  assert.equal(
    decodeEntities("OL &#x2013; PSG"),
    "OL – PSG"
  );
});

test("decodes named typographic HTML entities", () => {
  assert.equal(
    decodeEntities("d&rsquo;oeuvre &mdash; &laquo; test &raquo;"),
    "d’oeuvre — « test »"
  );
});

test("decodes nested entities and normalizes whitespace", () => {
  assert.equal(
    decodeEntities("L&amp;#8217;OL&nbsp;&amp;&nbsp;le PSG"),
    "L’OL & le PSG"
  );
});


test("stabilizes Sports Orange listing prefixes without hiding real title changes", () => {
  assert.equal(
    normalizeSourceTitle(
      "sports_orange",
      "19:09 Football OM - Richard : « Genesio ? On n'était pas loin du point de rupture »"
    ),
    "OM - Richard : « Genesio ? On n'était pas loin du point de rupture »"
  );
  assert.equal(
    normalizeSourceTitle(
      "sports_orange",
      "02/09 Football OM - Richard : « Genesio ? On n'était pas loin du point de rupture »"
    ),
    "OM - Richard : « Genesio ? On n'était pas loin du point de rupture »"
  );
  assert.equal(
    normalizeSourceTitle(
      "sports_orange",
      "Lille - Létang : « Meunier m'a demandé ..."
    ),
    "Lille - Létang : « Meunier m'a demandé ..."
  );
});

test("stabilizes MadeInGones card timestamps and duplicate section labels", () => {
  assert.equal(
    normalizeSourceTitle(
      "madeingones",
      "Ligue 1 Une seconde agression raciste a eu lieu en marge du match OL - Le Havre AC OL • 15h45"
    ),
    "Ligue 1 Une seconde agression raciste a eu lieu en marge du match OL - Le Havre AC OL"
  );
  assert.equal(
    normalizeSourceTitle(
      "madeingones",
      "Ligue 1 Une seconde agression raciste a eu lieu en marge du match OL - Le Havre AC OL • 02/09"
    ),
    "Ligue 1 Une seconde agression raciste a eu lieu en marge du match OL - Le Havre AC OL"
  );
  assert.equal(
    normalizeSourceTitle(
      "madeingones",
      "OFFICIEL Malick Fofana transféré à Sunderland (officiel) Mercato • Mercato • 01h15"
    ),
    "OFFICIEL Malick Fofana transféré à Sunderland (officiel) Mercato"
  );
});
