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
  rm -f -- "$tmp/kala-desktop_0.2.0~rc.18_amd64.deb" \
    "$tmp/0.2.0~rc.18-f383670c65e6fee252341de367b998fb2ff62096e808fd524a8674da4abc4673.dependencies.json" \
    "$tmp/0.2.0~rc.18-f383670c65e6fee252341de367b998fb2ff62096e808fd524a8674da4abc4673.SHA256SUMS.txt"
  rmdir -- "$tmp"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
curl --proto '=http,https' --tlsv1.2 --fail --show-error --silent \
  --connect-timeout 15 --max-time 120 \
  --output "$tmp/kala-desktop_0.2.0~rc.18_amd64.deb" \
  "$origin/install/assets/desktop-package.deb"
curl --proto '=http,https' --tlsv1.2 --fail --show-error --silent \
  --connect-timeout 15 --max-time 120 \
  --output "$tmp/0.2.0~rc.18-f383670c65e6fee252341de367b998fb2ff62096e808fd524a8674da4abc4673.dependencies.json" \
  "$origin/install/assets/desktop-dependencies.json"
curl --proto '=http,https' --tlsv1.2 --fail --show-error --silent \
  --connect-timeout 15 --max-time 120 \
  --output "$tmp/0.2.0~rc.18-f383670c65e6fee252341de367b998fb2ff62096e808fd524a8674da4abc4673.SHA256SUMS.txt" \
  "$origin/install/assets/desktop-SHA256SUMS.txt"
cd -- "$tmp"
# Verify every exact named file before reading the immutable checksum list.
printf '%s\n' \
  'f383670c65e6fee252341de367b998fb2ff62096e808fd524a8674da4abc4673  kala-desktop_0.2.0~rc.18_amd64.deb' \
  'e7fe78425962cbdb49a5ce98978b97795fec34cd4bb49ca6945953b01726d470  0.2.0~rc.18-f383670c65e6fee252341de367b998fb2ff62096e808fd524a8674da4abc4673.dependencies.json' \
  'b03eafc5f8b8708bf02616835b5a96da1ec68d3078cd3ee2d7b72322ce62463d  0.2.0~rc.18-f383670c65e6fee252341de367b998fb2ff62096e808fd524a8674da4abc4673.SHA256SUMS.txt' \
  | sha256sum --strict --check -
sha256sum --strict --check '0.2.0~rc.18-f383670c65e6fee252341de367b998fb2ff62096e808fd524a8674da4abc4673.SHA256SUMS.txt'
# The original downloaded file and home-directory permissions remain unchanged.
# Let APT's unprivileged _apt user read only the verified public package.
chmod 644 -- "$tmp/kala-desktop_0.2.0~rc.18_amd64.deb"
chmod 755 -- "$tmp"
sudo apt install -y -- "$tmp/kala-desktop_0.2.0~rc.18_amd64.deb"
