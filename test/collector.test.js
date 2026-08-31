import test from "node:test";
import assert from "node:assert/strict";

import { decodeEntities } from "../src/collector.js";

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
