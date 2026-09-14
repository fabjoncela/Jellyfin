#!/usr/bin/env sh
# Deploy the Lingarr/LibreTranslate services without recreating the existing
# media applications, then finish the one-time automated configuration.
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

install -d -m 0750 -o "$puid" -g "$pgid" "$stack_dir/config/lingarr"
install -m 0644 "$repo_dir/compose.yml" "$stack_dir/compose.yml"

docker compose --env-file "$stack_env" -f "$stack_dir/compose.yml" config --quiet

# LibreTranslate deliberately runs as its own unprivileged user (UID 1032).
# A newly-created named volume is root-owned, so prepare it before the service
# starts; this lets it persist downloaded Argos language models without making
# the long-running translation service root.
libretranslate_image=$(awk -F= '$1 == "LIBRETRANSLATE_IMAGE" { print substr($0, index($0, "=") + 1); exit }' "$stack_env")
if [ -z "$libretranslate_image" ]; then
  libretranslate_image='libretranslate/libretranslate:v1.9.6@sha256:98d9ec356102a93ffb4e88046688a1a7ab2f3bf8e54b63588332c04f9686a668'
fi
docker volume create libretranslate-models >/dev/null
docker run --rm --user 0:0 --entrypoint /bin/sh \
  -v libretranslate-models:/models \
  "$libretranslate_image" \
  -c 'mkdir -p /models && chown -R 1032:65534 /models'

docker compose --env-file "$stack_env" -f "$stack_dir/compose.yml" up -d libretranslate lingarr
sh "$repo_dir/scripts/configure-lingarr.sh"
docker compose --env-file "$stack_env" -f "$stack_dir/compose.yml" ps libretranslate lingarr
