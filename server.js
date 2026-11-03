
const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;

const TMDB_BASE = "https://api.themoviedb.org/3";
const IMAGE_BASE = "https://image.tmdb.org/t/p";

const TMDB_TOKEN =
  process.env.TMDB_READ_ACCESS_TOKEN || process.env.TMDB_API_KEY || "";

const OMDB_API_KEY = process.env.OMDB_API_KEY || "";

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

// Cast, directors, writers and production crew.
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

async function getCertification(tmdbType, itemId) {
  const endpoint = tmdbType === "movie"
    ? `/movie/${itemId}/release_dates`
    : `/tv/${itemId}/content_ratings`;

  const data = await optionalTmdb(endpoint);

  if (!data) return { certification: null, certificationCountry: null };

  const results = data.results || [];

  const india = results.find(item => item.iso_3166_1 === "IN");
  const usa = results.find(item => item.iso_3166_1 === "US");

  const selected = india || usa;

  if (!selected) {
    return { certification: null, certificationCountry: null };
  }

  let certification;

  if (tmdbType === "movie") {
    const dates = selected.release_dates || [];
    certification =
      dates.find(item => item.certification)?.certification || null;
  } else {
    certification = selected.rating || null;
  }

  return {
    certification,
    certificationCountry: certification
      ? selected.iso_3166_1
      : null
  };
}

// Separate videos into their actual TMDB categories.
function getTrailerInformation(details) {
  const videos = (details.videos?.results || [])
    .filter(video => video.site === "YouTube" && video.key)
    .sort((a, b) => {
      if (a.official !== b.official) return a.official ? -1 : 1;

      const priority = {
        Trailer: 1,
        Teaser: 2,
        Clip: 3,
        Featurette: 4
      };

      const typeDifference =
        (priority[a.type] || 5) - (priority[b.type] || 5);

      if (typeDifference !== 0) return typeDifference;

      return String(b.published_at || "").localeCompare(
        String(a.published_at || "")
      );
    });

  const formatted = videos.map(video => ({
    name: video.name,
    site: video.site,
    key: video.key,
    type: video.type,
    official: Boolean(video.official),
    url: `https://www.youtube.com/watch?v=${video.key}`
  }));

  const trailers = formatted.filter(video => video.type === "Trailer");
  const teasers = formatted.filter(video => video.type === "Teaser");
  const clips = formatted.filter(video => video.type === "Clip");
  const featurettes = formatted.filter(video => video.type === "Featurette");

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
    featuretteLinks: makeLinks(featurettes)
  };
}

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
            console.error(`Availability check failed for ${item.id}:`, error.message);
            return false;
          })
      )
    );

    batch.forEach((item, index) => {
      if (checks[index]) verified.push(toVideo(item, tmdbType));
    });
  }

  const results = verified.slice(0, 20);

  if (OMDB_API_KEY) {
    for (let i = 0; i < results.length; i += 5) {
      const batch = results.slice(i, i + 5);

      const extras = await Promise.all(
        batch.map(item =>
          getImdbExtras(tmdbType, item.id.replace("tmdb:", ""))
        )
      );

      batch.forEach((item, index) => {
        Object.assign(item, extras[index]);
      });
    }
  }

  return results;
}

function getPlatformAndRow(catalogId) {
  for (const platform of PLATFORMS) {
    for (const row of ROWS) {
      if (
        ["prime", "appletv"].includes(platform.id) &&
        ["rent", "buy"].includes(row.id)
      ) continue;

      for (const type of ["movie", "tv"]) {
        if (catalogId === `${platform.id}_${type}_${row.id}`) {
          return { platform, row, type };
        }
      }
    }
  }

  return null;
}

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    addon: "OTT Universe India",
    manifest: "/manifest.json"
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    addon: "OTT Universe India",
    version: "1.4.0",
    tokenConfigured: Boolean(TMDB_TOKEN),
    imdbRatingsConfigured: Boolean(OMDB_API_KEY)
  });
});

app.get("/debug/providers/:type", async (req, res) => {
  try {
    const type = req.params.type === "series" ? "tv" : req.params.type;

    if (!["movie", "tv"].includes(type)) {
      return res.status(400).json({ error: "Type must be movie or series." });
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

app.get("/debug/catalog/:platform/:type/:row", async (req, res) => {
  try {
    const platform = PLATFORMS.find(item => item.id === req.params.platform);
    const type = req.params.type === "series" ? "tv" : req.params.type;
    const row = ROWS.find(item => item.id === req.params.row);

    if (!platform || !row || !["movie", "tv"].includes(type)) {
      return res.status(400).json({ error: "Unknown platform, type or row." });
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

    res.json({
      platform: platform.name,
      providerId: pid,
      region: "IN",
      type,
      row: row.id,
      monetization: row.monetization,
      resultCount: metas.length,
      metas
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/manifest.json", (req, res) => {
  const catalogs = [];

  for (const platform of PLATFORMS) {
    const platformRows = ["prime", "appletv"].includes(platform.id)
      ? ROWS.filter(row => !["rent", "buy"].includes(row.id))
      : ROWS;

    for (const row of platformRows) {
      catalogs.push({
        id: `${platform.id}_movie_${row.id}`,
        type: "movie",
        name: `${platform.name} - ${row.name}`
      });

      catalogs.push({
        id: `${platform.id}_tv_${row.id}`,
        type: "series",
        name: `${platform.name} - ${row.name}`
      });
    }
  }

  res.json({
    id: "com.ottuniverse.india",
    version: "1.4.0",
    name: "OTT Universe India",
    description: "Discover movies and series reported as available on major OTT platforms in India.",
    resources: ["catalog", "meta"],
    types: ["movie", "series"],
    idPrefixes: ["tmdb:"],
    catalogs
  });
});

app.get("/catalog/:type/:id.json", async (req, res) => {
  try {
    const type = req.params.type === "series" ? "tv" : req.params.type;

    if (!["movie", "tv"].includes(type)) {
      return res.json({ metas: [] });
    }

    const selected = getPlatformAndRow(req.params.id);

    if (!selected || selected.type !== type) {
      return res.json({ metas: [] });
    }

    const metas = await catalog(selected.platform, type, selected.row);
    res.json({ metas });
  } catch (error) {
    console.error("Catalogue error:", error.message);
    res.status(500).json({ metas: [], error: error.message });
  }
});

app.get("/meta/:type/:id.json", async (req, res) => {
  try {
    const type = req.params.type === "series" ? "tv" : req.params.type;

    if (!["movie", "tv"].includes(type)) {
      return res.status(400).json({ error: "Type must be movie or series." });
    }

    const tmdbId = String(req.params.id).replace(/^tmdb:/, "");

    if (!/^\d+$/.test(tmdbId)) {
      return res.status(400).json({ error: "Invalid TMDB ID." });
    }

    const details = await tmdb(`/${type}/${tmdbId}`, {
      append_to_response: "external_ids,videos",
      language: "en-US"
    });

    const isMovie = type === "movie";
    const imdbId = details.external_ids?.imdb_id || details.imdb_id || null;

    const [imdbData, credits, certification] = await Promise.all([
      imdbId ? omdbByImdbId(imdbId) : Promise.resolve(null),
      getCreditInformation(type, tmdbId),
      getCertification(type, tmdbId)
    ]);

    const trailerInformation = getTrailerInformation(details);

    const spokenLanguages = (details.spoken_languages || [])
      .map(language => ({
        name: language.name,
        englishName: language.english_name,
        code: language.iso_639_1
      }));

    const meta = {
      id: `tmdb:${details.id}`,
      type: isMovie ? "movie" : "series",
      name: isMovie ? details.title : details.name,
      poster: imageUrl(details.poster_path),
      background: imageUrl(details.backdrop_path, "w1280"),
      description: details.overview || "",
      tagline: details.tagline || "",

      releaseInfo: (
        isMovie ? details.release_date : details.first_air_date
      )?.slice(0, 4) || "",

      released: isMovie
        ? details.release_date || null
        : details.first_air_date || null,

      genres: (details.genres || []).map(genre => genre.name),

      country: (details.production_countries || [])
        .map(country => country.name)
        .join(", "),

      originalLanguage: details.original_language || null,
      spokenLanguages,
      language: spokenLanguages.map(item => item.name).join(", "),

      tmdbRating:
        typeof details.vote_average === "number"
          ? Number(details.vote_average.toFixed(1))
          : null,

      tmdbVotes:
        typeof details.vote_count === "number"
          ? details.vote_count
          : null,

      imdb_id: imdbId,
      imdbUrl: imdbId ? `https://www.imdb.com/title/${imdbId}/` : null,

      imdbRating: validValue(imdbData?.imdbRating),
      imdbVotes: validValue(imdbData?.imdbVotes),
      awards: validValue(imdbData?.Awards),

      links: imdbId ? [{
        name: "IMDb",
        category: "imdb",
        url: `https://www.imdb.com/title/${imdbId}/`
      }] : [],

      ...credits,
      ...certification,
      ...trailerInformation,

      productionCompanies: (details.production_companies || [])
        .map(company => ({
          name: company.name,
          country: company.origin_country,
          logo: imageUrl(company.logo_path, "w300")
        })),

      homepage: details.homepage || null
    };

    if (isMovie) {
      meta.runtime =
        typeof details.runtime === "number"
          ? `${details.runtime} min`
          : null;

      meta.runtimeMinutes = details.runtime || null;
    } else {
      const creators = (details.created_by || []).map(person => ({
        name: person.name,
        id: person.id,
        profile: imageUrl(person.profile_path)
      }));

      meta.creators = creators.map(person => person.name);
      meta.creatorDetails = creators;

      meta.networks = (details.networks || []).map(network => ({
        name: network.name,
        logo: imageUrl(network.logo_path, "w300"),
        country: network.origin_country
      }));

      meta.numberOfSeasons = details.number_of_seasons ?? null;
      meta.numberOfEpisodes = details.number_of_episodes ?? null;
      meta.firstAirDate = details.first_air_date || null;
      meta.lastAirDate = details.last_air_date || null;
      meta.status = details.status || null;

      const episodeRuntime = details.episode_run_time || [];

      meta.episodeRuntime = episodeRuntime.length
        ? `${episodeRuntime[0]} min`
        : null;

      meta.seasons = (details.seasons || []).map(season => ({
        seasonNumber: season.season_number,
        name: season.name,
        episodeCount: season.episode_count,
        airDate: season.air_date || null,
        poster: imageUrl(season.poster_path)
      }));

      meta.lastEpisode = details.last_episode_to_air
        ? {
            name: details.last_episode_to_air.name,
            seasonNumber: details.last_episode_to_air.season_number,
            episodeNumber: details.last_episode_to_air.episode_number,
            airDate: details.last_episode_to_air.air_date || null
          }
        : null;

      meta.nextEpisode = details.next_episode_to_air
        ? {
            name: details.next_episode_to_air.name,
            seasonNumber: details.next_episode_to_air.season_number,
            episodeNumber: details.next_episode_to_air.episode_number,
            airDate: details.next_episode_to_air.air_date || null
          }
        : null;
    }

    res.json({ meta });
  } catch (error) {
    console.error("Metadata error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`OTT Universe India addon listening on port ${PORT}`);
});
