# Example scene · Countdown Poster ⭐

A full-screen poster with a big title, optional background image,
and a countdown timer. Pure HTML + CSS — no JavaScript fetches, no
SSE. The countdown is a single `setInterval` updating a DOM node.

## What it teaches

- The shape of a Custom Scene's HTML payload.
- How to use background gradients + layered CSS for the cyberpunk
  look without writing any images yourself.
- How to do a self-updating countdown with a tiny script tag.

## Install

1. Admin panel → **Scenes** tab → **+ Raw HTML / CSS**.
2. Name it `Launch Poster`, slug `launch`.
3. Paste [`scene.html`](scene.html) into the HTML textarea.
4. Paste [`scene.css`](scene.css) into the CSS textarea.
5. Save → click **Save as preset**.

It's now reachable at `/scene/custom/launch` and selectable as a
scene in the Status tab.

## Customisation

In `scene.html`, change:

```html
<h1 class="title">YOUR PRODUCT</h1>
<p class="subtitle">Launches in</p>
```

…and the `TARGET_AT` constant inside the `<script>` block to your
real launch time. Past the target the page shows `LIVE` instead of
zeros.

For a different colour scheme, override `--accent` in `scene.css`.

## How the countdown works

```js
const target = new Date(TARGET_AT).getTime();
setInterval(() => {
  const ms = Math.max(0, target - Date.now());
  // …format ms into HH:MM:SS and write into the DOM
}, 1000);
```

That's the entire dynamic part — everything else is static HTML +
CSS. Headless Chromium re-paints the updated DOM at 30 fps and the
streamer captures the new frame.

## When to use this instead of the built-in Starting Soon scene

The built-in `/scene/starting-soon?at=ISO` does the same thing,
but with a fixed layout and the branding ribbon. Use this example
when you want:

- A different layout (e.g. a giant centered logo).
- No branding ribbon.
- Per-scene CSS that doesn't inherit from `scene-base.css`.
