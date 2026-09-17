export function aptInstallSnippet(config) {
  if (config?.schemaVersion !== 1
      || !/^(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64})$/.test(config.fingerprint ?? '')
      || typeof config.url !== 'string'
      || !/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?(?:\/[A-Za-z0-9._~-]+)*\/?$/.test(config.url)) {
    throw new Error('APT installation requires an approved HTTPS URL and full primary key fingerprint.')
  }
  const parsed = new URL(config.url)
  if (config.url.split('/').some((part) => part === '.' || part === '..')
      || !parsed.hostname.includes('.') || parsed.hostname.endsWith('.localhost')) {
    throw new Error('APT repository URL must be a public HTTPS address without relative path segments.')
  }
  const url = config.url.replace(/\/$/, '')
  const fingerprint = config.fingerprint.toUpperCase()
  return `bash <<'RUNLAB_DESKTOP_INSTALL'
set -euo pipefail
if [ "$(dpkg --print-architecture)" != amd64 ]; then
  printf '%s\\n' 'This desktop package supports amd64 only.' >&2
  exit 1
fi
sudo -v
sudo apt-get -o APT::Update::Error-Mode=any update
sudo apt-get install -y ca-certificates curl gnupg
tmp="$(mktemp -d)"
trap 'rm -f -- "$tmp/key.gpg" "$tmp/key-info"; rmdir -- "$tmp"' EXIT
curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --show-error --silent \\
  --connect-timeout 15 --max-time 120 \\
  '${url}/agent-runlab-desktop-archive-keyring.gpg' -o "$tmp/key.gpg"
gpg --no-options --batch --homedir "$tmp" --no-default-keyring \\
  --keyring /dev/null --trust-model always --no-auto-check-trustdb \\
  --lock-never --with-colons --show-keys \\
  "$tmp/key.gpg" > "$tmp/key-info"
actual="$(awk -F: '
  $1 == "pub" { count++; primary = 1; next }
  $1 == "sub" { primary = 0 }
  $1 == "fpr" && primary { print $10; primary = 0 }
  END { if (count != 1) exit 1 }
' "$tmp/key-info")"
if [ "$actual" != '${fingerprint}' ]; then
  printf '%s\\n' 'Repository signing-key fingerprint mismatch; source was not added.' >&2
  exit 1
fi
sudo install -d -m 0755 /etc/apt/keyrings
sudo install -m 0644 "$tmp/key.gpg" /etc/apt/keyrings/agent-runlab-desktop.gpg
printf '%s\\n' \\
  'Types: deb' \\
  'URIs: ${url}/' \\
  'Suites: stable' \\
  'Components: main' \\
  'Architectures: amd64' \\
  'Signed-By: /etc/apt/keyrings/agent-runlab-desktop.gpg' \\
  | sudo tee /etc/apt/sources.list.d/agent-runlab-desktop.sources >/dev/null
sudo apt-get -o APT::Update::Error-Mode=any update
sudo apt-get install -y agent-runlab-desktop
RUNLAB_DESKTOP_INSTALL`
}
