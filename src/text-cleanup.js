function compactSpace(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

const NAMED_ENTITIES = new Map([
  ["nbsp", " "],
  ["amp", "&"],
  ["quot", '"'],
  ["apos", "'"],
  ["lt", "<"],
  ["gt", ">"],
  ["rsquo", "’"],
  ["lsquo", "‘"],
  ["rdquo", "”"],
  ["ldquo", "“"],
  ["hellip", "…"],
  ["ndash", "–"],
  ["mdash", "—"],
  ["laquo", "«"],
  ["raquo", "»"],
  ["eacute", "é"],
  ["egrave", "è"],
  ["ecirc", "ê"],
  ["agrave", "à"],
  ["ugrave", "ù"],
  ["ccedil", "ç"],
  ["ocirc", "ô"],
  ["icirc", "î"],
  ["aelig", "æ"],
  ["oelig", "œ"]
]);

function decodeOnce(text) {
  return String(text || "")
    .replace(/&#x([0-9a-f]+);?/gi, (match, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    })
    .replace(/&#([0-9]+);?/g, (match, decimal) => {
      const codePoint = Number.parseInt(decimal, 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    })
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES.get(name.toLowerCase()) ?? match);
}

export function decodeHtmlEntities(text = "") {
  let current = String(text || "");
  for (let pass = 0; pass < 4; pass += 1) {
    const next = decodeOnce(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

function removeTags(text) {
  return String(text || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function cleanLeProgres(text) {
  let value = text;

  value = value.replace(
    /Ce contenu est bloqué car vous n'avez pas accepté les cookies et autres traceurs\.[\s\S]*?Gérer mes choix/gi,
    " "
  );

  value = value.replace(
    /(?:\.{3}|…)?\s*pour lire la suite, rejoignez notre communauté d'abonnés[\s\S]*$/gi,
    ""
  );

  value = value.replace(/\{\s*['"]skus['"]\s*:\s*\[[^\]]*\]\s*\}/gi, " ");
  return value;
}

function cleanButFootballClub(text) {
  let value = text;
  value = value.replace(/\s*Lire plus\s*(?=The post\b)/gi, " ");
  value = value.replace(/\s*The post\s+[\s\S]*?\s+first appeared on But! Football Club\s*\.?\s*$/gi, "");
  return value;
}

export function cleanEditorialText(text = "", sourceId = "") {
  let value = decodeHtmlEntities(removeTags(text));
  const source = String(sourceId || "").toLowerCase();

  if (source === "leprogres") value = cleanLeProgres(value);
  if (source === "butfootballclub") value = cleanButFootballClub(value);

  return compactSpace(value);
}

export function hasKnownEditorialNoise(text = "") {
  const value = String(text || "");
  return /&#(?:x[0-9a-f]+|[0-9]+);?|&(?:amp|rsquo|lsquo|rdquo|ldquo|hellip|ndash|mdash|eacute|egrave|agrave|ccedil);|The post\b[\s\S]*?first appeared on But! Football Club|pour lire la suite, rejoignez notre communauté d'abonnés|Ce contenu est bloqué car vous n'avez pas accepté les cookies|\{\s*['"]skus['"]\s*:/i.test(value);
}
