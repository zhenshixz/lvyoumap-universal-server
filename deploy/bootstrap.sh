#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

deploy_public_key="${DEPLOY_PUBLIC_KEY:-}"
if [[ -z "${deploy_public_key}" || "${deploy_public_key}" != ssh-* ]]; then
  echo "Set DEPLOY_PUBLIC_KEY to the dedicated GitHub Actions public key." >&2
  exit 1
fi

for command in node npm git systemctl tar curl flock; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "Required command is missing: ${command}" >&2
    exit 1
  fi
done

node_major="$(node -p "Number(process.versions.node.split('.')[0])")"
if [[ "${node_major}" -lt 24 ]]; then
  echo "Node.js 24 LTS or newer is required." >&2
  exit 1
fi

node_path="$(command -v node)"
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

id lvyoumap >/dev/null 2>&1 || useradd --system --home /var/lib/lvyoumap --shell /usr/sbin/nologin lvyoumap
id deploy >/dev/null 2>&1 || useradd --create-home --shell /bin/bash deploy

install -d -o deploy -g lvyoumap -m 0755 /opt/lvyoumap /opt/lvyoumap/releases
install -d -o lvyoumap -g lvyoumap -m 0750 /var/lib/lvyoumap
install -d -o deploy -g deploy -m 0700 /home/deploy/.ssh
printf '%s\n' "${deploy_public_key}" > /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 0600 /home/deploy/.ssh/authorized_keys

sed "s|__NODE_PATH__|${node_path}|g" \
  "${project_root}/deploy/lvyoumap.service.template" \
  > /etc/systemd/system/lvyoumap.service
install -o root -g root -m 0755 \
  "${project_root}/deploy/activate-release.sh" \
  /usr/local/sbin/lvyoumap-activate
install -o root -g root -m 0755 \
  "${project_root}/deploy/update-from-github.sh" \
  /usr/local/sbin/lvyoumap-update
install -o root -g root -m 0644 \
  "${project_root}/deploy/lvyoumap-update.service" \
  /etc/systemd/system/lvyoumap-update.service
install -o root -g root -m 0644 \
  "${project_root}/deploy/lvyoumap-update.timer" \
  /etc/systemd/system/lvyoumap-update.timer

cat > /etc/sudoers.d/lvyoumap-deploy <<'EOF'
deploy ALL=(root) NOPASSWD: /usr/local/sbin/lvyoumap-activate
EOF
chmod 0440 /etc/sudoers.d/lvyoumap-deploy

if [[ ! -f /etc/lvyoumap.env ]]; then
  install -o root -g root -m 0600 "${project_root}/.env.example" /etc/lvyoumap.env
fi

systemctl daemon-reload
systemctl enable lvyoumap.service
systemctl enable lvyoumap-update.timer

echo "Bootstrap completed."
echo "Next: configure /etc/lvyoumap.env and Nginx, then start lvyoumap-update.timer."
