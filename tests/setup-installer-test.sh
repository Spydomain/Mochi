#!/usr/bin/env bash
# No packages, services or radios: exercise bootstrap and declarative config.
set -euo pipefail
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d -p "${TMPDIR:-/tmp}" mochi-installer-test.XXXXXXXX)"
trap 'rm -rf -- "$tmp"' EXIT
source "$repo/windows/scripts/airdrop-install-common.sh"

# A piped script must select the clone target even when cwd is a checkout.
bootstrap="$(sed '/^run_as_root() {/,$d' "$repo/mochi-full-setup.sh")"
output="$(MOCHI_DIR="$tmp/clone" bash -s <<< "$bootstrap"$'\nprintf "%s\\n" "$MOCHI_DIR"')"
[[ "$output" == "$tmp/clone" ]]
output="$(env -u MOCHI_DIR bash -s <<< "$bootstrap"$'\nprintf "%s\\n" "$MOCHI_DIR"')"
[[ "$output" == "$HOME/mochi" ]]

config="$tmp/config"
hook="$tmp/path with spaces/mochi-airdrop-confirm"
printf '%s\n' 'AIRDROP_MODE="${AIRDROP_MODE:-shared}"' 'RECV_DIR="${RECV_DIR:-$HOME/Downloads}"' > "$config"
airdrop_config normalize "$config" "$hook"
airdrop_config verify "$config" "$hook"
cp "$config" "$tmp/first"
airdrop_config normalize "$config" "$hook"
cmp "$config" "$tmp/first"

# A valid config cannot certify an old consent protocol or a nonexecutable hook.
mkdir -p "$(dirname "$hook")"
printf '#!/usr/bin/env bash\n# old unbound accept protocol\n' > "$hook"
chmod 755 "$hook"
if airdrop_verify_consent "$config" "$hook" "$repo/windows/scripts/mochi-airdrop-confirm.sh"; then
  echo 'Old consent hook passed backend verification.' >&2; exit 1
fi
install -m 755 "$repo/windows/scripts/mochi-airdrop-confirm.sh" "$hook"
airdrop_verify_consent "$config" "$hook" "$repo/windows/scripts/mochi-airdrop-confirm.sh"
chmod 644 "$hook"
if airdrop_verify_consent "$config" "$hook" "$repo/windows/scripts/mochi-airdrop-confirm.sh"; then
  echo 'Nonexecutable consent hook passed backend verification.' >&2; exit 1
fi

for identity in 'MOCHI_AIRDROP_SERVICE_ID="012345abcdef"' \
                $'MOCHI_AIRDROP_SERVICE_ID="012345abcdef"\nexport MOCHI_AIRDROP_SERVICE_ID' \
                'export MOCHI_AIRDROP_SERVICE_ID="012345abcdef"'; do
  printf '%s\n' "$identity" > "$config"
  airdrop_config normalize "$config" "$hook"
  airdrop_config verify "$config" "$hook"
  grep -Fqx 'export MOCHI_AIRDROP_SERVICE_ID="012345abcdef"' "$config"
  cp "$config" "$tmp/identity"
  airdrop_config normalize "$config" "$hook"
  cmp "$config" "$tmp/identity"
done

printf 'export AIRDROP_CONFIRM="%s"\nexport MOCHI_AIRDROP_SERVICE_ID="012345abcdef"\n' "$hook" > "$config"
airdrop_config verify "$config" "$hook"

# Unsupported executable shell syntax is rejected, never evaluated. Test both
# verification and normalization, and prove refusal preserves every byte.
for override in 'AIRDROP_CONFIRM=/usr/bin/true' \
                'export AIRDROP_CONFIRM=/usr/bin/true' \
                'AIRDROP_CONFIRM="${AIRDROP_CONFIRM:-/usr/bin/true}"' \
                'export AIRDROP_CONFIRM=/usr/bin/true; true' \
                'unset AIRDROP_CONFIRM' \
                'source /some/other/config' \
                'eval "AIRDROP_CONFIRM=/usr/bin/true"' \
                'if true; then AIRDROP_CONFIRM=/usr/bin/true; fi' \
                'AIRDROP_CONFIRM=$(touch "$MOCHI_TEST_SENTINEL")' \
                'OTHER="${AIRDROP_CONFIRM:=/usr/bin/true}"' \
                'OTHER="${AIRDROP_CONFIRM@P}"' \
                'export MOCHI_AIRDROP_SERVICE_ID="invalid"'; do
  cp "$tmp/first" "$config"
  printf '%s\n' "$override" >> "$config"
  cp "$config" "$tmp/rejected"
  for mode in verify normalize; do
    if MOCHI_TEST_SENTINEL="$tmp/executed" airdrop_config "$mode" "$config" "$hook" > "$tmp/error" 2>&1; then
      printf 'Accepted unsafe %s config: %s\n' "$mode" "$override" >&2
      exit 1
    fi
    cmp "$config" "$tmp/rejected"
    [[ ! -e "$tmp/executed" ]]
  done
done
# Literal path characters must round-trip through the generated shell quoting.
hook="$tmp/it's a literal \$(not-a-command)/mochi-airdrop-confirm"
printf '# empty config\n' > "$config"
airdrop_config normalize "$config" "$hook"
airdrop_config verify "$config" "$hook"
printf 'Stdin bootstrap, consent override refusal, persistent identity and idempotent config checks passed.\n'
