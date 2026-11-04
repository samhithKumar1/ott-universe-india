const express = require("express");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const VERSION = "2.1.0";
const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

const PROVIDERS = [
  { id: "netflix", name: "Netflix", aliases: ["Netflix"] },
  { id: "prime_video", name: "Prime Video", aliases: ["Amazon Prime Video", "Prime Video"] },
  { id: "jiohotstar", name: "JioHotstar", aliases: ["JioHotstar", "Hotstar"] },
  { id: "zee5", name: "ZEE5", aliases: ["ZEE5"] },
  { id: "sony_liv", name: "Sony LIV", aliases: ["Sony LIV", "SonyLIV"] },
  { id: "aha", name: "Aha", aliases: ["aha", "Aha Video"] },
  { id: "apple_tv_plus", name: "Apple TV+", aliases: ["Apple TV+", "Apple TV Plus"] },
  { id: "lionsgate_play", name: "Lionsgate Play", aliases: ["Lionsgate Play"] }
];

const cache = new Map();
const CACHE_TTL = {
  providers: 12 * 60 * 60 * 1000,
  catalog: 20 * 60 * 1000,
  meta: 6 * 60 * 60 * 1000,
  omdb: 24 * 60 * 60 * 1000
};

function cacheGet(key) {
  const item = cache.get(key);
  if (!item || item.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

function cacheSet(key, value, ttl) {
  cache.set(key, { value, expiresAt: Date.now() + ttl });
  return value;
}

function normalizeName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getAuthConfig() {
  // TMDB v4 Read Access Token is sent as a Bearer token.
  if (process.env.TMDB_READ_ACCESS_TOKEN) {
    return {
      mode: "v4_bearer",
      headers: { Authorization: `Bearer ${process.env.TMDB_READ_ACCESS_TOKEN}` }
    };
  }

  // TMDB v3 API Key is sent as the api_key query parameter, not as a Bearer token.
  if (process.env.TMDB_API_KEY) {
    return {
      mode: "v3_api_key",
      query: { api_key: process.env.TMDB_API_KEY },
      headers: {}
    };
  }

  return { mode: "missing", headers: {} };
}

async function tmdb(path, params = {}) {
  const auth = getAuthConfig();
  if (auth.mode === "missing") {
    const error = new Error("TMDB credential is not configured in Render.");
    error.status = 503;
    throw error;
  }

  const url = new URL(`${TMDB_BASE}${path}`);
  for (const [key, value] of Object.entries({ ...auth.query, ...params })) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...auth.headers
    }
  });

  let data;
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (!response.ok) {
    const error = new Error(
      data.status_message || `TMDB request failed with HTTP ${response.status}`
    );
    error.status = response.status;
    error.tmdbCode = data.status_code || null;
    throw error;
  }

  return data;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function daysFromNow(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

function daysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return isoDate(date);
}

function imageUrl(path, size = "w500") {
  return path ? `${TMDB_IMAGE_BASE}/${size}${path}` : null;
}

function getCatalogDefinitions() {
  const definitions = [];

  for (const provider of PROVIDERS) {
    for (const type of ["movie", "series"]) {
      const typeLabel = type === "movie" ? "Movies" : "Series";
      definitions.push({
        type,
        id: `${provider.id}_${type}_popular`,
        name: `${provider.name} • ${typeLabel} • Popular in India`,
        providerId: provider.id,
        row: "popular"
      });
      definitions.push({
        type,
        id: `${provider.id}_${type}_recent`,
        name: `${provider.name} • ${typeLabel} • Recent Releases`,
        providerId: provider.id,
        row: "recent"
      });
      definitions.push({
        type,
        id: `${provider.id}_${type}_highest`,
        name: `${provider.name} • ${typeLabel} • Highest Rated`,
        providerId: provider.id,
        row: "highest"
      });
    }
  }

  definitions.push({
    type: "movie",
    id: "india_upcoming_movies",
    name: "India • Upcoming Movies (OTT not confirmed)",
    row: "upcoming"
  });
  definitions.push({
    type: "series",
    id: "india_upcoming_series",
    name: "India • Upcoming Series (OTT not confirmed)",
    row: "upcoming"
  });

  return definitions;
}

const CATALOG_DEFINITIONS = getCatalogDefinitions();

const manifest = {
  id: "com.ottuniverse.india",
  version: VERSION,
  name: "OTT Universe India",
  description:
    "India-focused OTT discovery catalogues using TMDB India watch-provider data. Discovery only; this add-on does not provide video streams.",
  resources: ["catalog", "meta"],
  types: ["movie", "series"],
  idPrefixes: ["tmdb:"],
  catalogs: CATALOG_DEFINITIONS.map((item) => ({
    type: item.type,
    id: item.id,
    name: item.name,
    extra: [{ name: "skip", isRequired: false }]
  }))
};

async function getProviderMatches(mediaType) {
  const key = `providers:${mediaType}`;
  const cachedValue = cacheGet(key);
  if (cachedValue) return cachedValue;

  const data = await tmdb(`/watch/providers/${mediaType}`, { watch_region: "IN" });
  const results = Array.isArray(data.results) ? data.results : [];

  const matches = PROVIDERS.map((provider) => {
    const aliases = provider.aliases.map(normalizeName);
    const found = results.find((item) =>
      aliases.includes(normalizeName(item.provider_name))
    );

    return {
      id: provider.id,
      name: provider.name,
      providerId: found ? found.provider_id : null,
      logo: found ? imageUrl(found.logo_path, "w92") : null,
      matchedName: found ? found.provider_name : null
    };
  });

  return cacheSet(key, matches, CACHE_TTL.providers);
}

function toMetaPreview(item, type) {
  const name = type === "movie" ? item.title : item.name;
  const date = type === "movie" ? item.release_date : item.first_air_date;
  return {
    id: `tmdb:${item.id}`,
    type,
    name: name || "Untitled",
    poster: imageUrl(item.poster_path, "w500"),
    background: imageUrl(item.backdrop_path, "w1280"),
    description: item.overview || "",
    releaseInfo: date ? date.slice(0, 4) : undefined
  };
}

function buildDiscoverParams(definition, page) {
  const today = isoDate(new Date());
  const params = {
  page,
  watch_region: "IN"
};

if (definition.type === "movie") {
  params.include_adult = "false";
}
  if (definition.row === "popular") {
    params.sort_by = "popularity.desc";
  } else if (definition.row === "highest") {
    params.sort_by = "vote_average.desc";
    params["vote_average.gte"] = "6.5";
    params["vote_count.gte"] = "50";
  } else if (definition.row === "recent") {
    params.sort_by =
      definition.type === "movie"
        ? "primary_release_date.desc"
        : "first_air_date.desc";
    if (definition.type === "movie") {
      params["primary_release_date.gte"] = daysAgo(180);
      params["primary_release_date.lte"] = today;
    } else {
      params["first_air_date.gte"] = daysAgo(180);
      params["first_air_date.lte"] = today;
    }
  } else if (definition.row === "upcoming") {
    params.watch_region = undefined;
    params.region = "IN";
    params.sort_by =
      definition.type === "movie"
        ? "primary_release_date.asc"
        : "first_air_date.asc";
    if (definition.type === "movie") {
      params["primary_release_date.gte"] = today;
      params["primary_release_date.lte"] = daysFromNow(365);
    } else {
      params["first_air_date.gte"] = today;
      params["first_air_date.lte"] = daysFromNow(365);
    }
  }

  return params;
}

async function getCatalog(type, catalogId, extraString) {
  const definition = CATALOG_DEFINITIONS.find(
    (item) => item.type === type && item.id === catalogId
  );
  if (!definition) return { metas: [] };

  const extra = new URLSearchParams(extraString || "");
  const skip = Math.max(0, Number(extra.get("skip") || 0));
  const page = Math.floor(skip / 20) + 1;
  const cacheKey = `catalog:${catalogId}:${page}`;
  const cachedValue = cacheGet(cacheKey);
  if (cachedValue) return cachedValue;

  const params = buildDiscoverParams(definition, page);

  if (definition.providerId) {
    const providerMediaType = type === "series" ? "tv" : "movie";
const matches = await getProviderMatches(providerMediaType);
    const provider = matches.find((item) => item.id === definition.providerId);
    if (!provider || !provider.providerId) {
      return { metas: [] };
    }
    params.with_watch_providers = provider.providerId;
  }

  const endpoint = type === "movie" ? "/discover/movie" : "/discover/tv";
  const data = await tmdb(endpoint, params);
  const metas = (data.results || [])
    .filter((item) => item.poster_path)
    .map((item) => toMetaPreview(item, type));

  return cacheSet(cacheKey, { metas }, CACHE_TTL.catalog);
}

function getIndiaProviderGroups(providerData) {
  const india = providerData && providerData.results ? providerData.results.IN : null;
  if (!india) return { lines: ["No India provider listing was returned by TMDB."], link: null };

  const categories = [
    ["flatrate", "Subscription"],
    ["rent", "Rent"],
    ["buy", "Buy"],
    ["free", "Free"],
    ["ads", "Ad-supported"]
  ];

  const lines = [];
  for (const [key, label] of categories) {
    const providers = Array.isArray(india[key]) ? india[key] : [];
    for (const provider of providers) {
      lines.push(`${provider.provider_name} — ${label}`);
    }
  }

  return {
    lines: lines.length ? lines : ["No India watch options listed by TMDB."],
    link: india.link || null
  };
}

async function getOmdbRatings(imdbId) {
  const apiKey = process.env.OMDB_API_KEY;
  if (!apiKey || !imdbId) return null;

  const key = `omdb:${imdbId}`;
  const cachedValue = cacheGet(key);
  if (cachedValue) return cachedValue;

  const url = new URL("https://www.omdbapi.com/");
  url.searchParams.set("i", imdbId);
  url.searchParams.set("apikey", apiKey);

  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok || data.Response !== "True") return null;

  const ratings = Array.isArray(data.Ratings) ? data.Ratings : [];
  const rt = ratings.find((rating) => rating.Source === "Rotten Tomatoes");

  const result = {
    imdbRating:
      data.imdbRating && data.imdbRating !== "N/A" ? data.imdbRating : null,
    rottenTomatoes:
      rt && rt.Value && rt.Value !== "N/A" ? rt.Value : null,
    awards: data.Awards && data.Awards !== "N/A" ? data.Awards : null
  };

  return cacheSet(key, result, CACHE_TTL.omdb);
}

function getCertification(type, detail, extra) {
  if (type === "movie") {
    const results = extra && extra.results ? extra.results : [];
    const india = results.find((item) => item.iso_3166_1 === "IN");
    if (!india || !Array.isArray(india.release_dates)) return null;
    const release = india.release_dates.find((item) => item.certification);
    return release ? release.certification : null;
  }

  const results = extra && extra.results ? extra.results : [];
  const india = results.find((item) => item.iso_3166_1 === "IN");
  return india && india.rating ? india.rating : null;
}

async function getMeta(type, rawId) {
  const id = String(rawId || "").replace(/^tmdb:/, "");
  if (!/^\d+$/.test(id)) return null;

  const cacheKey = `meta:${type}:${id}`;
  const cachedValue = cacheGet(cacheKey);
  if (cachedValue) return cachedValue;

  const isMovie = type === "movie";
  const tmdbType = isMovie ? "movie" : "tv";
  const detailPath = `/${tmdbType}/${id}`;

  const requests = [
    tmdb(detailPath),
    tmdb(`${detailPath}/${isMovie ? "credits" : "aggregate_credits"}`),
    tmdb(`${detailPath}/external_ids`),
    tmdb(`${detailPath}/videos`),
    tmdb(`${detailPath}/watch/providers`),
    tmdb(
      `${detailPath}/${isMovie ? "release_dates" : "content_ratings"}`
    )
  ];

  const [detail, credits, externalIds, videos, watchProviders, certifications] =
    await Promise.all(requests);

  const imdbId = externalIds && externalIds.imdb_id ? externalIds.imdb_id : null;
  const omdb = await getOmdbRatings(imdbId);

  const cast = (credits.cast || [])
    .slice(0, 12)
    .map((person) => person.name)
    .filter(Boolean);

  let director = [];
  if (isMovie) {
    director = (credits.crew || [])
      .filter((person) => person.job === "Director")
      .map((person) => person.name);
  } else {
    director = (detail.created_by || []).map((person) => person.name);
  }

  const title = isMovie ? detail.title : detail.name;
  const date = isMovie ? detail.release_date : detail.first_air_date;
  const year = date ? date.slice(0, 4) : "";
  const spokenLanguages = (detail.spoken_languages || [])
    .map((language) => language.english_name || language.name)
    .filter(Boolean);
  const genres = (detail.genres || []).map((genre) => genre.name);
  const providerInfo = getIndiaProviderGroups(watchProviders);
  const certification = getCertification(type, detail, certifications);

  const descriptionParts = [];
  if (detail.overview) descriptionParts.push(detail.overview);
  descriptionParts.push("");
  descriptionParts.push(`TMDB rating: ${detail.vote_average ?? "Unavailable"}/10 (${detail.vote_count || 0} votes).`);
  if (omdb && omdb.imdbRating) descriptionParts.push(`IMDb rating: ${omdb.imdbRating}/10.`);
  if (omdb && omdb.rottenTomatoes) descriptionParts.push(`Rotten Tomatoes: ${omdb.rottenTomatoes}.`);
  if (year) descriptionParts.push(`Release year: ${year}.`);
  if (certification) descriptionParts.push(`India certification listed by TMDB: ${certification}.`);
  if (genres.length) descriptionParts.push(`Genres: ${genres.join(", ")}.`);
  if (spokenLanguages.length) {
    descriptionParts.push(`TMDB-reported spoken languages: ${spokenLanguages.join(", ")}.`);
  }
  if (director.length) descriptionParts.push(`${isMovie ? "Director" : "Created by"}: ${director.join(", ")}.`);
  if (cast.length) descriptionParts.push(`Cast: ${cast.join(", ")}.`);
  if (isMovie && detail.runtime) descriptionParts.push(`Runtime: ${detail.runtime} minutes.`);
  if (!isMovie) {
    descriptionParts.push(
      `Seasons: ${detail.number_of_seasons || "Unavailable"}; episodes: ${detail.number_of_episodes || "Unavailable"}.`
    );
  }
  descriptionParts.push("");
  descriptionParts.push("India watch availability (TMDB / JustWatch data):");
  for (const line of providerInfo.lines) descriptionParts.push(`• ${line}`);
  descriptionParts.push("Audio-dub and subtitle availability is not verified by this data source.");

  if (omdb && omdb.awards) descriptionParts.push(`Awards: ${omdb.awards}.`);

  const links = [];
  if (providerInfo.link) {
    links.push({
      name: "Where to watch in India (JustWatch)",
      category: "Watch",
      url: providerInfo.link
    });
  }

  const trailer = (videos.results || []).find(
    (video) =>
      video.site === "YouTube" &&
      video.type === "Trailer" &&
      video.official === true
  );
  if (trailer && trailer.key) {
    links.push({
      name: "Official trailer",
      category: "Trailer",
      url: `https://www.youtube.com/watch?v=${trailer.key}`
    });
  }

  const meta = {
    id: `tmdb:${id}`,
    type,
    name: title || "Untitled",
    poster: imageUrl(detail.poster_path, "w500"),
    background: imageUrl(detail.backdrop_path, "w1280"),
    description: descriptionParts.join("\n"),
    releaseInfo: year || undefined,
    genres,
    cast,
    director,
    links
  };

  if (isMovie && detail.runtime) meta.runtime = `${detail.runtime} min`;
  if (omdb && omdb.imdbRating) meta.imdbRating = omdb.imdbRating;

  return cacheSet(cacheKey, { meta }, CACHE_TTL.meta);
}

// CORS is required so Stremio and compatible clients can call the add-on.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (_req, res) => {
  res.type("html").send(
    `<html><head><title>OTT Universe India</title></head><body style="font-family:Arial;background:#111;color:#eee;padding:32px"><h1>OTT Universe India</h1><p>India-focused OTT discovery add-on.</p><p><a style="color:#7db7ff" href="/manifest.json">Open manifest</a></p><p><a style="color:#7db7ff" href="/health">Health check</a></p><hr><h2>Credits</h2><p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p><p>India watch-provider data is powered by JustWatch.</p></body></html>`
  );
});

app.get("/health", (_req, res) => {
  const auth = getAuthConfig();
  res.json({
    status: "ok",
    addon: "OTT Universe India",
    version: VERSION,
    tmdbCredentialConfigured: auth.mode !== "missing",
    tmdbAuthMode: auth.mode,
    optionalOmdbConfigured: Boolean(process.env.OMDB_API_KEY)
  });
});

app.get("/diagnostics/tmdb", async (_req, res) => {
  const auth = getAuthConfig();
  try {
    await tmdb("/configuration");
    const providers = await getProviderMatches("movie");
    res.json({
      ok: true,
      tmdbAuthentication: "successful",
      authMode: auth.mode,
      matchedIndiaProviders: providers
        .filter((provider) => provider.providerId)
        .map((provider) => ({
          id: provider.id,
          name: provider.name,
          matchedName: provider.matchedName
        })),
      unmatchedIndiaProviders: providers
        .filter((provider) => !provider.providerId)
        .map((provider) => provider.name)
    });
  } catch (error) {
    res.json({
      ok: false,
      authMode: auth.mode,
      httpStatus: error.status || null,
      tmdbError: error.message || "Unknown TMDB error",
      note:
        error.status === 401
          ? "TMDB rejected the credential. Check the Render environment-variable name and whether its value is a v4 Read Access Token or a v3 API Key. Do not paste the secret into chat."
          : "Check the Render logs and TMDB API status."
    });
  }
});

app.get("/providers.json", async (_req, res) => {
  try {
    const [movieProviders, seriesProviders] = await Promise.all([
      getProviderMatches("movie"),
      getProviderMatches("tv")
    ]);
    res.json({
      region: "IN",
      source: "TMDB Watch Providers (powered by JustWatch)",
      providers: PROVIDERS.map((provider) => {
        const movie = movieProviders.find((item) => item.id === provider.id);
        const series = seriesProviders.find((item) => item.id === provider.id);
        return {
          id: provider.id,
          name: provider.name,
          movieProviderId: movie ? movie.providerId : null,
          seriesProviderId: series ? series.providerId : null,
          logo: (movie && movie.logo) || (series && series.logo) || null,
          availableForMovies: Boolean(movie && movie.providerId),
          availableForSeries: Boolean(series && series.providerId)
        };
      })
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || "Could not load provider list"
    });
  }
});

app.get("/manifest.json", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json(manifest);
});

app.get("/catalog/:type/:catalogId.json", async (req, res) => {
  try {
    if (!["movie", "series"].includes(req.params.type)) {
      return res.json({ metas: [] });
    }
    const result = await getCatalog(req.params.type, req.params.catalogId, "");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      metas: [],
      error: error.message || "Catalogue request failed"
    });
  }
});

app.get("/catalog/:type/:catalogId/:extra.json", async (req, res) => {
  try {
    if (!["movie", "series"].includes(req.params.type)) {
      return res.json({ metas: [] });
    }
    const result = await getCatalog(
      req.params.type,
      req.params.catalogId,
      req.params.extra
    );
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({
      metas: [],
      error: error.message || "Catalogue request failed"
    });
  }
});

app.get("/meta/:type/:id.json", async (req, res) => {
  try {
    if (!["movie", "series"].includes(req.params.type)) {
      return res.json({ meta: null });
    }
    const result = await getMeta(req.params.type, req.params.id);
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(result || { meta: null });
  } catch (error) {
    res.status(error.status || 500).json({
      meta: null,
      error: error.message || "Metadata request failed"
    });
  }
});

app.listen(PORT, () => {
  console.log(`OTT Universe India ${VERSION} listening on port ${PORT}`);
});
