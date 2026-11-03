const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;
const TMDB_BASE = "https://api.themoviedb.org/3";
const IMAGE_BASE = "https://image.tmdb.org/t/p";
const token = process.env.TMDB_READ_ACCESS_TOKEN || process.env.TMDB_API_KEY;

// Provider names are matched against TMDB's India provider list.
// Apple TV Store is intentionally excluded from Apple TV+.
const PLATFORMS = [
  { id: "netflix", name: "Netflix", match: /netflix/i },
  { id: "prime", name: "Prime Video", match: /amazon prime video|prime video/i },
  { id: "hotstar", name: "JioHotstar", match: /jiohotstar|disney\+ hotstar|hotstar/i },
  { id: "zee5", name: "ZEE5", match: /zee5/i },
  { id: "sonyliv", name: "Sony LIV", match: /sony liv/i },
  { id: "aha", name: "Aha", match: /^aha$/i },
  { id: "appletv", name: "Apple TV+", match: /^apple tv\+?$/i }
];

// Popular and Highest Rated are subscription-only. Rent and Buy are separate rows.
const ROWS = [
  { id: "popular", name: "Popular", monetization: "flatrate", sort: "popularity.desc" },
  { id: "rated", name: "Highest Rated", monetization: "flatrate", sort: "vote_average.desc" },
  { id: "rent", name: "Rent", monetization: "rent", sort: "popularity.desc" },
  { id: "buy", name: "Buy", monetization: "buy", sort: "popularity.desc" }
];

const cache = new Map();
const CACHE_MS = 60 * 60 * 1000;

function cached(key) {
  const entry = cache.get(key);
  return entry && Date.now() - entry.at < CACHE_MS ? entry.value : null;
}

function saveCache(key, value) {
  cache.set(key, { at: Date.now(), value });
  return value;
}

function json(res, body) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Cache-Control", "public, max-age=300");
  return res.json(body);
}

async function tmdb(path, params = {}) {
  if (!token) throw new Error("TMDB token is not configured. Set TMDB_READ_ACCESS_TOKEN in Render.");
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
  const hit = cached(key);
  if (hit) return hit;
  const data = await tmdb(`/watch/providers/${type}`, { watch_region: "IN", language: "en-US" });
  return saveCache(key, data.results || []);
}

async function providerId(platform, type) {
  const providers = await getProviders(type);
  const found = providers.find(p => platform.match.test(p.provider_name || ""));
  return found ? found.provider_id : null;
}

function toVideo(item, tmdbType) {
  const isMovie = tmdbType === "movie";
  const title = isMovie ? item.title : item.name;
  const date = isMovie ? item.release_date : item.first_air_date;
  const year = date ? date.slice(0, 4) : "";
  return {
    id: `tmdb:${item.id}`,
    type: isMovie ? "movie" : "series",
    name: title || "Untitled",
    poster: item.poster_path ? `${IMAGE_BASE}/w500${item.poster_path}` : null,
    background: item.backdrop_path ? `${IMAGE_BASE}/w1280${item.backdrop_path}` : null,
    description: item.overview || "Description unavailable.",
    releaseInfo: year || undefined
  };
}

// TMDB's discover filters can combine provider and monetization independently.
// Verify the specific provider's own flatrate/rent/buy entry before displaying a title.
async function hasProviderAccess(platform, tmdbType, itemId, monetization) {
  const key = `availability:${tmdbType}:${itemId}:${platform.id}:${monetization}`;
  const hit = cached(key);
  if (hit !== null) return hit;

  const pid = await providerId(platform, tmdbType);
  if (!pid) return saveCache(key, false);

  const details = await tmdb(`/${tmdbType}/${itemId}/watch/providers`);
  const india = details.results && details.results.IN;
  const entries = india && india[monetization] ? india[monetization] : [];
  const matched = entries.some(provider => provider.provider_id === pid);
  return saveCache(key, matched);
}

async function catalog(platform, tmdbType, row) {
  const pid = await providerId(platform, tmdbType);
  if (!pid) return [];

  const params = {
    watch_region: "IN",
    with_watch_providers: pid,
    with_watch_monetization_types: row.monetization,
    sort_by: row.sort,
    page: 1,
    language: "en-US"
  };
  if (row.id === "rated") params["vote_count.gte"] = 100;

  const data = await tmdb(`/discover/${tmdbType}`, params);
  const candidates = (data.results || []).slice(0, 30);
  const verified = [];

  // Small batches avoid sending too many simultaneous requests to TMDB.
  for (let i = 0; i < candidates.length; i += 5) {
    const batch = candidates.slice(i, i + 5);
    const checks = await Promise.all(batch.map(item =>
      hasProviderAccess(platform, tmdbType, item.id, row.monetization)
        .catch(err => {
          console.error(`Availability check failed for ${tmdbType}/${item.id}:`, err.message);
          return false;
        })
    ));
    batch.forEach((item, index) => {
      if (checks[index]) verified.push(toVideo(item, tmdbType));
    });
  }
  return verified.slice(0, 30);
}

app.get("/health", (_req, res) => json(res, {
  status: "ok",
  addon: "OTT Universe India",
  tokenConfigured: Boolean(token)
}));

// Diagnostic endpoint: shows the exact provider names TMDB returns for India.
app.get("/debug/providers/:type", async (req, res) => {
  try {
    const type = req.params.type === "series" ? "tv" : req.params.type;
    if (!["movie", "tv"].includes(type)) return json(res, { providers: [] });
    const providers = await getProviders(type);
    json(res, {
      region: "IN",
      type,
      providers: providers
        .filter(p => PLATFORMS.some(platform => platform.match.test(p.provider_name || "")) || /apple tv/i.test(p.provider_name || ""))
        .map(p => ({ provider_id: p.provider_id, provider_name: p.provider_name }))
    });
  } catch (err) {
    console.error(err);
    res.status(502);
    json(res, { providers: [], error: err.message });
  }
});
// Diagnostic endpoint: checks whether TMDB returns Rent/Buy titles.
app.get("/debug/catalog/:platform/:type/:row", async (req, res) => {
  try {
    const platform = PLATFORMS.find(p => p.id === req.params.platform);
    const type = req.params.type;
    const row = ROWS.find(r => r.id === req.params.row);
    const tmdbType = type === "series" ? "tv" : "movie";

    if (!platform || !row || !["movie", "series"].includes(type)) {
      return json(res, { error: "Invalid platform, type, or row" });
    }

    const pid = await providerId(platform, tmdbType);
    if (!pid) {
      return json(res, {
        error: "Provider not found",
        platform: platform.name
      });
    }

    const data = await tmdb(`/discover/${tmdbType}`, {
      watch_region: "IN",
      with_watch_providers: pid,
      with_watch_monetization_types: row.monetization,
      sort_by: row.sort,
      page: 1,
      language: "en-US"
    });

    const candidates = data.results || [];
    const sample = candidates.slice(0, 5);

    const providerDetails = await Promise.all(
  sample.map(async item => {
    const details = await tmdb(
      `/${tmdbType}/${item.id}/watch/providers`
    );

    const india = details.results && details.results.IN
      ? details.results.IN
      : {};

    const getNames = key => (india[key] || []).map(p => ({
      id: p.provider_id,
      name: p.provider_name
    }));

    return {
      title: item.title || item.name,
      rent: getNames("rent"),
      buy: getNames("buy"),
      flatrate: getNames("flatrate")
    };
  })
);
    return json(res, {
      platform: platform.name,
      providerId: pid,
      region: "IN",
      type,
      row: row.id,
      monetization: row.monetization,
      discoverCandidateCount: candidates.length,
      sampleTitles: providerDetails
    });
  } catch (err) {
    console.error(err);
    return json(res, { error: err.message });
  }
});

app.get("/manifest.json", (_req, res) => {
  const catalogs = [];

  for (const platform of PLATFORMS) {
    for (const type of ["movie", "series"]) {
      const tmdbType = type === "series" ? "tv" : "movie";

      const platformRows = ["prime", "appletv"].includes(platform.id)
        ? ROWS.filter(row => !["rent", "buy"].includes(row.id))
        : ROWS;

      for (const row of platformRows) {
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
    version: "1.2.0",
    name: "OTT Universe India",
    description: "India OTT discovery. Availability data powered by JustWatch via TMDB; verify on the service before subscribing or renting.",
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
    const row = ROWS.find(r => id.endsWith(`_${r.id}`));
    const tmdbType = type === "series" ? "tv" : "movie";
    if (!platform || !row || !["movie", "series"].includes(type)) return json(res, { metas: [] });
    const metas = await catalog(platform, tmdbType, row);
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
    if (!/^[0-9]+$/.test(id)) return json(res, { meta: null });
    const item = await tmdb(`/${type}/${id}`, { language: "en-US" });
    const video = toVideo(item, type);
    const genres = (item.genres || []).map(g => g.name);
    const meta = {
      ...video,
      genres,
      runtime: type === "movie" && item.runtime ? `${item.runtime} min` : undefined,
      country: (item.production_countries || []).map(c => c.name).join(", ") || undefined
    };
    json(res, { meta });
  } catch (err) {
    console.error(err);
    res.status(502);
    json(res, { meta: null, error: err.message });
  }
});

app.listen(PORT, () => console.log(`OTT Universe India listening on ${PORT}`));
