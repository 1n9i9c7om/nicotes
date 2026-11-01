#!/bin/sh
# CI: creates the GitLab release for tag $CI_COMMIT_TAG with its CHANGELOG.md notes and links
# the extension packages (version $EXTENSION_VERSION, which can be older than the release)
# uploaded by the package jobs. Re-running it only adds missing links. Needs curl and jq.
set -eu
version="${CI_COMMIT_TAG#v}"
extension="${EXTENSION_VERSION:-$version}"
api="$CI_API_V4_URL/projects/$CI_PROJECT_ID"
packages="$api/packages/generic/$EXTENSION_PACKAGE/$extension"

notes="$(sh scripts/release-notes.sh "$version")"
[ -n "$notes" ] || notes="See CHANGELOG.md."

# The package jobs upload the .zip always and the signed .xpi only when AMO keys are set.
links='[]'
add_link() {
  name="$1"
  file="$2"
  if curl -sf -o /dev/null --header "JOB-TOKEN: $CI_JOB_TOKEN" "$packages/$file"; then
    links="$(printf '%s' "$links" | jq -c --arg name "$name" --arg url "$packages/$file" --arg path "/$file" \
      '. + [{name: $name, url: $url, direct_asset_path: $path, link_type: "package"}]')"
  fi
}
add_link "Browser extension $extension for Firefox (signed)" "nicotes-extension-$extension.xpi"
add_link "Browser extension $extension (zip, unsigned)" "nicotes-extension-$extension.zip"

body="$(jq -n --arg tag "$CI_COMMIT_TAG" --arg name "Nicotes $version" --arg notes "$notes" --argjson links "$links" \
  '{tag_name: $tag, name: $name, description: $notes, assets: {links: $links}}')"
status="$(curl -s -o response.json -w '%{http_code}' --header "JOB-TOKEN: $CI_JOB_TOKEN" \
  --header 'Content-Type: application/json' --data "$body" "$api/releases")"

if [ "$status" = 201 ]; then
  echo "Created release $CI_COMMIT_TAG with $(printf '%s' "$links" | jq length) asset link(s)."
elif [ "$status" = 409 ]; then
  echo "Release $CI_COMMIT_TAG exists; adding missing asset links."
  existing="$(curl -sf --header "JOB-TOKEN: $CI_JOB_TOKEN" "$api/releases/$CI_COMMIT_TAG/assets/links" | jq -r '.[].name')"
  printf '%s' "$links" | jq -c '.[]' | while read -r link; do
    name="$(printf '%s' "$link" | jq -r .name)"
    if printf '%s\n' "$existing" | grep -qxF "$name"; then continue; fi
    curl -sf -o /dev/null --header "JOB-TOKEN: $CI_JOB_TOKEN" --header 'Content-Type: application/json' \
      --data "$link" "$api/releases/$CI_COMMIT_TAG/assets/links"
    echo "Added $name."
  done
else
  echo "Creating the release failed (HTTP $status):"
  cat response.json
  exit 1
fi
