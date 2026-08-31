import test from "node:test";
import assert from "node:assert/strict";
import { SOURCE_ADAPTERS, listEnabledAdapters } from "../src/sources.js";

test("Sport365 is collected from the global football index", () => {
  const source = SOURCE_ADAPTERS.sport365;

  assert.ok(source);
  assert.equal(source.id, "sport365");
  assert.equal(source.discoveryUrl, "https://www.sport365.fr/football365");
  assert.deepEqual(source.articleHosts, ["sport365.fr", "www.sport365.fr"]);
  assert.equal(source.articlePath.test("/rennes-mans-sidibe-expulsion-record-ligue-1-10858072.html"), true);
  assert.equal(source.articlePath.test("/football365/page/2"), false);
  assert.equal(source.articlePath.test("/football365"), false);
});

test("Sport365 adapter is enabled in the collector", () => {
  assert.equal(
    listEnabledAdapters().some((source) => source.id === "sport365"),
    true
  );
});
