#!/usr/bin/env sh
# Apply the LAN-only Maintainerr port binding, then configure safe preview
# collections. The configuration task never deletes or unmonitors media.
set -eu

repo_dir='/home/fabjon/media-stack-config-git'
stack_dir='/srv/media-stack'
stack_env="$stack_dir/.env"

if [ "$(id -u)" -ne 0 ]; then
  exec sudo "$0" "$@"
fi

puid=$(awk -F= '$1 == "PUID" { print $2; exit }' "$stack_env")
pgid=$(awk -F= '$1 == "PGID" { print $2; exit }' "$stack_env")

case "$puid:$pgid" in
  *[!0-9:]*|:) printf '%s\n' 'PUID and PGID must be numeric in /srv/media-stack/.env.' >&2; exit 1 ;;
esac

install -d -m 0750 -o "$puid" -g "$pgid" "$stack_dir/config/maintainerr"
install -m 0644 "$repo_dir/compose.yml" "$stack_dir/compose.yml"

docker compose --env-file "$stack_env" -f "$stack_dir/compose.yml" config --quiet
docker compose --env-file "$stack_env" -f "$stack_dir/compose.yml" up -d maintainerr
sh "$repo_dir/scripts/configure-maintainerr.sh"
docker compose --env-file "$stack_env" -f "$stack_dir/compose.yml" ps maintainerr
