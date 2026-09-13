# Media-stack configuration

This repository tracks the reviewable, non-secret parts of the Docker media stack:

- `compose.yml` — service definitions and volume layout.
- `.env.example` — image pins and required variable names, without credentials.
- `recyclarr/` — quality-profile definitions; their secret values stay outside Git.

It intentionally does **not** contain `.env`, Cloudflare tunnel tokens, API keys,
passwords, application databases, media, torrents, logs, or caches.  Do not add
those files to this repository.

## Restore outline

1. Clone this repository to `/srv/media-stack` on the replacement server.
2. Copy `.env.example` to `.env`; set the LAN IP, render group ID, and Cloudflare
   token for that server.
3. Restore the private application configuration archive separately.  Git is
   version history for the declarative configuration, not a replacement for that
   archive or for a second physical copy of the media.
4. Review the Compose file and start the stack with Docker Compose.

## Updating this repository

After intentionally changing the Compose file or Recyclarr profiles, copy the
reviewed change here, then run:

```bash
git add compose.yml .env.example recyclarr README.md
git commit -m "Describe the change"
```
