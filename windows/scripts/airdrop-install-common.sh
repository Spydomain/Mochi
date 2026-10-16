#!/usr/bin/env bash
# Shared installer helpers. Sourcing this file does not inspect or change a radio.

airdrop_install_lock() {
  local rundir="${XDG_RUNTIME_DIR:-/tmp}/airdropd" lock inherited fd previous_umask
  lock="$rundir/lock"
  (umask 077; mkdir -p -- "$rundir") || return 1
  [[ -d "$rundir" && ! -L "$rundir" && -O "$rundir" &&
     $(stat -c %a "$rundir") =~ ^[0-7]*[0145][0145]$ ]] || {
    printf 'Unsafe AirDrop runtime directory: %s\n' "$rundir" >&2; return 1;
  }
  [[ ! -L "$lock" && ( ! -e "$lock" || ( -f "$lock" && -O "$lock" &&
     $(stat -c %a "$lock") =~ ^[0-7]*[0145][0145]$ ) ) ]] || return 1
  inherited="${MOCHI_AIRDROP_INSTALL_LOCK_FD:-}"
  # Nested setup -> backend -> overlay calls inherit the SAME open file
  # description. Re-locking it succeeds; another daemon/installer still loses.
  if [[ "$inherited" =~ ^[0-9]+$ && "$inherited" -ge 10 &&
        /proc/self/fd/"$inherited" -ef "$lock" ]]; then
    flock -n "$inherited" || return 1
    return 0
  fi
  previous_umask="$(umask)"
  umask 077
  if ! exec {fd}>>"$lock"; then umask "$previous_umask"; return 1; fi
  umask "$previous_umask"
  if ! flock -n "$fd"; then
    exec {fd}>&-
    printf 'AirDrop is active or being updated. Finish the active transfer and turn AirDrop off before retrying.\n' >&2
    return 1
  fi
  export MOCHI_AIRDROP_INSTALL_LOCK_FD="$fd"
}

airdrop_require_idle() {
  local listeners
  if systemctl --user is-active --quiet mochi-airdrop.service; then
    printf 'Finish the active transfer and turn AirDrop off before retrying.\n' >&2
    return 1
  fi
  listeners="$(ss -ltnH '( sport = :8771 )')" || return 1
  [[ -z "$listeners" ]] || {
    printf 'Finish the active transfer and turn AirDrop off before retrying.\n' >&2
    return 1
  }
}

airdrop_verify_consent() {
  airdrop_config verify "$1" "$2" &&
    [[ -x "$2" ]] && cmp -s "$3" "$2"
}

airdrop_config() {
  # Validate a declarative subset of the sourced shell config without executing
  # it. Unknown shell syntax must not make a consent override invisible.
  python3 - "$@" <<'PY'
import os
from pathlib import Path
import re
import secrets
import shlex
import sys
import tempfile

mode, filename, hook = sys.argv[1:]
path = Path(filename).resolve()
text = path.read_text()
word = r'''(?:'[^']*'|"[^"\\`]*"|[A-Za-z0-9_./:@%+,=-]+)'''
assignment = re.compile(r'\s*(export\s+)?([A-Za-z_][A-Za-z_0-9]*)=(' + word + r'*)\s*(?:#.*)?')
pieces = re.compile(word)
expansion = re.compile(r'\$(?:[A-Za-z_][A-Za-z_0-9]*|\{[A-Za-z_][A-Za-z_0-9]*(?::-[^${}]*)?\})')
declaration = re.compile(r'\s*export\s+([A-Za-z_][A-Za-z_0-9]*)\s*(?:#.*)?')
values, exported = {}, set()
try:
    if '\n' in hook or '\r' in hook:
        raise ValueError('unsupported newline in consent hook path')
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        match = assignment.fullmatch(line)
        if match:
            export, name, raw = match.groups()
            value = ''
            for piece in pieces.findall(raw):
                part = piece[1:-1] if piece.startswith(('"', "'")) else piece
                if piece.startswith('"'):
                    if name in ('AIRDROP_CONFIRM', 'MOCHI_AIRDROP_SERVICE_ID') and '$' in part:
                        raise ValueError(f'nonliteral consent/identity on line {number}')
                    remainder = part
                    while True:
                        reduced = expansion.sub('', remainder)
                        if reduced == remainder:
                            break
                        remainder = reduced
                    if '$' in remainder:
                        raise ValueError(f'unsupported expansion on line {number}')
                value += part
            values[name] = value
            if export:
                exported.add(name)
        else:
            match = declaration.fullmatch(line)
            if not match:
                raise ValueError(f'unsupported shell syntax on line {number}')
            exported.add(match[1])
    effective = values.get('AIRDROP_CONFIRM')
    if effective is not None and effective != hook:
        raise ValueError('AIRDROP_CONFIRM overrides Mochi\'s consent hook')
    identity = values.get('MOCHI_AIRDROP_SERVICE_ID')
    if identity is not None and not re.fullmatch('[0-9a-f]{12}', identity):
        raise ValueError('invalid persistent AirDrop identity; kept the existing config')
    if mode == 'verify':
        if effective != hook or identity is None or 'MOCHI_AIRDROP_SERVICE_ID' not in exported:
            raise ValueError('Mochi consent hook or exported persistent identity is missing')
    elif mode == 'normalize':
        additions = []
        if effective is None:
            additions.append('AIRDROP_CONFIRM=' + shlex.quote(hook))
        if identity is None:
            identity = secrets.token_hex(6)
        canonical = f'export MOCHI_AIRDROP_SERVICE_ID="{identity}"'
        if canonical not in text.splitlines():
            additions.append(canonical)
        if additions:
            updated = text.rstrip('\n') + '\n\n' + '\n'.join(additions) + '\n'
            fd, staged = tempfile.mkstemp(prefix='.mochi-airdrop-config.', dir=path.parent)
            try:
                with os.fdopen(fd, 'w') as stream:
                    stream.write(updated)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(staged, path)
            finally:
                if os.path.exists(staged):
                    os.unlink(staged)
    else:
        raise ValueError('unknown config mode')
except ValueError as exc:
    sys.exit(f'[mochi-airdrop] Invalid receiver config: {exc}')
PY
}
