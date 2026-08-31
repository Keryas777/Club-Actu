export const SOURCE_ADAPTERS = {
  ol_official: {
    id: "ol_official",
    discoveryMode: "ol_api",
    configUrl: "https://www.ol.fr/app-config.json",
    articleBaseUrl: "https://www.ol.fr/fr/actualites/",
    locale: "fr",
    pageSize: 25
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
  },
  sport365: {
    id: "sport365",
    discoveryUrl: "https://www.sport365.fr/football365",
    articleHosts: ["sport365.fr", "www.sport365.fr"],
    articlePath: /-\d{6,}\.html$/i,
    includePath: /\.html$/i
  },
  sports_fr: {
    id: "sports_fr",
    discoveryMode: "rss",
    discoveryUrl: "https://www.sports.fr/football/feed",
    articleHosts: ["sports.fr", "www.sports.fr"]
  },
  topmercato: {
    id: "topmercato",
    discoveryMode: "rss",
    discoveryUrl: "https://www.topmercato.com/feed",
    articleHosts: ["topmercato.com", "www.topmercato.com"]
  },
  butfootballclub: {
    id: "butfootballclub",
    discoveryMode: "rss",
    discoveryUrl: "https://www.butfootballclub.fr/feed",
    articleHosts: ["butfootballclub.fr", "www.butfootballclub.fr"]
  },
  ferveur_lyonnaise: {
    id: "ferveur_lyonnaise",
    discoveryUrl: "https://www.ferveurlyonnaise.fr/",
    articleHosts: ["ferveurlyonnaise.fr", "www.ferveurlyonnaise.fr"],
    includePath: /\//i
  },
  madeingones: {
    id: "madeingones",
    discoveryUrl: "https://madeingones.ouest-france.fr/",
    articleHosts: ["madeingones.ouest-france.fr"],
    includePath: /\//i
  },
  sports_orange: {
    id: "sports_orange",
    discoveryUrl: "https://sports.orange.fr/football/",
    articleHosts: ["sports.orange.fr"],
    includePath: /\/football\//i,
    excludePath: /\/videos\/football\//i
  },
};

export function listEnabledAdapters() {
  return Object.values(SOURCE_ADAPTERS);
}
