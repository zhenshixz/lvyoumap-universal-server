#!/usr/bin/env bash
set -euo pipefail

archive="${1:-}"
version="${2:-}"
base="/opt/lvyoumap"
releases="${base}/releases"
current="${base}/current"

if [[ ! "${version}" =~ ^[a-f0-9]{7,64}$ ]]; then
  echo "Invalid release version: ${version}" >&2
  exit 1
fi
if [[ "${archive}" != /tmp/lvyoumap-release-*.tar.gz ]] || [[ ! -f "${archive}" ]]; then
  echo "Invalid or missing release archive: ${archive}" >&2
  exit 1
fi

release="${releases}/${version}"
previous=""
if [[ -L "${current}" ]]; then
  previous="$(readlink -f "${current}")"
fi

mkdir -p "${releases}"
if [[ -e "${release}" ]]; then
  echo "Release already exists: ${release}" >&2
  exit 1
fi

if tar -tzf "${archive}" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "Release archive contains an unsafe path." >&2
  exit 1
fi

mkdir -p "${release}"
tar -xzf "${archive}" -C "${release}"
rm -f "${archive}"

for required in dist/index.html server/index.js package.json; do
  if [[ ! -f "${release}/${required}" ]]; then
    echo "Release is missing ${required}" >&2
    rm -rf -- "${release}"
    exit 1
  fi
done

chown -R deploy:lvyoumap "${release}"
find "${release}" -type d -exec chmod 0755 {} +
find "${release}" -type f -exec chmod 0644 {} +
ln -sfn "${release}" "${current}.new"
mv -Tf "${current}.new" "${current}"

systemctl restart lvyoumap.service

healthy=0
for _ in {1..20}; do
  if curl --fail --silent --max-time 2 http://127.0.0.1:3000/api/health >/dev/null \
    && curl --fail --silent --max-time 2 http://127.0.0.1:3000/ >/dev/null; then
    healthy=1
    break
  fi
  sleep 1
done

if [[ "${healthy}" -ne 1 ]]; then
  echo "Health check failed; rolling back." >&2
  if [[ -n "${previous}" && -d "${previous}" ]]; then
    ln -sfn "${previous}" "${current}.new"
    mv -Tf "${current}.new" "${current}"
    systemctl restart lvyoumap.service
  fi
  rm -rf -- "${release}"
  exit 1
fi

echo "Activated ${version}"
