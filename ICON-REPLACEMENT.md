# Zombie Home Screen icon

Zombie currently uses `icon.svg`, the existing dark music-note placeholder. It is a scalable vector icon and is referenced by both the iPhone Apple touch-icon link and the PWA manifest.

When you supply your custom icon, replace this one file:

- `icon.svg` — 512 × 512 viewBox, no text, dark black/grey skull or zombie head with headphones.

If you prefer PNG files later, provide these square, non-transparent images and the app can be switched to them:

- `zombie-icon-180.png` — 180 × 180 for iPhone Home Screen.
- `zombie-icon-192.png` — 192 × 192 for the PWA manifest.
- `zombie-icon-512.png` — 512 × 512 for the PWA manifest and high-resolution devices.

Keep important artwork inside the middle 80% of the square so iOS rounding does not crop it.
