#!/usr/bin/env sh
# Make a ZIP of the media-stack configuration and upload it to File.io for one
# download within one day. This archive is intentionally unencrypted at the
# user's request, so its link must be treated as a secret.
set -eu
umask 077

config_dir='/srv/media-stack/config'
backup_dir='/home/fabjon/backups'
stack_env='/srv/media-stack/.env'
stamp=$(date '+%Y%m%d-%H%M%S')
backup_zip="$backup_dir/media-stack-config-$stamp.zip"

if [ "$(id -u)" -ne 0 ]; then
  exec sudo "$0" "$@"
fi

if [ ! -d "$config_dir" ]; then
  printf '%s\n' "Configuration directory not found: $config_dir" >&2
  exit 1
fi

puid=$(awk -F= '$1 == "PUID" { print $2; exit }' "$stack_env")
pgid=$(awk -F= '$1 == "PGID" { print $2; exit }' "$stack_env")
case "$puid:$pgid" in
  *[!0-9:]*|:) printf '%s\n' 'PUID and PGID must be numeric in /srv/media-stack/.env.' >&2; exit 1 ;;
esac

install -d -m 0700 -o "$puid" -g "$pgid" "$backup_dir"

printf '%s\n' 'Creating the ZIP backup...'
(
  cd /srv/media-stack
  # qBittorrent stores a live IPC socket below its configuration directory.
  # Archive only normal files, directories, and symlinks so runtime sockets
  # cannot make the backup fail.
  find config -xdev \( -type d -o -type f -o -type l \) -print |
    zip -q -y "$backup_zip" -@
)
chown "$puid:$pgid" "$backup_zip"

backup_size=$(du -h "$backup_zip" | awk '{print $1}')
printf '%s\n' "Uploading $backup_size to File.io (one download, one-day expiry)..."
# curl writes this percentage-style progress bar to the terminal while keeping
# File.io's JSON response available for the script to read below.
upload_response=$(curl --fail --show-error --progress-bar \
  --form "file=@$backup_zip" \
  --form 'maxDownloads=1' \
  --form 'autoDelete=true' \
  --form 'expires=1d' \
  'https://file.io')
download_url=$(printf '%s' "$upload_response" | jq -r 'if .success == true then .link // empty else empty end')

if [ -z "$download_url" ]; then
  printf '%s\n' 'File.io did not return a download link. Your local ZIP backup was kept at:' >&2
  printf '%s\n' "$backup_zip" >&2
  exit 1
fi

printf '\n%s\n' 'ZIP backup created and uploaded.'
printf '%s\n' "One-time download link (expires in one day): $download_url"
rm -f "$backup_zip"
printf '%s\n' 'The local ZIP was removed after the successful upload.'
printf '%s\n' 'To restore after downloading: unzip FILE.zip'
