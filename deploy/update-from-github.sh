#!/usr/bin/env bash
set -euo pipefail

repository="${LVYOUMAP_REPOSITORY:-https://github.com/zhenshixz/lvyoumap-universal-server.git}"
branch="${LVYOUMAP_BRANCH:-main}"
base="/opt/lvyoumap"
current="${base}/current"
mirror="/var/lib/lvyoumap/repository.git"

exec 9>/run/lock/lvyoumap-update.lock
if ! flock -n 9; then
  echo "Another update is already running."
  exit 0
fi

remote_sha="$(
  git ls-remote --heads "${repository}" "refs/heads/${branch}" |
    awk 'NR == 1 { print $1 }'
)"
if [[ ! "${remote_sha}" =~ ^[a-f0-9]{40}$ ]]; then
  echo "Could not resolve ${repository} branch ${branch}." >&2
  exit 1
fi

if [[ -L "${current}" ]] && [[ "$(basename "$(readlink -f "${current}")")" == "${remote_sha}" ]]; then
  echo "Already running ${remote_sha}."
  exit 0
fi

workdir="$(mktemp -d /tmp/lvyoumap-update.XXXXXX)"
archive="/tmp/lvyoumap-release-${remote_sha}.tar.gz"
cleanup() {
  rm -rf -- "${workdir}"
  rm -f -- "${archive}"
}
trap cleanup EXIT

if [[ ! -e "${mirror}" ]]; then
  git clone --mirror "${repository}" "${mirror}"
elif ! git -C "${mirror}" rev-parse --is-bare-repository >/dev/null 2>&1; then
  invalid_mirror="${mirror}.invalid.$(date +%s)"
  mv "${mirror}" "${invalid_mirror}"
  echo "Moved an invalid repository cache to ${invalid_mirror}."
  git clone --mirror "${repository}" "${mirror}"
fi

git -C "${mirror}" remote set-url origin "${repository}"
git -C "${mirror}" fetch --prune --no-tags origin \
  "+refs/heads/${branch}:refs/heads/${branch}"
resolved_sha="$(git -C "${mirror}" rev-parse "refs/heads/${branch}")"
if [[ "${resolved_sha}" != "${remote_sha}" ]]; then
  echo "Repository changed during fetch; retry on the next update." >&2
  exit 1
fi

mkdir -p "${workdir}/source"
git -C "${mirror}" archive "${resolved_sha}" |
  tar -xf - -C "${workdir}/source"

(
  cd "${workdir}/source"
  npm ci
  npm run verify
  tar -czf "${archive}" dist server package.json package-lock.json
)

/usr/local/sbin/lvyoumap-activate "${archive}" "${remote_sha}"
