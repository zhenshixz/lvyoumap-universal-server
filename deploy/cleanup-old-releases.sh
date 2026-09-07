#!/usr/bin/env bash
set -euo pipefail

base="/opt/lvyoumap"
releases="${base}/releases"
current="${base}/current"
keep_releases="${LVYOUMAP_KEEP_RELEASES:-3}"
apply="${1:-}"

if [[ ! "${keep_releases}" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid LVYOUMAP_KEEP_RELEASES: ${keep_releases}" >&2
  exit 1
fi
if [[ "$(readlink -f "${releases}")" != "${releases}" ]]; then
  echo "Unexpected releases path: ${releases}" >&2
  exit 1
fi

current_target="$(readlink -f "${current}")"
if [[ "${current_target}" != "${releases}/"* ]] || [[ ! -d "${current_target}" ]]; then
  echo "Current release is outside ${releases}: ${current_target}" >&2
  exit 1
fi

declare -A protected_releases=(["${current_target}"]=1)
protected_count=1
mapfile -t release_dirs < <(
  find "${releases}" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' |
    sort -nr |
    cut -d' ' -f2-
)

delete_count=0
for candidate in "${release_dirs[@]}"; do
  name="$(basename "${candidate}")"
  if [[ ! "${name}" =~ ^[a-f0-9]{7,64}$ ]]; then
    echo "Skip unexpected release directory: ${candidate}" >&2
    continue
  fi
  if [[ -n "${protected_releases[${candidate}]:-}" ]]; then
    echo "KEEP current ${name}"
    continue
  fi
  if (( protected_count < keep_releases )); then
    protected_releases["${candidate}"]=1
    ((protected_count += 1))
    echo "KEEP rollback ${name}"
    continue
  fi
  ((delete_count += 1))
  if [[ "${apply}" == "--apply" ]]; then
    rm -rf -- "${candidate}"
    echo "DELETE ${name}"
  else
    echo "WOULD_DELETE ${name}"
  fi
done

echo "Old releases selected: ${delete_count}"
if [[ "${apply}" != "--apply" ]]; then
  echo "Dry run only. Re-run with --apply to delete them."
fi
