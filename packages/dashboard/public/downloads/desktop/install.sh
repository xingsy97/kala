# KALA_DESKTOP_INSTALLER_V1
set -euo pipefail
# Checksums detect corruption, not publisher identity. Trust this deployment.
# This unsigned .deb does not configure automatic updates.
for tool in sha256sum dpkg sudo mktemp chmod; do
  command -v "$tool" >/dev/null || { printf 'Required tool missing: %s\n' "$tool" >&2; exit 1; }
done
if [ "$(dpkg --print-architecture)" != amd64 ]; then
  printf '%s\n' 'This desktop package supports amd64 only.' >&2
  exit 1
fi
origin="${1:-}"
case "$origin" in
  https://*|http://localhost:*|http://127.0.0.1:*|http://\[::1\]:*) ;;
  *) printf '%s\n' 'A trusted HTTPS origin is required.' >&2; exit 1 ;;
esac
if ! command -v curl >/dev/null; then
  sudo apt-get -o APT::Update::Error-Mode=any update
  sudo apt-get install -y ca-certificates curl
fi
# Keep downloads in a private temporary directory, removed on success or failure.
umask 077
tmp="$(mktemp -d /tmp/agent-runlab-install.XXXXXXXXXX)"
cleanup() {
  rm -f -- "$tmp/kala-desktop_0.2.0~rc.12_amd64.deb" \
    "$tmp/0.2.0~rc.12-ac34d40e0cb6972ecceef3a4204a6753f181b16252f9e600707e689954902039.dependencies.json" \
    "$tmp/0.2.0~rc.12-ac34d40e0cb6972ecceef3a4204a6753f181b16252f9e600707e689954902039.SHA256SUMS.txt"
  rmdir -- "$tmp"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
curl --proto '=http,https' --tlsv1.2 --fail --show-error --silent \
  --connect-timeout 15 --max-time 120 \
  --output "$tmp/kala-desktop_0.2.0~rc.12_amd64.deb" \
  "$origin/install/assets/desktop-package.deb"
curl --proto '=http,https' --tlsv1.2 --fail --show-error --silent \
  --connect-timeout 15 --max-time 120 \
  --output "$tmp/0.2.0~rc.12-ac34d40e0cb6972ecceef3a4204a6753f181b16252f9e600707e689954902039.dependencies.json" \
  "$origin/install/assets/desktop-dependencies.json"
curl --proto '=http,https' --tlsv1.2 --fail --show-error --silent \
  --connect-timeout 15 --max-time 120 \
  --output "$tmp/0.2.0~rc.12-ac34d40e0cb6972ecceef3a4204a6753f181b16252f9e600707e689954902039.SHA256SUMS.txt" \
  "$origin/install/assets/desktop-SHA256SUMS.txt"
cd -- "$tmp"
# Verify every exact named file before reading the immutable checksum list.
printf '%s\n' \
  'ac34d40e0cb6972ecceef3a4204a6753f181b16252f9e600707e689954902039  kala-desktop_0.2.0~rc.12_amd64.deb' \
  'da440c868ab34be5338900a6762f1617336de244db7a7d22cb7ce00c53323389  0.2.0~rc.12-ac34d40e0cb6972ecceef3a4204a6753f181b16252f9e600707e689954902039.dependencies.json' \
  'f8b5e3943ec3946b5be8c78c9aa271a83a8bffb9e431d7ca59a5c683b86bf0ff  0.2.0~rc.12-ac34d40e0cb6972ecceef3a4204a6753f181b16252f9e600707e689954902039.SHA256SUMS.txt' \
  | sha256sum --strict --check -
sha256sum --strict --check '0.2.0~rc.12-ac34d40e0cb6972ecceef3a4204a6753f181b16252f9e600707e689954902039.SHA256SUMS.txt'
# The original downloaded file and home-directory permissions remain unchanged.
# Let APT's unprivileged _apt user read only the verified public package.
chmod 644 -- "$tmp/kala-desktop_0.2.0~rc.12_amd64.deb"
chmod 755 -- "$tmp"
sudo apt install -y -- "$tmp/kala-desktop_0.2.0~rc.12_amd64.deb"
