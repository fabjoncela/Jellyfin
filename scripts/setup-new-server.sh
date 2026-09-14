#!/usr/bin/env sh
# Bootstrap this media stack on a new Ubuntu/Debian server from this repository.
# With --restore, it restores the application configuration and finishes the
# Lingarr/Maintainerr setup. It never deletes an existing live stack.
set -eu

usage() {
  cat <<'EOF'
Usage:
  setup-new-server.sh --lan-ip IP [--restore CONFIG.zip] [--install-docker] [--install-tailscale]

Required:
  --lan-ip IP             Static LAN IP or DHCP-reserved address for this server.

Optional:
  --restore CONFIG.zip    ZIP created by share-config-backup.sh. Restores /config.
  --install-docker        Install Docker Engine + Compose from Docker's official apt repo.
  --install-tailscale     Install Tailscale and begin interactive tailnet login.
  --help                  Show this help text.

Before running:
  - Copy or mount media at /srv/media-stack/data/media after setup.
  - Run this as your normal login user, not directly as root.
  - Start from a fresh server: the script refuses to overwrite a live compose.yml.
EOF
}

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

lan_ip=''
restore_zip=''
install_docker='false'
install_tailscale='false'

while [ "$#" -gt 0 ]; do
  case "$1" in
    --lan-ip)
      [ "$#" -ge 2 ] || die '--lan-ip requires an IPv4 address.'
      lan_ip=$2
      shift 2
      ;;
    --restore)
      [ "$#" -ge 2 ] || die '--restore requires a ZIP path.'
      restore_zip=$2
      shift 2
      ;;
    --install-docker)
      install_docker='true'
      shift
      ;;
    --install-tailscale)
      install_tailscale='true'
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

[ "$(id -u)" -ne 0 ] || die 'Run this script as your normal login user; it will request sudo when needed.'
[ -n "$lan_ip" ] || die '--lan-ip is required.'

if ! printf '%s\n' "$lan_ip" | awk -F. '
  BEGIN { valid = 1 }
  NF != 4 { valid = 0; exit }
  { for (i = 1; i <= 4; i++) if ($i !~ /^[0-9]+$/ || $i > 255) { valid = 0; exit } }
  END { exit !valid }
'; then
  die 'The LAN IP must be a valid IPv4 address.'
fi

if [ -n "$restore_zip" ]; then
  [ -f "$restore_zip" ] || die "Restore ZIP not found: $restore_zip"
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(dirname "$script_dir")
stack_dir='/srv/media-stack'
stack_env="$stack_dir/.env"
stack_compose="$stack_dir/compose.yml"
stack_user=$(id -un)
puid=$(id -u)
pgid=$(id -g)

[ -f "$repo_dir/compose.yml" ] || die "compose.yml was not found beside this script: $repo_dir"
[ -f "$repo_dir/.env.example" ] || die ".env.example was not found beside this script: $repo_dir"
[ ! -e "$stack_compose" ] || die "$stack_compose already exists. Refusing to overwrite a live stack."

install_base_tools() {
  missing=''
  for command_name in curl git jq unzip zip; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      missing="$missing $command_name"
    fi
  done
  [ -z "$missing" ] && return

  [ -r /etc/os-release ] || die "Missing tools:$missing. Install them manually on this distribution."
  . /etc/os-release
  case "${ID:-}" in
    ubuntu|debian) ;;
    *) die "Missing tools:$missing. Install them manually on ${ID:-unknown}." ;;
  esac
  printf '%s\n' "Installing required tools:$missing"
  sudo apt-get update
  sudo apt-get install -y curl git jq unzip zip
}

install_docker_engine() {
  if docker compose version >/dev/null 2>&1; then
    return
  fi
  [ "$install_docker" = 'true' ] || die 'Docker Compose is missing. Install it first, or rerun with --install-docker.'

  [ -r /etc/os-release ] || die 'Cannot identify this Linux distribution.'
  . /etc/os-release
  case "${ID:-}" in
    ubuntu|debian) ;;
    *) die "--install-docker supports Ubuntu or Debian only; this system is ${ID:-unknown}." ;;
  esac

  printf '%s\n' "Installing Docker Engine from Docker's official $ID repository..."
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl git jq unzip zip
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/$ID
Suites: ${VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo systemctl enable --now docker
  sudo usermod -aG docker "$stack_user"
}

install_base_tools
install_docker_engine

if [ -n "$restore_zip" ]; then
  unzip -Z1 "$restore_zip" | grep -qx 'config/' || die 'The restore ZIP does not contain a top-level config/ directory.'
fi

if [ ! -e /dev/dri/renderD128 ]; then
  die 'This Compose file expects /dev/dri/renderD128 for Jellyfin hardware transcoding. Add a compatible GPU or adapt compose.yml before setup.'
fi

render_gid=$(getent group render | awk -F: 'NR == 1 { print $3 }')
case "$render_gid" in
  ''|*[!0-9]*) die 'Could not determine the numeric render group ID.' ;;
esac

printf '%s\n' 'Creating the media-stack directories and environment file...'
sudo install -d -m 0755 "$stack_dir"
sudo install -d -m 0750 -o "$puid" -g "$pgid" \
  "$stack_dir/config" \
  "$stack_dir/data/media" \
  "$stack_dir/config/jellyfin/cache" \
  "$stack_dir/config/qbittorrent" \
  "$stack_dir/config/prowlarr" \
  "$stack_dir/config/sonarr" \
  "$stack_dir/config/radarr" \
  "$stack_dir/config/jellyseerr" \
  "$stack_dir/config/bazarr" \
  "$stack_dir/config/lingarr" \
  "$stack_dir/config/recyclarr" \
  "$stack_dir/config/maintainerr" \
  "$stack_dir/config/scrutiny/influxdb"
sudo install -m 0644 "$repo_dir/compose.yml" "$stack_compose"
sudo install -m 0600 "$repo_dir/.env.example" "$stack_env"
sudo chown "$puid:$pgid" "$stack_env"
sudo sed -i \
  -e "s/^PUID=.*/PUID=$puid/" \
  -e "s/^PGID=.*/PGID=$pgid/" \
  -e "s/^JELLYFIN_LAN_IP=.*/JELLYFIN_LAN_IP=$lan_ip/" \
  -e "s/^RENDER_GID=.*/RENDER_GID=$render_gid/" \
  "$stack_env"

if [ -n "$restore_zip" ]; then
  printf '%s\n' 'Restoring application configuration from the ZIP...'
  sudo unzip -oq "$restore_zip" -d "$stack_dir"
  sudo chown -R "$puid:$pgid" "$stack_dir/config"
fi

sudo docker compose --env-file "$stack_env" -f "$stack_compose" config --quiet

printf '%s\n' 'Starting the core media services...'
sudo docker compose --env-file "$stack_env" -f "$stack_compose" up -d \
  jellyfin qbittorrent prowlarr sonarr radarr seerr bazarr recyclarr scrutiny

if [ -n "$restore_zip" ]; then
  printf '%s\n' 'Restored configuration found; deploying Lingarr and Maintainerr...'
  "$repo_dir/scripts/deploy-lingarr.sh"
  "$repo_dir/scripts/deploy-maintainerr.sh"
else
  printf '%s\n' 'Core services are running. Configure Jellyfin, qBittorrent, Prowlarr, Sonarr, Radarr, Seerr, and Bazarr in their LAN web interfaces.'
  printf '%s\n' 'After that, run deploy-lingarr.sh and deploy-maintainerr.sh from this repository.'
fi

if [ "$install_tailscale" = 'true' ]; then
  printf '%s\n' 'Installing Tailscale; open the login URL it prints and authenticate this server...'
  curl -fsSL https://tailscale.com/install.sh | sh
  sudo tailscale up
fi

printf '\n%s\n' 'New-server setup completed.'
printf '%s\n' "LAN services: http://$lan_ip:8096 (Jellyfin), :5055 (Seerr), :8181 (qBittorrent)"
printf '%s\n' 'Before using the library, ensure the media disk is mounted at /srv/media-stack/data/media.'
printf '%s\n' 'Cloudflared is intentionally not started. Add a valid token to .env and start it only if you actually use it.'
printf '%s\n' 'Run: sudo docker compose --env-file /srv/media-stack/.env -f /srv/media-stack/compose.yml ps'
