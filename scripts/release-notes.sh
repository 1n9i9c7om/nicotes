#!/bin/sh
# Prints the CHANGELOG.md section of one version, without its heading.
# Usage: scripts/release-notes.sh 1.2.3 [CHANGELOG.md]
set -eu
version="$1"
file="${2:-CHANGELOG.md}"
awk -v version="$version" '
  /^## / { if (found) exit; found = index($0, "## " version " ") == 1 || $0 == "## " version; next }
  found { print }
' "$file" | sed -e '/./,$!d' | sed -e ':a' -e '/^\n*$/{$d;N;ba' -e '}'
