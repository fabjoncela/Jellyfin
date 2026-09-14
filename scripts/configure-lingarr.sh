#!/usr/bin/env sh
# Complete Lingarr's first-run setup using the existing Arr credentials without
# printing them. This configures a low-impact overnight translation schedule.
set -eu

lingarr_url='http://127.0.0.1:9876'
radarr_config='/srv/media-stack/config/radarr/config.xml'
sonarr_config='/srv/media-stack/config/sonarr/config.xml'

for attempt in $(seq 1 90); do
  if curl --fail --silent --output /dev/null "$lingarr_url/api/auth/authenticated"; then
    break
  fi
  if [ "$attempt" -eq 90 ]; then
    printf '%s\n' 'Lingarr did not become ready within 180 seconds.' >&2
    exit 1
  fi
  sleep 2
done

radarr_api_key=$(sed -n 's:.*<ApiKey>\(.*\)</ApiKey>.*:\1:p' "$radarr_config")
sonarr_api_key=$(sed -n 's:.*<ApiKey>\(.*\)</ApiKey>.*:\1:p' "$sonarr_config")

if [ -z "$radarr_api_key" ] || [ -z "$sonarr_api_key" ]; then
  printf '%s\n' 'Could not read the existing Radarr or Sonarr API key.' >&2
  exit 1
fi

# Complete onboarding with no Lingarr login. Its UI is bound only to the LAN
# and never placed behind a public Funnel or Cloudflare route.
curl --fail --silent --show-error \
  --header 'Content-Type: application/json' \
  --data '{"enableUserAuth":"false"}' \
  "$lingarr_url/api/auth/onboarding" \
  --output /dev/null

settings_payload=$(jq -n \
  --arg source_languages '[{"name":"English","code":"en"}]' \
  --arg target_languages '[{"name":"Albanian","code":"sq"}]' \
  '{
    source_languages: $source_languages,
    target_languages: $target_languages,
    service_type: "[\"libretranslate\"]",
    libretranslate_url: "http://libretranslate:5000",
    radarr_url: "http://radarr:7878",
    sonarr_url: "http://sonarr:8989",
    radarr_default_include: "true",
    sonarr_default_include: "true",
    # Refresh both libraries hourly, then translate one pending fallback ten
    # minutes later. Staggering prevents a library sync and a CPU-heavy
    # translation from starting at the same moment.
    movie_schedule: "0 * * * *",
    show_schedule: "0 * * * *",
    translation_schedule: "10 * * * *",
    max_translations_per_run: "3",
    movie_age_threshold: "0",
    show_age_threshold: "0",
    ignore_captions: "false"
  }')

curl --fail --silent --show-error \
  --header 'Content-Type: application/json' \
  --data "$settings_payload" \
  "$lingarr_url/api/setting/multiple/set" \
  --output /dev/null

for integration in radarr sonarr; do
  case "$integration" in
    radarr) api_key=$radarr_api_key ;;
    sonarr) api_key=$sonarr_api_key ;;
  esac
  encrypted_payload=$(jq -n --arg key "${integration}_api_key" --arg value "$api_key" '{key: $key, value: $value}')
  curl --fail --silent --show-error \
    --header 'Content-Type: application/json' \
    --data "$encrypted_payload" \
    "$lingarr_url/api/setting/encrypted" \
    --output /dev/null
done

# Enable the task only after both Arr integrations and its nightly settings are
# stored. The listener then checks hourly for up to three English-to-Albanian
# fallbacks after the hourly library index.
curl --fail --silent --show-error \
  --header 'Content-Type: application/json' \
  --data '{"key":"automation_enabled","value":"true"}' \
  "$lingarr_url/api/setting" \
  --output /dev/null

printf '%s\n' 'Lingarr is configured: library scan hourly; up to three fallback translations at :10 each hour.'
