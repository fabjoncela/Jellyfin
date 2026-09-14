# Media stack

Docker media stack for a single Linux server. It is designed to work from the
home LAN, privately through Tailscale, and—only for services you deliberately
publish—through Tailscale Funnel.

This repository contains reviewable configuration only. It intentionally does
**not** contain `.env`, API keys, passwords, Cloudflare tokens, application
databases, media files, torrents, logs, caches, or backups.

## What runs here

| Service | Purpose | LAN URL |
| --- | --- | --- |
| Jellyfin | Watch movies and shows | `http://<LAN-IP>:8096` |
| qBittorrent | Download client | `http://<LAN-IP>:8181` |
| Prowlarr | Indexer management | `http://<LAN-IP>:9696` |
| Sonarr | TV automation | `http://<LAN-IP>:8989` |
| Radarr | Movie automation | `http://<LAN-IP>:7878` |
| Seerr | Requests for movies and shows | `http://<LAN-IP>:5055` |
| Bazarr | Native subtitle downloads | `http://<LAN-IP>:6767` |
| Lingarr | English-to-Albanian subtitle fallback | `http://<LAN-IP>:9876` |
| Maintainerr | Watched-media cleanup review/rules | `http://<LAN-IP>:6246` |
| Scrutiny | Disk SMART health and history | `http://<LAN-IP>:8081` |

LibreTranslate is used only by Lingarr on the internal Docker network; it has
no LAN port. Recyclarr is also internal and applies the quality profiles in
`recyclarr/`.

## Important paths

| Path | Contents | Backup? |
| --- | --- | --- |
| `/srv/media-stack/compose.yml` | Live Compose file | Yes, this repo tracks it |
| `/srv/media-stack/.env` | LAN IP, user IDs, image pins, Cloudflare token | Yes, separately and securely |
| `/srv/media-stack/config/` | Application settings and databases | Yes, regularly |
| `/srv/media-stack/data/media/` | Movies and TV files | Yes if the media matters to you |
| `/srv/media-stack/data/` | qBittorrent downloads and Arr staging paths | Optional, depending on seeding needs |
| `/home/<user>/media-stack-config-git/` | Local clone of this repository | Yes; push it to a private Git remote |

The media mount paths must remain the same:

```text
Host:      /srv/media-stack/data/media
Jellyfin:  /media
Sonarr:    /data
Radarr:    /data
Bazarr:    /data
Lingarr:   /data/media
```

Changing these paths after setup causes Arr, Bazarr, Lingarr, and Jellyfin to
lose track of media until their path mappings are corrected.

## Normal use

1. Request a movie or show in Seerr.
2. Seerr sends the request to Radarr or Sonarr.
3. Prowlarr provides indexers; qBittorrent downloads the release.
4. Radarr or Sonarr imports it into `/srv/media-stack/data/media`.
5. Bazarr looks for normal subtitles. Lingarr checks hourly and can translate
   up to three English subtitle fallbacks to Albanian when no Albanian subtitle
   is available.
6. Watch it in Jellyfin.

Maintainerr currently creates safe review collections for watched movies and
episodes. Its two rules use **Do nothing** until the collections have been
reviewed; they do not delete files or unmonitor Arr items.

## Day-to-day commands

Run these from any directory. They target the live stack explicitly.

```bash
# See every container and its health/status.
sudo docker compose --env-file /srv/media-stack/.env -f /srv/media-stack/compose.yml ps

# Follow logs for one service. Replace jellyfin with any service name.
sudo docker compose --env-file /srv/media-stack/.env -f /srv/media-stack/compose.yml logs -f --tail=100 jellyfin

# Restart one service without touching the others.
sudo docker compose --env-file /srv/media-stack/.env -f /srv/media-stack/compose.yml restart jellyfin

# Validate the live Compose configuration before applying a change.
sudo docker compose --env-file /srv/media-stack/.env -f /srv/media-stack/compose.yml config --quiet

# Check free space.
df -h /srv/media-stack
```

Do not run `docker compose down -v`: the `-v` option can remove named volumes,
including LibreTranslate's downloaded language models.

## First setup on a new PC/server

These steps assume Ubuntu or Debian and a user with sudo access. Use a static
LAN IP or a DHCP reservation for the server before continuing.

### Fast path: restore onto a replacement server

After copying or cloning this repository to the new server, the included setup
script can perform the directory setup, Docker installation, configuration
restore, core-service start, Lingarr deployment, Maintainerr deployment, and
optional Tailscale installation in one run:

```bash
cd /home/$USER/media-stack-config-git
./scripts/setup-new-server.sh \
  --lan-ip 192.168.1.50 \
  --restore /path/to/media-stack-config-backup.zip \
  --install-docker \
  --install-tailscale
```

Use the new server's own LAN IP. Mount or copy the media disk at
`/srv/media-stack/data/media` after the command finishes. The script refuses
to overwrite an existing `/srv/media-stack/compose.yml`, never starts the
Cloudflare tunnel automatically, and begins an interactive Tailscale login if
requested. A clean setup without `--restore` starts only the core services;
their first-time web configuration still needs to be completed in the apps.

For a clean build with no configuration ZIP, use:

```bash
cd /home/$USER/media-stack-config-git
./scripts/setup-new-server.sh \
  --lan-ip 192.168.1.50 \
  --install-docker \
  --install-tailscale
```

Then follow the numbered application-configuration list in [Start the core
services](#4-start-the-core-services), and finally run
`deploy-lingarr.sh` and `deploy-maintainerr.sh` as shown below it.

### 1. Install the base tools

Install Docker Engine and the Compose plugin using Docker's current official
Ubuntu or Debian instructions. Do not install the distribution's `docker.io`
package alongside Docker's official packages; they conflict. Then install the
tools used by the included scripts:

- [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Docker Engine on Debian](https://docs.docker.com/engine/install/debian/)

```bash
sudo apt update
sudo apt install -y git curl jq zip
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

Sign out and back in after adding yourself to the `docker` group. Confirm with:

```bash
docker compose version
```

For Jellyfin hardware transcoding, confirm that the machine has
`/dev/dri/renderD128` and record the numeric `render` group ID:

```bash
ls -l /dev/dri/renderD128
getent group render
```

If the new machine has no compatible GPU, remove the Jellyfin `devices` and
`group_add` entries from `compose.yml` before starting it.

### 2. Get this repository and create the live directories

Clone your private copy of this repository. Replace the placeholder URL:

```bash
git clone <YOUR-PRIVATE-REPOSITORY-URL> /home/$USER/media-stack-config-git
cd /home/$USER/media-stack-config-git

sudo install -d -m 0755 /srv/media-stack
sudo install -d -m 0750 -o "$(id -u)" -g "$(id -g)" \
  /srv/media-stack/config \
  /srv/media-stack/data/media
sudo install -d -m 0750 -o "$(id -u)" -g "$(id -g)" \
  /srv/media-stack/config/jellyfin/cache \
  /srv/media-stack/config/qbittorrent \
  /srv/media-stack/config/prowlarr \
  /srv/media-stack/config/sonarr \
  /srv/media-stack/config/radarr \
  /srv/media-stack/config/jellyseerr \
  /srv/media-stack/config/bazarr \
  /srv/media-stack/config/lingarr \
  /srv/media-stack/config/recyclarr \
  /srv/media-stack/config/maintainerr \
  /srv/media-stack/config/scrutiny/influxdb
sudo install -m 0644 compose.yml /srv/media-stack/compose.yml
sudo install -m 0600 .env.example /srv/media-stack/.env
sudo chown "$(id -u):$(id -g)" /srv/media-stack/.env
```

Edit `/srv/media-stack/.env` and set at least:

```dotenv
PUID=<output of: id -u>
PGID=<output of: id -g>
TZ=Europe/Tirane
JELLYFIN_LAN_IP=<the new server's static LAN IP>
RENDER_GID=<numeric render group ID, if using GPU transcoding>
```

Keep the image pins from `.env.example`. Do not put a Cloudflare token, API
key, or password into Git.

### 3. Restore configuration and media, if migrating

The configuration backup ZIP contains a top-level `config/` directory. It does
not contain `/srv/media-stack/.env` or any media files.

1. Stop the new stack if it has been started.
2. Copy the configuration ZIP to the new server through a trusted method.
3. Preserve any fresh configuration rather than deleting it.
4. Extract the archive into `/srv/media-stack`.
5. Mount or copy the media disk so the library is again at
   `/srv/media-stack/data/media`.

Example:

```bash
sudo docker compose --env-file /srv/media-stack/.env -f /srv/media-stack/compose.yml down
sudo mv /srv/media-stack/config "/srv/media-stack/config.before-restore.$(date +%Y%m%d-%H%M%S)"
sudo unzip /path/to/media-stack-config-backup.zip -d /srv/media-stack
sudo chown -R "$(id -u):$(id -g)" /srv/media-stack/config
```

The `config.before-restore.*` directory is a rollback copy. Leave it in place
until the restored applications have been checked. Recreate `.env` separately
with the new server's LAN IP and any required tokens.

### 4. Start the core services

For a clean setup, start the core applications first:

```bash
sudo docker compose --env-file /srv/media-stack/.env -f /srv/media-stack/compose.yml up -d \
  jellyfin qbittorrent prowlarr sonarr radarr seerr bazarr recyclarr scrutiny
```

Open the LAN URLs above and configure the normal Arr workflow:

1. Configure qBittorrent download paths and categories.
2. Add indexers to Prowlarr and sync them to Sonarr and Radarr.
3. Add qBittorrent as the download client in Sonarr and Radarr.
4. Add the media root folders under `/data/media/...` in Sonarr and Radarr.
5. Configure Jellyfin libraries using `/media`.
6. Connect Seerr to Jellyfin, Sonarr, and Radarr.
7. Connect Bazarr to Sonarr and Radarr; use `/data` paths.

If a Cloudflare tunnel is wanted, add a valid `CLOUDFLARED_MEDIA_TOKEN` to
`.env`, then start it separately:

```bash
sudo docker compose --env-file /srv/media-stack/.env -f /srv/media-stack/compose.yml up -d cloudflared-media
```

Otherwise, leave that service stopped. Tailscale is the preferred remote-access
method for this stack.

### 5. Deploy Lingarr and Maintainerr

After Jellyfin, Radarr, Sonarr, and Seerr are configured or restored, run:

```bash
/home/$USER/media-stack-config-git/scripts/deploy-lingarr.sh
/home/$USER/media-stack-config-git/scripts/deploy-maintainerr.sh
```

`deploy-lingarr.sh` starts LibreTranslate and Lingarr, then configures the
English-to-Albanian fallback. `deploy-maintainerr.sh` creates the safe preview
rules for watched movies and TV episodes. Both scripts read the existing Arr
and Jellyfin-related keys locally without printing them.

### 6. Verify the result

```bash
sudo docker compose --env-file /srv/media-stack/.env -f /srv/media-stack/compose.yml ps
sudo docker compose --env-file /srv/media-stack/.env -f /srv/media-stack/compose.yml logs --tail=100 lingarr maintainerr
```

Check Jellyfin playback on the LAN before enabling any remote access or
automated deletion rule.

## Tailscale access

Install Tailscale on the server, phone, and PC, then sign all devices into the
same tailnet:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Enable MagicDNS in the Tailscale admin console. The server then receives a
stable tailnet name such as `<server-name>.<tailnet>.ts.net`; use that name or
its Tailscale IP from authenticated devices.

For private HTTPS access inside the tailnet only:

```bash
sudo tailscale serve --https=443 http://127.0.0.1:8096
sudo tailscale serve --https=5055 http://127.0.0.1:5055
```

For public access, Funnel is deliberately opt-in. It needs HTTPS certificates
enabled for the tailnet and exposes the selected service to anyone on the
internet. The current intended public mappings are:

```bash
# Jellyfin at https://<server-name>.<tailnet>.ts.net/
sudo tailscale funnel --https=443 http://127.0.0.1:8096

# Seerr at https://<server-name>.<tailnet>.ts.net:8443/
sudo tailscale funnel --https=8443 http://127.0.0.1:5055

sudo tailscale funnel status
sudo tailscale serve status
```

Never put qBittorrent, the Arr apps, Bazarr, Lingarr, Maintainerr, or Scrutiny
behind Funnel. Maintainerr has no built-in login and must remain LAN-only.
Use strong, unique Jellyfin and Seerr administrator passwords before making
either one public.

## Backup and restore

Run a one-time configuration transfer whenever you need a fresh copy:

```bash
/home/$USER/media-stack-config-git/scripts/share-config-backup.sh
```

The script:

1. Archives `/srv/media-stack/config/` as a ZIP, skipping temporary Unix
   sockets such as qBittorrent's IPC socket.
2. Uploads the ZIP to File.io with a one-download, one-day limit.
3. Prints the link and removes its local ZIP after File.io confirms the upload.

This is a temporary transfer mechanism, **not** a secure long-term backup: the
ZIP is unencrypted and contains API keys and application databases. Treat its
link as a password. Keep a separate encrypted/off-site backup of both
`/srv/media-stack/config/` and `/srv/media-stack/.env` for real disaster
recovery.

To inspect or clear temporary local ZIPs left by a failed upload:

```bash
ls -lh /home/$USER/backups/
gio trash /home/$USER/backups/media-stack-config-*.zip
gio trash --list
```

## Updating configuration safely

1. Edit files in this repository, not `/srv/media-stack/compose.yml` directly.
2. Validate the revised file.
3. Copy it into the live location and apply only the affected services.
4. Check container status and logs.
5. Commit the reviewed change.

Example:

```bash
cd /home/$USER/media-stack-config-git
docker compose --env-file /srv/media-stack/.env -f compose.yml config --quiet
sudo install -m 0644 compose.yml /srv/media-stack/compose.yml
sudo docker compose --env-file /srv/media-stack/.env -f /srv/media-stack/compose.yml up -d lingarr
sudo docker compose --env-file /srv/media-stack/.env -f /srv/media-stack/compose.yml ps lingarr

git add README.md compose.yml .env.example scripts recyclarr
git commit -m "Describe the stack change"
```

Image versions are pinned in `.env`. To update an application, first update
and review its pin in `.env.example` and the live `.env`, then run
`docker compose pull <service>` followed by `docker compose up -d <service>`.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| A web page does not open on LAN | Confirm the server IP, `docker compose ps`, then inspect that service's logs. |
| Remote name does not resolve | Check MagicDNS, that the client is connected to Tailscale, and `tailscale status`. |
| Remote URL works only for tailnet devices | That is expected with Serve. Funnel is required for public access. |
| Lingarr has pending translations | It checks hourly at `:10` and runs at most three translations sequentially. |
| Backup reports a qBittorrent socket warning | Use the current `share-config-backup.sh`; it skips runtime sockets. |
| Disk becomes full | Check `df -h /srv/media-stack`, qBittorrent seeding, and Maintainerr's preview collections before enabling cleanup. |

## Git hygiene

Before committing, verify no secrets are staged:

```bash
git status --short
git diff --cached
```

Never commit `.env`, `/srv/media-stack/config/`, `/srv/media-stack/data/`, or
backup ZIP files.
