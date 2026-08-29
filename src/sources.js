export const SOURCE_ADAPTERS = {
  ol_official: {
    id: "ol_official",
    discoveryUrl: "https://www.ol.fr/",
    articleHosts: ["ol.fr", "www.ol.fr"],
    includePath: /\/actualit/i
  },
  olympique_et_lyonnais: {
    id: "olympique_et_lyonnais",
    discoveryUrl: "https://www.olympique-et-lyonnais.com/",
    articleHosts: ["olympique-et-lyonnais.com", "www.olympique-et-lyonnais.com"],
    includePath: /\//i
  },
  footmercato: {
    id: "footmercato",
    discoveryUrl: "https://www.footmercato.net/club/ol/actualite",
    articleHosts: ["footmercato.net", "www.footmercato.net"],
    includePath: /\/a\d+/i
  },
  foot01: {
    id: "foot01",
    discoveryUrl: "https://www.foot01.com/ol",
    articleHosts: ["foot01.com", "www.foot01.com"],
    includePath: /\/(?:ol|mercato|ligue1|football)/i
  },
  sport_fr: {
    id: "sport_fr",
    discoveryUrl: "https://www.sport.fr/football",
    articleHosts: ["sport.fr", "www.sport.fr"],
    includePath: /\.shtm$/i
  },
  leprogres: {
    id: "leprogres",
    discoveryUrl: "https://www.leprogres.fr/sport/ol-olympique-lyonnais-football",
    articleHosts: ["leprogres.fr", "www.leprogres.fr"],
    includePath: /\/sport\//i
  }
};

export function listEnabledAdapters() {
  return Object.values(SOURCE_ADAPTERS);
}
