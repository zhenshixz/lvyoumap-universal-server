#!/usr/bin/env bash
set -euo pipefail

repository="${LVYOUMAP_REPOSITORY:-https://github.com/zhenshixz/lvyoumap-universal-server.git}"
branch="${LVYOUMAP_BRANCH:-main}"
base="/opt/lvyoumap"
current="${base}/current"

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

git clone --depth 1 --branch "${branch}" --single-branch "${repository}" "${workdir}/source"
resolved_sha="$(git -C "${workdir}/source" rev-parse HEAD)"
if [[ "${resolved_sha}" != "${remote_sha}" ]]; then
  echo "Repository changed during checkout; retry on the next update." >&2
  exit 1
fi

(
  cd "${workdir}/source"
  npm ci
  npm run verify
  tar -czf "${archive}" dist server package.json package-lock.json
)

/usr/local/sbin/lvyoumap-activate "${archive}" "${remote_sha}"
