#!/usr/bin/env bash
# Pushes the demo repository (fixtures/demo-repo, built by scripts/make-demo-repo.sh) to a new, empty, PUBLIC GitHub
# repository you created, so the hosted demo on Render can clone it over https.
#
# Usage: scripts/render-push-demo-repo.sh https://github.com/<you>/<repo>.git
#
# Pushes main and the delivery branches (m1-pass, m2-partial, m2-injection). The repository must be empty: this script
# never force-pushes. git asks for your GitHub credentials as usual (a credential helper, or a token as the password).
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 https://github.com/<you>/<repo>.git" >&2
  exit 1
fi
URL="$1"
case "$URL" in
  https://*) ;;
  *) echo "the hosted demo clones https only; give the repository's https URL (got: $URL)" >&2; exit 1 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/milestone-demo-repo.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

"$SCRIPT_DIR/make-demo-repo.sh" "$WORK/repo"
cd "$WORK/repo"
git checkout -q main
git remote add origin "$URL"
git push origin main m1-pass m2-partial m2-injection

# Public check: an anonymous ls-remote must see main, as the Render worker will.
if GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false git -c credential.helper= ls-remote --heads "$URL" main >/dev/null 2>&1; then
  echo "pushed; anonymous https clone works: deliver from $URL (refs m1-pass, m2-partial, m2-injection)"
else
  echo "pushed, but an anonymous clone failed: make the repository public on GitHub, or the hosted worker cannot fetch it" >&2
  exit 2
fi
