const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;
const TMDB_BASE = "https://api.themoviedb.org/3";
const IMAGE_BASE = "https://image.tmdb.org/t/p";
const token = process.env.TMDB_READ_ACCESS_TOKEN || process.env.TMDB_API_KEY;

const PLATFORMS = [
  { id: "netflix", name: "Netflix", match: /netflix/i },
  { id: "prime", name: "Prime Video", match: /amazon prime video|prime video/i },
  { id: "hotstar", name: "JioHotstar", match: /jiohotstar|disney\+ hotstar|hotstar/i },
  { id: "zee5", name: "ZEE5", match: /zee5/i },
  { id: "sonyliv", name: "Sony LIV", match: /sony liv/i },
  { id: "aha", name: "Aha", match: /^aha$/i },
  { id: "appletv", name: "Apple TV+", match: /apple tv\+/i }
];

const ROWS = [
  { id: "popular", name: "Popular" },
  { id: "rated", name: "Highest Rated" }
];

const cache = new Map();
const CACHE_MS = 6 * 60 * 60 * 1000;

function json(res, body) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Cache-Control", "public, max-age=300");
  return res.json(body);
}

async function tmdb(path, params = {}) {
  if (!token) throw new Error("TMDB token is not configured. Set TMDB_READ_ACCESS_TOKEN or TMDB_API_KEY in Render.");
  const url = new URL(TMDB_BASE + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, accept: "application/json" }
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`TMDB request failed (${response.status}): ${detail.slice(0, 250)}`);
  }
  return response.json();
}

async function getProviders(type) {
  const key = `providers:${type}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const data = await tmdb(`/watch/providers/${type}`, { watch_region: "IN", language: "en-US" });
  cache.set(key, { at: Date.now(), value: data.results || [] });
  return data.results || [];
}

async function providerId(platform, type) {
  const providers = await getProviders(type);
  const found = providers.find(p => platform.match.test(p.provider_name || ""));
  return found ? found.provider_id : null;
}

function toVideo(item, type) {
  const title = type === "movie" ? item.title : item.name;
  const date = type === "movie" ? item.release_date : item.first_air_date;
  const year = date ? date.slice(0, 4) : "";
  const poster = item.poster_path ? `${IMAGE_BASE}/w500${item.poster_path}` : null;
  const background = item.backdrop_path ? `${IMAGE_BASE}/w1280${item.backdrop_path}` : null;
  return {
    id: `tmdb:${item.id}`,
    type,
    name: title || "Untitled",
    poster,
    background,
    description: item.overview || "Description unavailable.",
    releaseInfo: year || undefined,
    genres: undefined
  };
}

async function catalog(platform, type, row) {
  const pid = await providerId(platform, type);
  if (!pid) return [];
  const sort = row === "rated" ? "vote_average.desc" : "popularity.desc";
  const params = {
    watch_region: "IN",
    with_watch_providers: pid,
    with_watch_monetization_types: "flatrate|rent|buy",
    sort_by: sort,
    page: 1,
    language: "en-US"
  };
  if (row === "rated") params["vote_count.gte"] = 100;
  const data = await tmdb(`/discover/${type}`, params);
  return (data.results || []).slice(0, 30).map(x => toVideo(x, type));
}

app.get("/health", (_req, res) => json(res, {
  status: "ok",
  addon: "OTT Universe India",
  tokenConfigured: Boolean(token)
}));

app.get("/manifest.json", (_req, res) => {
  const catalogs = [];
  for (const platform of PLATFORMS) {
    for (const type of ["movie", "series"]) {
      const tmdbType = type === "series" ? "tv" : "movie";
      for (const row of ROWS) {
        catalogs.push({
          type,
          id: `${platform.id}_${tmdbType}_${row.id}`,
          name: `${platform.name} • ${row.name}`,
          extra: [{ name: "skip" }, { name: "search", isRequired: false }]
        });
      }
    }
  }
  json(res, {
    id: "com.ottuniverse.india",
    version: "1.0.0",
    name: "OTT Universe India",
    description: "Discover movies and series reported as available on major OTT platforms in India.",
    resources: ["catalog", "meta"],
    types: ["movie", "series"],
    catalogs,
    idPrefixes: ["tmdb:"]
  });
});

app.get("/catalog/:type/:id.json", async (req, res) => {
  try {
    const { type, id } = req.params;
    const platform = PLATFORMS.find(p => id.startsWith(p.id + "_"));
    const row = id.endsWith("_rated") ? "rated" : "popular";
    const mediaType = type === "series" ? "tv" : "movie";
    if (!platform || !["movie", "series"].includes(type)) return json(res, { metas: [] });
    const metas = await catalog(platform, mediaType, row);
    json(res, { metas });
  } catch (err) {
    console.error(err);
    res.status(502);
    json(res, { metas: [], error: err.message });
  }
});

app.get("/meta/:type/:id.json", async (req, res) => {
  try {
    const type = req.params.type === "series" ? "tv" : "movie";
    const id = req.params.id.replace(/^tmdb:/, "");
    if (!/^\d+$/.test(id)) return json(res, { meta: null });
    const item = await tmdb(`/${type}/${id}`, { language: "en-US" });
    const video = toVideo(item, type === "tv" ? "series" : "movie");
    const genres = (item.genres || []).map(g => g.name);
    const meta = {
      ...video,
      genres,
      runtime: type === "movie" && item.runtime ? `${item.runtime} min` : undefined,
      country: (item.production_countries || []).map(c => c.name).join(", ") || undefined,
      director: undefined,
      imdbRating: undefined
    };
    json(res, { meta });
  } catch (err) {
    console.error(err);
    res.status(502);
    json(res, { meta: null, error: err.message });
  }
});

app.listen(PORT, () => console.log(`OTT Universe India listening on ${PORT}`));
