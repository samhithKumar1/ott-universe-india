# OTT Universe India — source v2.1.0

India-focused **discovery/catalogue** add-on for Stremio and compatible clients. This project does not provide video streams or bypass OTT subscriptions.

## What this version provides

- Separate India-region catalogues for Netflix, Prime Video, JioHotstar, ZEE5, Sony LIV, Aha, Apple TV+, Sun NXT, ETV Win, Hoichoi and Lionsgate Play.
- Separate Movies and Series rows for each provider.
- Popular rows, highest-rated rows, and recent-release rows.
- General upcoming movie/series rows labelled clearly because OTT availability is not confirmed.
- Detailed metadata from TMDB: synopsis, release year, genres, cast, director/creator, runtime or season/episode counts, TMDB rating, and spoken-language metadata.
- India watch availability split into Subscription, Rent, Buy, Free and Ad-supported where TMDB returns it.
- JustWatch destination link where supplied by TMDB.
- Official YouTube trailer link when TMDB identifies an official trailer.
- Optional IMDb and Rotten Tomatoes ratings through OMDb if `OMDB_API_KEY` is configured.
- `/health`, `/diagnostics/tmdb`, and `/providers.json` endpoints.
- In-memory caching to reduce repeated TMDB requests.

## Honest data limitations

1. **Official platform Top 10:** this source does not invent an official Netflix/Prime/JioHotstar Top 10. TMDB popularity is not an official platform ranking. A separately licensed/official ranking feed would be needed.
2. **Newly added to an OTT service:** TMDB/JustWatch provider availability does not reliably provide each platform's exact India catalogue-addition date. The row is therefore called **Recent Releases**, based on the title's release/first-air date. It is not an OTT-added-date feed.
3. **Coming soon:** the general upcoming rows show release dates recorded by TMDB. They are explicitly labelled **OTT not confirmed** and are not presented as confirmed upcoming titles on a specific platform.
4. **Completeness and freshness:** TMDB's India watch-provider data is powered by JustWatch, but may omit titles or lag platform changes. It is not a guaranteed complete, real-time inventory.
5. **Audio and subtitles:** TMDB spoken-language fields are not a verified list of the audio dubs or subtitles currently offered by each OTT service. This version does not claim otherwise.
6. **IMDb / Rotten Tomatoes:** TMDB vote averages are not IMDb ratings. IMDb and Rotten Tomatoes fields are included only when the optional OMDb source returns them. Without `OMDB_API_KEY`, those scores are omitted.
7. **Native client UI:** Stremio/Debrify control their own catalogue screens. This add-on can provide named catalogue rows and metadata, but cannot force a custom home-screen grid of clickable OTT logos or trailer hover autoplay inside those apps. The logo-grid dashboard and trailer autoplay ON/OFF controls are a separate custom browsing interface planned for a later phase.
8. **Playback:** this is a discovery add-on only. It does not supply movie/series streams. Where-to-watch links point to the destination supplied by TMDB/JustWatch, not necessarily a direct platform deep link.

## TMDB credentials — keep secrets private

The code supports both TMDB credential types:

- `TMDB_READ_ACCESS_TOKEN`: TMDB v4 Read Access Token, sent as `Authorization: Bearer ...`.
- `TMDB_API_KEY`: TMDB v3 API Key, sent as the `api_key` query parameter.

If both are present, `TMDB_READ_ACCESS_TOKEN` takes precedence.

**Never paste the secret value into ChatGPT, GitHub source code, README files, or screenshots.** Keep it only in Render's Environment settings.

Optional:
- `OMDB_API_KEY`: only needed if you have an OMDb API key and want the optional IMDb/Rotten Tomatoes fields.

## Local run

Requires Node.js 18 or newer.

```bash
npm install
npm start
```

Then open:

- `http://localhost:10000/health`
- `http://localhost:10000/manifest.json`
- `http://localhost:10000/diagnostics/tmdb`
- `http://localhost:10000/providers.json`

## Render deployment

For the existing Render Web Service:

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Keep the existing TMDB credential in Render Environment settings; do not add it to GitHub.
- If using a v4 Read Access Token, the variable name must be `TMDB_READ_ACCESS_TOKEN`.
- If using a v3 API Key, the variable name must be `TMDB_API_KEY`.

After deployment, test in this order:

1. `/health` — server and credential mode.
2. `/diagnostics/tmdb` — actual TMDB authentication. A `401` means TMDB rejected the configured credential.
3. `/providers.json` — shows which India providers TMDB matched.
4. `/manifest.json` — Stremio manifest.
5. A catalogue URL, for example `/catalog/movie/netflix_movie_popular.json`.
6. A metadata URL using a real returned item ID, for example `/meta/movie/tmdb:123.json`.

Do not install in Stremio until `/diagnostics/tmdb` reports successful authentication and the manifest/catalogue tests return valid JSON.

## GitHub upload

The intended existing repository is `ott-universe-india`. Replace its tracked project files with the files in this ZIP (at minimum `server.js` and `package.json`, plus this README and `.gitignore`). Do not create a second repository unless the existing one is unavailable.

## Attribution

This product uses the TMDB API but is not endorsed or certified by TMDB. India watch-provider information is provided through TMDB and powered by JustWatch; JustWatch attribution is required for use of this provider data. TMDB states its developer API is free for non-commercial use with attribution; if this project becomes commercial or revenue-generating, obtain the appropriate TMDB commercial licence before that use.
