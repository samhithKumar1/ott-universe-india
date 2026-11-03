
const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;

const TMDB_BASE = "https://api.themoviedb.org/3";
const IMAGE_BASE = "https://image.tmdb.org/t/p";

const TMDB_TOKEN =
  process.env.TMDB_READ_ACCESS_TOKEN || process.env.TMDB_API_KEY || "";

const OMDB_API_KEY = process.env.OMDB_API_KEY || "";

const VERSION = "1.5.0";

// Supported OTT platforms in India.
const PLATFORMS = [
  { id: "netflix", name: "Netflix", match: /netflix/i },
  { id: "prime", name: "Prime Video", match: /amazon prime video|prime video/i },
  { id: "hotstar", name: "JioHotstar", match: /jiohotstar|disney\+ hotstar|hotstar/i },
  { id: "zee5", name: "ZEE5", match: /zee5/i },
  { id: "sonyliv", name: "Sony LIV", match: /sony liv/i },
  { id: "aha", name: "Aha", match: /^aha$/i },
  { id: "appletv", name: "Apple TV+", match: /^apple tv\+?$/i }
];

const ROWS = [
  { id: "popular", name: "Popular", monetization: "flatrate", sort: "popularity.desc" },
  { id: "rated", name: "Highest Rated", monetization: "flatrate", sort: "vote_average.desc" },
  { id: "trending", name: "Trending", monetization: "flatrate", sort: "popularity.desc" },
  { id: "new", name: "Recently Released", monetization: "flatrate", sort: "primary_release_date.desc" },
  { id: "rent", name: "Rent", monetization: "rent", sort: "popularity.desc" },
  { id: "buy", name: "Buy", monetization: "buy", sort: "popularity.desc" }
];

const CACHE_TTL = 60 * 60 * 1000;
const cache = new Map();

// --------------------------------------------------
// CACHE AND HTTP HELPERS
// --------------------------------------------------

function cached(key, loader, ttl = CACHE_TTL) {
  const existing = cache.get(key);

  if (existing && existing.expiresAt > Date.now()) {
    return existing.promise;
  }

  const promise = Promise.resolve()
    .then(loader)
    .catch(error => {
      cache.delete(key);
      throw error;
    });

  cache.set(key, {
    promise,
    expiresAt: Date.now() + ttl
  });

  return promise;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.text();

  let data;

  try {
    data = body ? JSON.parse(body) : {};
  } catch {
    throw new Error(`Invalid JSON response (${response.status})`);
  }

  if (!response.ok) {
    throw new Error(
      data.status_message ||
      data.Error ||
      `Request failed: ${response.status}`
    );
  }

  return data;
}

async function tmdb(path, params = {}) {
  if (!TMDB_TOKEN) {
    throw new Error("TMDB token is not configured.");
  }

  const url = new URL(`${TMDB_BASE}${path}`);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  return cached(`tmdb:${url.toString()}`, () =>
    requestJson(url.toString(), {
      headers: {
        Authorization: `Bearer ${TMDB_TOKEN}`,
        accept: "application/json"
      }
    })
  );
}

async function optionalTmdb(path, params = {}) {
  try {
    return await tmdb(path, params);
  } catch (error) {
    console.error(`Optional TMDB request failed (${path}):`, error.message);
    return null;
  }
}

async function omdbByImdbId(imdbId) {
  if (!OMDB_API_KEY || !imdbId) {
    return null;
  }

  const url = new URL("https://www.omdbapi.com/");
  url.searchParams.set("apikey", OMDB_API_KEY);
  url.searchParams.set("i", imdbId);

  return cached(`omdb:${imdbId}`, async () => {
    const data = await requestJson(url.toString());

    if (data.Response === "False") {
      return null;
    }

    return data;
  }).catch(error => {
    console.error("OMDb error:", error.message);
    return null;
  });
}

function imageUrl(path, size = "w500") {
  return path ? `${IMAGE_BASE}/${size}${path}` : null;
}

function validValue(value) {
  return value && value !== "N/A" ? value : null;
}

// --------------------------------------------------
// BASIC VIDEO METADATA
// --------------------------------------------------

function toVideo(item, tmdbType) {
  const isMovie = tmdbType === "movie";
  const date = isMovie ? item.release_date : item.first_air_date;

  return {
    id: `tmdb:${item.id}`,
    type: isMovie ? "movie" : "series",
    name: (isMovie ? item.title : item.name) || "Untitled",
    poster: imageUrl(item.poster_path),
    background: imageUrl(item.backdrop_path, "w1280"),
    description: item.overview || "",
    releaseInfo: date ? date.slice(0, 4) : "",
    tmdbRating:
      typeof item.vote_average === "number"
        ? Number(item.vote_average.toFixed(1))
        : null,
    tmdbVotes:
      typeof item.vote_count === "number" ? item.vote_count : null
  };
}

// --------------------------------------------------
// OTT PROVIDER INFORMATION
// --------------------------------------------------

async function providerId(platform, tmdbType) {
  const data = await tmdb(`/watch/providers/${tmdbType}`, {
    watch_region: "IN",
    language: "en-US"
  });

  const match = (data.results || []).find(provider =>
    platform.match.test(provider.provider_name || "")
  );

  return match ? match.provider_id : null;
}

async function hasProviderAccess(platform, tmdbType, itemId, monetization) {
  const pid = await providerId(platform, tmdbType);

  if (!pid) return false;

  const details = await tmdb(`/${tmdbType}/${itemId}/watch/providers`);
  const offers = details.results?.IN?.[monetization] || [];

  return offers.some(provider => provider.provider_id === pid);
}

// --------------------------------------------------
// IMDb ENRICHMENT
// --------------------------------------------------

async function getImdbExtras(tmdbType, itemId) {
  try {
    const externalIds = await tmdb(`/${tmdbType}/${itemId}/external_ids`);
    const imdbId = externalIds.imdb_id;

    if (!imdbId) return {};

    const result = {
      imdb_id: imdbId,
      imdbUrl: `https://www.imdb.com/title/${imdbId}/`,
      links: [{
        name: "IMDb",
        category: "imdb",
        url: `https://www.imdb.com/title/${imdbId}/`
      }]
    };

    const imdbData = await omdbByImdbId(imdbId);

    if (imdbData) {
      result.imdbRating = validValue(imdbData.imdbRating);
      result.imdbVotes = validValue(imdbData.imdbVotes);
    }

    return result;
  } catch (error) {
    console.error("IMDb enrichment error:", error.message);
    return {};
  }
}

// --------------------------------------------------
// CAST, DIRECTORS, WRITERS AND CREW
// --------------------------------------------------

async function getCreditInformation(tmdbType, itemId) {
  const credits = await optionalTmdb(`/${tmdbType}/${itemId}/credits`);

  if (!credits) {
    return {
      cast: [],
      castDetails: [],
      director: [],
      writers: [],
      creators: [],
      executiveProducers: [],
      crewDetails: []
    };
  }

  const castDetails = (credits.cast || [])
    .slice(0, 15)
    .map(person => ({
      name: person.name,
      character: person.character || "",
      order: person.order,
      profile: imageUrl(person.profile_path)
    }));

  const crew = credits.crew || [];

  const directors = crew
    .filter(person => person.job === "Director")
    .map(person => person.name);

  const writers = crew
    .filter(person =>
      ["Writer", "Screenplay", "Story", "Teleplay"].includes(person.job)
    )
    .map(person => person.name);

  const selectedCrew = crew
    .filter(person =>
      [
        "Director",
        "Writer",
        "Screenplay",
        "Story",
        "Teleplay",
        "Executive Producer",
        "Producer",
        "Director of Photography",
        "Original Music Composer"
      ].includes(person.job)
    )
    .slice(0, 30)
    .map(person => ({
      name: person.name,
      job: person.job,
      department: person.department,
      profile: imageUrl(person.profile_path)
    }));

  return {
    cast: castDetails.map(person => person.name),
    castDetails,
    director: [...new Set(directors)],
    writers: [...new Set(writers)],
    creators: [],
    executiveProducers: [
      ...new Set(
        crew
          .filter(person => person.job === "Executive Producer")
          .map(person => person.name)
      )
    ],
    crewDetails: selectedCrew
  };
}

// --------------------------------------------------
// CERTIFICATION: INDIA FIRST, US FALLBACK
// --------------------------------------------------

async function getCertification(tmdbType, itemId) {
  const endpoint = tmdbType === "movie"
    ? `/movie/${itemId}/release_dates`
    : `/tv/${itemId}/content_ratings`;

  const data = await optionalTmdb(endpoint);

  if (!data) {
    return {
      certification: null,
      certificationCountry: null
    };
  }

  const results = data.results || [];

  function findCertification(countryCode) {
    const country = results.find(
      item => item.iso_3166_1 === countryCode
    );

    if (!country) return null;

    if (tmdbType === "tv") {
      const rating = String(country.rating || "").trim();

      return rating
        ? {
            certification: rating,
            certificationCountry: countryCode
          }
        : null;
    }

    const dates = (country.release_dates || [])
      .filter(item => String(item.certification || "").trim());

    const priority = {
      3: 1,
      4: 2,
      2: 3,
      1: 4,
      5: 5,
      6: 6
    };

    dates.sort((a, b) => {
      const priorityDifference =
        (priority[a.type] || 99) - (priority[b.type] || 99);

      if (priorityDifference !== 0) {
        return priorityDifference;
      }

      return String(b.release_date || "").localeCompare(
        String(a.release_date || "")
      );
    });

    const selected = dates[0];

    if (!selected) return null;

    return {
      certification: String(selected.certification).trim(),
      certificationCountry: countryCode
    };
  }

  const india = findCertification("IN");

  if (india) return india;

  const usa = findCertification("US");

  if (usa) return usa;

  return {
    certification: null,
    certificationCountry: null
  };
}

// --------------------------------------------------
// TV EPISODE RUNTIME FALLBACK
// --------------------------------------------------

async function getSeriesEpisodeRuntime(details, tmdbId) {
  const direct = (details.episode_run_time || [])
    .filter(value => Number.isFinite(value) && value > 0);

  if (direct.length) {
    const minutes = Math.round(
      direct.reduce((sum, value) => sum + value, 0) / direct.length
    );

    return {
      episodeRuntime: `${minutes} min`,
      episodeRuntimeMinutes: minutes,
      episodeRuntimeSource: "series"
    };
  }

  const seasonNumbers = (details.seasons || [])
    .map(season => season.season_number)
    .filter(number => Number.isInteger(number) && number > 0)
    .sort((a, b) => b - a);

  const seasonsToCheck = [
    ...new Set([
      seasonNumbers[0],
      1
    ].filter(number => Number.isInteger(number)))
  ];

  for (const seasonNumber of seasonsToCheck) {
    const season = await optionalTmdb(
      `/tv/${tmdbId}/season/${seasonNumber}`
    );

    if (!season) continue;

    const runtimes = (season.episodes || [])
      .map(episode => episode.runtime)
      .filter(value =>
        Number.isFinite(value) && value > 0
      );

    if (!runtimes.length) continue;

    const sorted = [...runtimes].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    const median = sorted.length % 2
      ? sorted[middle]
      : Math.round((sorted[middle - 1] + sorted[middle]) / 2);

    return {
      episodeRuntime: `${median} min`,
      episodeRuntimeMinutes: median,
      episodeRuntimeSource: `season ${seasonNumber}`
    };
  }

  return {
    episodeRuntime: null,
    episodeRuntimeMinutes: null,
    episodeRuntimeSource: null
  };
}

// --------------------------------------------------
// TRAILERS, TEASERS AND OTHER VIDEOS
// --------------------------------------------------

function getTrailerInformation(details) {
  const videos = (details.videos?.results || [])
    .filter(video => video.site === "YouTube" && video.key);

  function classifyVideo(video) {
    const name = String(video.name || "").toLowerCase();
    const originalType = String(video.type || "");

    if (originalType === "Trailer" || originalType === "Teaser") {
      return originalType;
    }

    if (
      originalType === "Opening Credits" ||
      /opening credits|title sequence|theme song|opening title/.test(name)
    ) {
      return "Opening Credits";
    }

    if (
      originalType === "Behind the Scenes" ||
      /behind.the.scenes|making.of|production diary|on the set/.test(name)
    ) {
      return "Behind the Scenes";
    }

    if (
      originalType === "Clip" ||
      /\bclip\b|\bscene\b|sneak peek|extended preview|movie preview/.test(name)
    ) {
      return "Clip";
    }

    if (originalType === "Featurette") {
      return "Featurette";
    }

    return originalType || "Other";
  }

  const formatted = videos.map(video => ({
    name: video.name,
    site: video.site,
    key: video.key,
    type: classifyVideo(video),
    official: Boolean(video.official),
    url: `https://www.youtube.com/watch?v=${video.key}`
  }));

  const priority = {
    Trailer: 1,
    Teaser: 2,
    Clip: 3,
    Featurette: 4,
    "Behind the Scenes": 5,
    "Opening Credits": 6,
    Other: 7
  };

  formatted.sort((a, b) => {
    if (a.official !== b.official) {
      return a.official ? -1 : 1;
    }

    return (priority[a.type] || 99) -
      (priority[b.type] || 99);
  });

  const trailers = formatted.filter(v => v.type === "Trailer");
  const teasers = formatted.filter(v => v.type === "Teaser");
  const clips = formatted.filter(v => v.type === "Clip");
  const featurettes = formatted.filter(v => v.type === "Featurette");
  const behindScenes = formatted.filter(v => v.type === "Behind the Scenes");
  const openingCredits = formatted.filter(v => v.type === "Opening Credits");
  const others = formatted.filter(v => v.type === "Other");

  const chosen = trailers[0] || teasers[0] || null;

  const makeLinks = list => list.map(video => ({
    name: video.name,
    category: video.type,
    url: video.url
  }));

  return {
    trailerUrl: chosen?.url || null,
    trailer: chosen,
    trailers: formatted,
    trailerLinks: makeLinks(trailers),
    teaserLinks: makeLinks(teasers),
    clipLinks: makeLinks(clips),
    featuretteLinks: makeLinks(featurettes),
    behindTheScenesLinks: makeLinks(behindScenes),
    openingCreditsLinks: makeLinks(openingCredits),
    otherVideoLinks: makeLinks(others)
  };
}

// --------------------------------------------------
// CATALOGUE GENERATION
// --------------------------------------------------

async function catalog(platform, tmdbType, row) {
  const pid = await providerId(platform, tmdbType);

  if (!pid) return [];

  let data;

  if (row.id === "trending") {
    data = await tmdb(`/trending/${tmdbType}/week`, {
      language: "en-US"
    });
  } else {
    const params = {
      watch_region: "IN",
      with_watch_providers: pid,
      with_watch_monetization_types: row.monetization,
      sort_by: row.sort,
      page: 1,
      language: "en-US"
    };

    if (row.id === "rated") {
      params["vote_count.gte"] = 100;
    }

    if (row.id === "new") {
      const today = new Date();
      const past = new Date();
      past.setMonth(past.getMonth() - 18);

      const todayString = today.toISOString().slice(0, 10);
      const pastString = past.toISOString().slice(0, 10);

      if (tmdbType === "movie") {
        params["primary_release_date.gte"] = pastString;
        params["primary_release_date.lte"] = todayString;
      } else {
        params["first_air_date.gte"] = pastString;
        params["first_air_date.lte"] = todayString;
        params.sort_by = "first_air_date.desc";
      }
    }

    data = await tmdb(`/discover/${tmdbType}`, params);
  }

  const candidates = (data.results || []).slice(0, 30);
  const verified = [];

  for (let i = 0; i < candidates.length; i += 5) {
    const batch = candidates.slice(i, i + 5);

    const checks = await Promise.all(
      batch.map(item =>
        hasProviderAccess(platform, tmdbType, item.id, row.monetization)
          .catch(error => {
            console.error(
              `Availability check failed for ${item.id}:`,
              error.message
            );
            return false;
          })
      )
    );

    batch.forEach((item, index) => {
      if (checks[index]) {
        verified.push(toVideo(item, tmdbType));
      }
    });
  }

  const results = verified.slice(0, 20);

  if (OMDB_API_KEY) {
    for (let i = 0; i < results.length; i += 5) {
      const batch = results.slice(i, i + 5);

      const extras = await Promise.all(
        batch.map(item =>
          getImdbExtras(
            tmdbType,
            item.id.replace("tmdb:", "")
          )
        )
      );

      batch.forEach((item, index) => {
        Object.assign(item, extras[index]);
      });
    }
  }

  return results;
}

// --------------------------------------------------
// CATALOGUE ID LOOKUP
// --------------------------------------------------

function getPlatformAndRow(catalogId) {
  for (const platform of PLATFORMS) {
    for (const row of ROWS) {
      if (
        ["prime", "appletv"].includes(platform.id) &&
        ["rent", "buy"].includes(row.id)
      ) {
        continue;
      }

      for (const type of ["movie", "tv"]) {
        if (catalogId === `${platform.id}_${type}_${row.id}`) {
          return { platform, row, type };
        }
      }
    }
  }

  return null;
}

// --------------------------------------------------
// HOME AND HEALTH
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    addon: "OTT Universe India",
    version: VERSION,
    manifest: "/manifest.json"
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    addon: "OTT Universe India",
    version: VERSION,
    tokenConfigured: Boolean(TMDB_TOKEN),
    imdbRatingsConfigured: Boolean(OMDB_API_KEY)
  });
});

// --------------------------------------------------
// DEBUG: PROVIDERS
// --------------------------------------------------

app.get("/debug/providers/:type", async (req, res) => {
  try {
    const type = req.params.type === "series"
      ? "tv"
      : req.params.type;

    if (!["movie", "tv"].includes(type)) {
      return res.status(400).json({
        error: "Type must be movie or series."
      });
    }

    const data = await tmdb(`/watch/providers/${type}`, {
      watch_region: "IN",
      language: "en-US"
    });

    res.json({
      region: "IN",
      type,
      providers: (data.results || []).map(provider => ({
        id: provider.provider_id,
        name: provider.provider_name
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --------------------------------------------------
// DEBUG: CATALOGUE
// --------------------------------------------------

app.get("/debug/catalog/:platform/:type/:row", async (req, res) => {
  try {
    const platform = PLATFORMS.find(
      item => item.id === req.params.platform
    );

    const type = req.params.type === "series"
      ? "tv"
      : req.params.type;

    const row = ROWS.find(
      item => item.id === req.params.row
    );

    if (!platform || !row || !["movie", "tv"].includes(type)) {
      return res.status(400).json({
        error: "Unknown platform, type or row."
      });
    }

    if (
      ["prime", "appletv"].includes(platform.id) &&
      ["rent", "buy"].includes(row.id)
    ) {
      return res.status(400).json({
        error: "Rent and Buy are disabled for this platform."
      });
    }

    const pid = await providerId(platform, type);
    const metas = await catalog(platform, type, row);

    res.js
