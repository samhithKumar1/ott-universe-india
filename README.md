# OTT Universe India — starter addon

This is a first deployable **catalogue-discovery MVP** for Stremio-compatible clients.
It is not a streaming host and does not provide video streams.

## Included in this first version

- One Stremio-compatible `manifest.json` endpoint.
- Separate India-region catalogues for Netflix, Prime Video, JioHotstar, ZEE5, Sony LIV, Aha and Apple TV+.
- Movie and series catalogues for each platform.
- `Popular` and `Highest Rated` rows.
- TMDB metadata, posters, descriptions, genres and release year.
- Provider matching based on TMDB's India watch-provider list.

## Important accuracy notes

- Provider data is supplied by TMDB and is not a guaranteed complete or instant copy of each OTT service's own catalogue.
- `Popular` is **not** the platform's official Top 10 ranking.
- This MVP does not claim to know exact OTT-added dates, so it does not label titles as `Newly Added`.
- Coming Soon is not included because a theatrical release date is not the same as an OTT launch date.
- TMDB vote averages are not IMDb ratings. IMDb and Rotten Tomatoes scores are not fabricated or relabelled.
- Rental/buy results can appear in provider discovery; exact prices and direct playback links are not supplied by this MVP.
- Provider availability should be checked in both Stremio and Debrify after deployment.

## Environment variable

Set either of the following in Render (the value is your TMDB API Read Access Token or API key):

- `TMDB_READ_ACCESS_TOKEN` (recommended; Bearer token)
- `TMDB_API_KEY` (accepted as a fallback; must be a TMDB API key)

Do not share the secret token in chat or commit it to GitHub.

## Run locally

```bash
npm install
TMDB_READ_ACCESS_TOKEN="your-token" npm start
```

Then test:

- `http://localhost:10000/health`
- `http://localhost:10000/manifest.json`

## Deploy on Render

1. Create a GitHub repository and upload these project files.
2. In Render, create a **Web Service** connected to that repository.
3. Runtime: Node.
4. Build command: `npm install`
5. Start command: `npm start`
6. Add `TMDB_READ_ACCESS_TOKEN` in Render → Environment.
7. Deploy, then open `/health` and `/manifest.json` on the Render service URL.
8. Add the exact `/manifest.json` URL to Stremio and Debrify.

## Next development stage

Before calling the project feature-complete, add:
- Reliable official platform Top 10 feeds (only where licensed/available).
- Verified platform-addition dates and announced OTT launch dates.
- IMDb/Rotten Tomatoes integrations only where permitted and reliable.
- Better provider-name matching and manual verification for regional platforms.
- Search, watchlist/favourites, watched state, trailer controls and richer title details in a separate custom dashboard. Native Stremio/Debrify clients control their own UI and may not support those custom interactions.
