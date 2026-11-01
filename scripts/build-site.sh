#!/bin/sh
# Assembles the landing page (site/) with the logo and screenshots from docs/ into <outdir>.
# Usage: sh scripts/build-site.sh <outdir> <version>
set -eu

if [ "$#" -ne 2 ]; then
  echo "Usage: sh scripts/build-site.sh <outdir> <version>" >&2
  exit 1
fi
out="$1"
version="$2"

mkdir -p "$out/images" "$out/brand"
cp -R site/. "$out/"
cp -R docs/images/. "$out/images/"
cp -R docs/brand/. "$out/brand/"
sed -i "s/{{VERSION}}/$version/g" "$out/index.html"
# security.txt must expire within a year; every deployment renews it.
expires="$(date -u -d "@$(($(date +%s) + 365 * 24 * 3600))" +%Y-%m-%dT%H:%M:%SZ)"
sed -i "s/{{EXPIRES}}/$expires/" "$out/.well-known/security.txt"
