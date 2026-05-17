# Example scene · Now-Playing Card ⭐⭐

A small now-playing card you can drop on the corner of any scene
(via a Custom Scene → Raw HTML/CSS, or as an iframe overlay).
Polls `/api/music/now` once a second and shows the current track's
cover art / title / artist.

## What it teaches

- Polling a CacheStream public endpoint from a scene.
- Rendering cover art from `/api/music/cover/:id`.
- Handling the "nothing playing" / "radio mode" cases.

## Install

1. Admin panel → **Scenes** tab → **+ Raw HTML / CSS**.
2. Name it `Now Playing`, slug `now-playing`.
3. Paste [`scene.html`](scene.html) and [`scene.css`](scene.css).
4. Save.

Open `/scene/custom/now-playing` to preview. The card is a
**transparent-background** scene, so you usually want to:

- **Use it as an iframe overlay** on another scene (Studio →
  + Chat → set `src` to `http://web:7788/scene/custom/now-playing`,
  drag to a corner, resize), **or**
- Stack it on a background you already have via `<body>` styles.

## Customisation

- Edit `POLL_MS` (default `1000`) for faster / slower updates.
- Tweak the `.card` width / position in `scene.css`.
- The card hides itself when no track is playing — remove the
  `card-empty` class handling if you'd rather show "Radio silence".

## API contract

`GET /api/music/now` returns:

```json
{
  "mode": "library" | "radio" | "idle",
  "volume": 0.6,
  "nowPlaying": {
    "trackId": "abcd1234",
    "title": "Track Title",
    "artist": "Artist",
    "album": "Album",
    "coverPath": "/app/data/covers/abcd1234.jpg",
    "durationS": 234,
    "startedAt": 1742312345000
  }
}
```

Cover art comes from `/api/music/cover/:trackId` (only when the
track has embedded art).
