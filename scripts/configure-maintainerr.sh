#!/usr/bin/env sh
# Configure Jellyfin, Radarr, Sonarr, and two safe Maintainerr preview rules.
# Both rules use Maintainerr's explicit "Do nothing" action (value 4): no
# media is deleted, no Arr item is unmonitored, and no files are touched.
set -eu

maintainerr_url='http://127.0.0.1:6246'
stack_dir='/srv/media-stack'
jellyseerr_settings="$stack_dir/config/jellyseerr/settings.json"
radarr_config="$stack_dir/config/radarr/config.xml"
sonarr_config="$stack_dir/config/sonarr/config.xml"

api_get() {
  curl --fail --silent --show-error --connect-timeout 5 --max-time 30 \
    "$maintainerr_url/api$1"
}

api_post() {
  endpoint=$1
  payload=$2
  curl --fail --silent --show-error --connect-timeout 5 --max-time 30 \
    --header 'Content-Type: application/json' \
    --data "$payload" \
    "$maintainerr_url/api$endpoint"
}

require_success() {
  response=$1
  label=$2
  if ! printf '%s' "$response" | jq -e '.code == 1' >/dev/null; then
    printf '%s\n' "Maintainerr did not accept: $label." >&2
    exit 1
  fi
}

for attempt in $(seq 1 90); do
  if curl --fail --silent --output /dev/null "$maintainerr_url/api/health/ready"; then
    break
  fi
  if [ "$attempt" -eq 90 ]; then
    printf '%s\n' 'Maintainerr did not become ready within 180 seconds.' >&2
    exit 1
  fi
  sleep 2
done

jellyfin_api_key=$(jq -r '.jellyfin.apiKey // empty' "$jellyseerr_settings")
radarr_api_key=$(sed -n 's:.*<ApiKey>\(.*\)</ApiKey>.*:\1:p' "$radarr_config")
sonarr_api_key=$(sed -n 's:.*<ApiKey>\(.*\)</ApiKey>.*:\1:p' "$sonarr_config")

if [ -z "$jellyfin_api_key" ] || [ -z "$radarr_api_key" ] || [ -z "$sonarr_api_key" ]; then
  printf '%s\n' 'Could not read the existing Jellyfin, Radarr, or Sonarr API key.' >&2
  exit 1
fi

settings=$(api_get '/settings')
media_server_type=$(printf '%s' "$settings" | jq -r '.media_server_type // empty')
case "$media_server_type" in
  '')
    response=$(api_post '/settings/media-server/switch' '{"targetServerType":"jellyfin"}')
    require_success "$response" 'select Jellyfin as the media server'
    ;;
  jellyfin) ;;
  *)
    printf '%s\n' "Maintainerr is already configured for $media_server_type, not Jellyfin. It was left unchanged." >&2
    exit 1
    ;;
esac

jellyfin_settings=$(api_get '/settings/jellyfin')
configured_jellyfin_url=$(printf '%s' "$jellyfin_settings" | jq -r '.jellyfin_url // empty')
configured_jellyfin_key=$(printf '%s' "$jellyfin_settings" | jq -r '.jellyfin_api_key // empty')
configured_jellyfin_user=$(printf '%s' "$jellyfin_settings" | jq -r '.jellyfin_user_id // empty')

if [ -z "$configured_jellyfin_url" ] || [ -z "$configured_jellyfin_key" ] || [ -z "$configured_jellyfin_user" ]; then
  jellyfin_test_payload=$(jq -n \
    --arg url 'http://jellyfin:8096' \
    --arg key "$jellyfin_api_key" \
    '{jellyfin_url: $url, jellyfin_api_key: $key}')
  jellyfin_test=$(api_post '/settings/jellyfin/test' "$jellyfin_test_payload")
  require_success "$jellyfin_test" 'test the Jellyfin connection'
  jellyfin_user_id=$(printf '%s' "$jellyfin_test" | jq -r '.users | sort_by(.name) | .[0].id // empty')
  if [ -z "$jellyfin_user_id" ]; then
    printf '%s\n' 'Maintainerr could not find a Jellyfin administrator to use for the preview rules.' >&2
    exit 1
  fi
  jellyfin_save_payload=$(jq -n \
    --arg url 'http://jellyfin:8096' \
    --arg key "$jellyfin_api_key" \
    --arg user_id "$jellyfin_user_id" \
    '{jellyfin_url: $url, jellyfin_api_key: $key, jellyfin_user_id: $user_id}')
  response=$(api_post '/settings/jellyfin' "$jellyfin_save_payload")
  require_success "$response" 'save the Jellyfin connection'
  printf '%s\n' 'Maintainerr: Jellyfin connection configured.'
else
  printf '%s\n' 'Maintainerr: existing Jellyfin connection kept.'
fi

ensure_servarr() {
  service=$1
  display_name=$2
  service_url=$3
  api_key=$4
  existing=$(api_get "/settings/$service")
  setting_id=$(printf '%s' "$existing" | jq -r --arg url "$service_url" '[.[] | select(.url == $url)] | .[0].id // empty')
  if [ -z "$setting_id" ]; then
    payload=$(jq -n \
      --arg server_name "$display_name" \
      --arg url "$service_url" \
      --arg key "$api_key" \
      '{serverName: $server_name, url: $url, apiKey: $key}')
    response=$(api_post "/settings/$service" "$payload")
    require_success "$response" "save the $display_name connection"
    setting_id=$(printf '%s' "$response" | jq -r '.data.id // empty')
    if [ -z "$setting_id" ]; then
      printf '%s\n' "Maintainerr did not return the saved $display_name connection ID." >&2
      exit 1
    fi
    printf '%s\n' "Maintainerr: $display_name connection configured." >&2
  else
    printf '%s\n' "Maintainerr: existing $display_name connection kept." >&2
  fi
  printf '%s' "$setting_id"
}

radarr_setting_id=$(ensure_servarr radarr Radarr 'http://radarr:7878' "$radarr_api_key")
sonarr_setting_id=$(ensure_servarr sonarr Sonarr 'http://sonarr:8989' "$sonarr_api_key")

libraries=$(api_get '/media-server/libraries')
movie_library_count=$(printf '%s' "$libraries" | jq '[.[] | select((.type | ascii_downcase) == "movie")] | length')
show_library_count=$(printf '%s' "$libraries" | jq '[.[] | select((.type | ascii_downcase) == "show")] | length')

if [ "$movie_library_count" -ne 1 ] || [ "$show_library_count" -ne 1 ]; then
  printf '%s\n' 'Expected exactly one movie library and one show library. No preview rules were created.' >&2
  printf '%s\n' 'Open Maintainerr on the LAN and choose the correct libraries, then ask me to finish the rule setup.' >&2
  exit 1
fi

movie_library_id=$(printf '%s' "$libraries" | jq -r '[.[] | select((.type | ascii_downcase) == "movie")] | .[0].id')
show_library_id=$(printf '%s' "$libraries" | jq -r '[.[] | select((.type | ascii_downcase) == "show")] | .[0].id')

# Resolve the current Maintainerr IDs for Jellyfin's "Last view date"
# property instead of assuming an internal numeric ID from a past release.
rule_constants=$(api_get '/rules/constants')
jellyfin_application_id=$(printf '%s' "$rule_constants" | jq -r '[.applications[] | select(((.name // "") | ascii_downcase) == "jellyfin")] | .[0].id // empty')

if [ -z "$jellyfin_application_id" ]; then
  printf '%s\n' 'Maintainerr could not resolve its Jellyfin rule application. No preview rules were created.' >&2
  exit 1
fi

last_view_property_id=$(printf '%s' "$rule_constants" | jq -r --argjson app_id "$jellyfin_application_id" '[.applications[] | select(.id == $app_id) | .props[] | select((((.name // .key // .label // "") | tostring | ascii_downcase) | test("last.*view")))] | .[0].id // empty')

if [ -z "$last_view_property_id" ]; then
  printf '%s\n' 'Maintainerr could not resolve the Jellyfin Last view date rule property. No preview rules were created.' >&2
  exit 1
fi

ensure_preview_rule() {
  rule_name=$1
  description=$2
  library_id=$3
  data_type=$4
  manager=$5
  manager_id=$6
  age_seconds=$7

  existing_rules=$(api_get '/rules')
  existing_id=$(printf '%s' "$existing_rules" | jq -r --arg name "$rule_name" '[.[] | select(.name == $name)] | .[0].id // empty')
  if [ -n "$existing_id" ]; then
    printf '%s\n' "Maintainerr: existing preview rule kept: $rule_name."
    return
  fi

  payload=$(jq -n \
    --arg name "$rule_name" \
    --arg description "$description" \
    --arg library_id "$library_id" \
    --arg data_type "$data_type" \
    --arg manager "$manager" \
    --argjson manager_id "$manager_id" \
    --argjson age_seconds "$age_seconds" \
    --argjson jellyfin_application_id "$jellyfin_application_id" \
    --argjson last_view_property_id "$last_view_property_id" \
    '{
      name: $name,
      description: $description,
      libraryId: $library_id,
      arrAction: 4,
      dataType: $data_type,
      isActive: true,
      useRules: true,
      listExclusions: true,
      cleanupLeftoverFolders: false,
      forceSeerr: false,
      tagInArr: false,
      collection: {
        visibleOnRecommended: false,
        visibleOnHome: false,
        overlayEnabled: false,
        overlayTemplateId: null,
        manualCollection: false,
        keepLogsForMonths: 6
      },
      rules: [{
        operator: null,
        firstVal: [$jellyfin_application_id, $last_view_property_id],
        action: 5,
        customVal: {ruleTypeId: 0, value: $age_seconds},
        section: 0
      }],
      notifications: [],
      ruleHandlerCronSchedule: "20 3 * * *"
    } + (if $manager == "radarr" then {radarrSettingsId: $manager_id} else {sonarrSettingsId: $manager_id} end)')

  response=$(api_post '/rules' "$payload")
  require_success "$response" "create the preview rule $rule_name"
  created_rules=$(api_get '/rules')
  created_id=$(printf '%s' "$created_rules" | jq -r --arg name "$rule_name" '[.[] | select(.name == $name)] | .[0].id // empty')
  if [ -z "$created_id" ]; then
    printf '%s\n' "Maintainerr created $rule_name but its ID could not be read for the initial preview scan." >&2
    exit 1
  fi

  # Populate the review collection now. arrAction 4 (Do nothing) makes this
  # a metadata-only scan: it cannot delete files or change monitoring.
  api_post "/rules/$created_id/execute" '{}' >/dev/null
  printf '%s\n' "Maintainerr: preview rule created and its first scan started: $rule_name."
}

ensure_preview_rule \
  'Preview - watched movies cleanup' \
  'Review only: movies with a completed last view more than 30 days ago. Do nothing; no files or monitoring are changed.' \
  "$movie_library_id" movie radarr "$radarr_setting_id" 2592000

ensure_preview_rule \
  'Preview - watched TV episodes cleanup' \
  'Review only: episodes with a completed last view more than 14 days ago. Do nothing; no files or monitoring are changed.' \
  "$show_library_id" episode sonarr "$sonarr_setting_id" 1209600

lan_ip=$(awk -F= '$1 == "JELLYFIN_LAN_IP" { print $2; exit }' "$stack_dir/.env")
printf '%s\n' "Maintainerr is ready for safe review at: http://$lan_ip:6246"
printf '%s\n' 'Both new rules are set to Do nothing. No media has been deleted or unmonitored.'
