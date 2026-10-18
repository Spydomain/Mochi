#!/usr/bin/env python3
"""Remove the Linux installation, never shared packages, agent sessions or received files."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time


class Refusal(Exception):
    pass


def linux_distribution(release_file=Path('/etc/os-release')):
    """Read the same ID/ID_LIKE families as setup, without executing the file.

    Cleanup uses installed XDG files and available service management, not
    package removal: dependency packages can belong to other applications.
    Unknown/immutable distros can still remove a user-level installation.
    """
    fields = {}
    try:
        for line in Path(release_file).read_text().splitlines():
            key, separator, value = line.partition('=')
            if separator and key in ('ID', 'ID_LIKE', 'PRETTY_NAME', 'NAME'):
                words = shlex.split(value, comments=True)
                if len(words) == 1:
                    fields[key] = words[0]
    except (OSError, UnicodeError, ValueError):
        pass
    families = {
        'pacman': {'arch', 'archlinux', 'manjaro', 'endeavouros', 'cachyos'},
        'apt-get': {'debian', 'ubuntu', 'linuxmint', 'pop', 'elementary', 'kali'},
        'dnf': {'fedora', 'rhel', 'centos', 'rocky', 'almalinux'},
        'zypper': {'suse', 'sles'},
    }
    candidates = [fields.get('ID', ''), *fields.get('ID_LIKE', '').split()]
    manager = next((manager for candidate in candidates for manager, ids in families.items()
                    if candidate in ids or (manager == 'zypper' and candidate.startswith('opensuse'))), None)
    name = fields.get('PRETTY_NAME') or fields.get('NAME') or fields.get('ID') or 'Linux (distribution unavailable)'
    name = ''.join(char for char in name if char.isprintable())[:160]
    return {'name': name, 'id': fields.get('ID', ''), 'manager': manager}


def xdg(env, key, fallback):
    value = Path(env.get(key) or fallback)
    if not value.is_absolute() or value == Path('/') or '..' in value.parts:
        raise Refusal(f'{key} must be an absolute, non-root path without ..')
    return value


def checked(path):
    """Never follow symlink ancestors into another application/user's files."""
    for parent in [path, *path.parents]:
        if parent.is_symlink():
            raise Refusal(f'Symlink requires manual review: {parent}')
    if path.exists() and path.stat().st_uid != os.getuid():
        raise Refusal(f'Not owned by the current user: {path}')
    return path


def read(path):
    checked(path)
    if not path.exists():
        return None
    if not path.is_file():
        raise Refusal(f'Expected a regular file: {path}')
    return path.read_bytes()


def json_object(path):
    raw = read(path)
    if raw is None:
        return None
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError) as error:
        raise Refusal(f'Invalid JSON; left untouched: {path}') from error
    if not isinstance(value, dict):
        raise Refusal(f'Expected a JSON object: {path}')
    return value


def our_command(value, agent=None):
    return (isinstance(value, str) and 'mochi-hook' in value
            and (agent is None or f'--agent {agent}' in value))


def strip_hooks(root, agent):
    """Keep other commands even when mixed into one Mochi hook group."""
    result = copy.deepcopy(root)
    hooks = result.get('hooks')
    if hooks is None:
        return result
    if not isinstance(hooks, dict):
        raise Refusal('Unexpected hooks type; refusing to rewrite this config.')
    for event, entries in list(hooks.items()):
        if not isinstance(entries, list):
            continue
        kept = []
        for entry in entries:
            if not isinstance(entry, dict):
                kept.append(entry)
                continue
            fields = ('bash', 'powershell', 'command') if agent == 'copilot' else ('command',)
            if any(our_command(entry.get(key), agent) for key in fields):
                continue
            inner = entry.get('hooks')
            if isinstance(inner, list):
                filtered = [item for item in inner if not (
                    isinstance(item, dict) and our_command(item.get('command'), agent))]
                if len(filtered) != len(inner):
                    if not filtered:
                        continue
                    entry['hooks'] = filtered
            kept.append(entry)
        if kept:
            hooks[event] = kept
        else:
            del hooks[event]
    if not hooks:
        result.pop('hooks', None)
    return result


# Executed by sudo only for --remove-airdrop-system. Fixed allowlist, no shell,
# no deletion of directories, and rechecks root ownership + exact hashes.
ROOT_CLEANUP = r'''
import hashlib, os, stat, subprocess, sys
allowed = {'/usr/local/bin/airdrop-helper', '/usr/local/bin/airdrop-ble-watch',
           '/usr/local/bin/airdrop-owl', '/usr/local/bin/hostapd-mt7921', '/usr/local/bin/airdrop-go-hostapd',
           '/etc/sudoers.d/zz-airdrop'}
if any(os.path.exists('/sys/class/net/' + name) for name in ('go0', 'awdl0', 'mon0', 'mon1')):
    raise RuntimeError('AirDrop/monitor interfaces still exist; stop the radio before removing helpers')
args = sys.argv[1:]
check_only = bool(args and args[0] == '--check')
if check_only: args = args[1:]
if len(args) % 2: raise RuntimeError('Invalid arguments')
paths = []
for name, expected in zip(args[::2], args[1::2]):
    if name not in allowed: raise RuntimeError('Unexpected system path')
    if name == '/etc/sudoers.d/zz-airdrop' and not os.path.lexists(name): continue
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not (stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022):
            raise RuntimeError(name + ' ownership/type changed; refusing removal')
        if hashlib.sha256(stream.read()).hexdigest() != expected:
            raise RuntimeError(name + ' changed; refusing removal')
    paths.append((name, info))
if check_only: sys.exit(0)
for name, info in paths:
    current = os.lstat(name)
    if (current.st_dev, current.st_ino, current.st_mtime_ns) != (info.st_dev, info.st_ino, info.st_mtime_ns):
        raise RuntimeError(name + ' changed during cleanup')
    if name != '/etc/sudoers.d/zz-airdrop':
        os.unlink(name)
        continue
    with open(name, 'rb') as stream: previous = stream.read()
    os.unlink(name)
    try:
        # A direct @include in an administrator's sudoers must not be left
        # pointing at a missing file. Restore the exact rule if validation fails.
        result = subprocess.run(['visudo', '-c'], capture_output=True, timeout=15)
        if result.returncode: raise RuntimeError('sudoers validation failed; restoring rules')
    except BaseException:
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, stat.S_IMODE(info.st_mode))
        with os.fdopen(fd, 'wb') as stream:
            stream.write(previous)
            stream.flush()
            os.fsync(stream.fileno())
        raise
'''


class Uninstaller:
    def __init__(self, env=None, proc=Path('/proc'), run=subprocess.run):
        self.env = dict(os.environ if env is None else env)
        self.distribution = linux_distribution(self.env.get('MOCHI_OS_RELEASE_FILE') or '/etc/os-release')
        self.home = xdg(self.env, 'HOME', str(Path.home()))
        self.config = xdg(self.env, 'XDG_CONFIG_HOME', str(self.home / '.config'))
        self.data_home = xdg(self.env, 'XDG_DATA_HOME', str(self.home / '.local/share'))
        self.cache_home = xdg(self.env, 'XDG_CACHE_HOME', str(self.home / '.cache'))
        self.state_home = xdg(self.env, 'XDG_STATE_HOME', str(self.home / '.local/state'))
        self.data = self.data_home / 'mochi'
        self.runtime = (xdg(self.env, 'XDG_RUNTIME_DIR', str(self.home / '.run'))
                        if self.env.get('XDG_RUNTIME_DIR') else None)
        if self.runtime is None and Path(f'/run/user/{os.getuid()}').is_dir():
            self.runtime = Path(f'/run/user/{os.getuid()}')
        self.proc, self.run = proc, run
        self.remove, self.edits, self.root_files = [], [], []
        self.snapshots = {}
        self.units = []
        self.messages = []
        self.source = next((parent for parent in Path(__file__).resolve().parents
                            if (parent / 'mochi-full-setup.sh').exists() and (parent / '.git').exists()), None)

    def command(self, *args):
        return self.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False)

    def processes(self):
        for entry in self.proc.glob('[0-9]*'):
            try:
                if entry.stat().st_uid != os.getuid():
                    continue
                args = (entry / 'cmdline').read_bytes().split(b'\0')
                yield int(entry.name), [os.fsdecode(arg) for arg in args if arg]
            except (FileNotFoundError, PermissionError, ProcessLookupError):
                continue

    def owned_process(self, pid, args):
        if not args:
            return False
        binary = str(self.data / 'bin/mochi')
        try:
            executable = os.readlink(self.proc / str(pid) / 'exe').removesuffix(' (deleted)')
            if executable == binary:
                return True
        except OSError:
            pass
        scripts = {str(self.data / 'bin/mochi-airdrop-browse'),
                   str(self.data / 'bin/cleanup-opencode-sessions')}
        if args[0] == binary or args[0] in scripts:
            return True
        interpreter = Path(args[0]).name
        if not (re.fullmatch(r'python(?:\d+(?:\.\d+)*)?', interpreter) or interpreter in ('bash', 'sh')):
            return False
        remaining = args[1:]
        while remaining and remaining[0] in ('-u', '-B', '-s', '-E', '--'):
            remaining = remaining[1:]
        # Never kill an editor/grep which merely mentions one of our paths,
        # or an interpreter executing -c code that happens to include the name.
        return bool(remaining and remaining[0] in scripts)

    def preflight(self):
        for _, args in self.processes():
            busy = {str(self.data / 'bin' / name) for name in ('mochi-airdrop-send', 'mochi-airdrop-pick')}
            busy.add(str(self.data / 'omdrop-plugin/bin/pick.py'))
            backend = {str(self.data / path) for path in (
                'airdrop-mt7921/daemon/airdropd', 'owl/.venv-opendrop/bin/opendrop', 'omdrop-plugin/bin/omdrop')}
            if busy.intersection(args) or (backend.intersection(args) and any(
                    word in args for word in ('run', 'receive', 'send'))):
                raise Refusal('Finish file selection/transfers and turn AirDrop off before uninstalling.')
        if shutil.which('systemctl'):
            state = self.command('systemctl', '--user', 'is-active', 'mochi-airdrop.service')
            if state.stdout.strip() in ('active', 'activating', 'deactivating', 'reloading'):
                raise Refusal('Turn AirDrop off in Mochi before uninstalling; the receiver will not be interrupted.')
        if self.runtime:
            pending = self.runtime / 'mochi-airdrop/active/request.json'
            if pending.exists():
                raise Refusal('An incoming consent request is pending. Finish it and turn AirDrop off first.')

    def add_remove(self, path):
        checked(path)
        if path.exists() and path not in self.remove:
            if path.is_dir():
                # Do not follow links inside a managed tree, but do not traverse
                # mounts or a different owner's data either.
                device = path.stat().st_dev
                for base, dirs, files in os.walk(path, followlinks=False):
                    for name in dirs + files:
                        child = Path(base) / name
                        info = child.lstat()
                        if info.st_uid != os.getuid() or info.st_dev != device or child.is_mount():
                            raise Refusal(f'Foreign ownership/mount requires manual review: {child}')
            self.remove.append(path)

    def edit_json(self, path, change):
        raw = read(path)
        if raw is None:
            return
        root = json_object(path)
        updated = change(root)
        if updated != root:
            self.snapshots[path] = raw
            content = None if updated is None else (json.dumps(updated, indent=2) + '\n').encode()
            self.edits.append((path, content))

    def integrations(self):
        for agent, path in [
            (None, self.home / '.claude/settings.json'),
            ('gemini', self.home / '.gemini/settings.json'),
            ('codex', self.home / '.codex/hooks.json'),
            ('cursor', self.home / '.cursor/hooks.json'),
            ('copilot', self.home / '.copilot/hooks/mochi.json'),
            ('muse', self.home / '.config/muse/settings.json'),
        ]:
            def change(root, agent=agent):
                updated = strip_hooks(root, agent)
                if agent is None and isinstance(root.get('statusLine'), dict) and our_command(root['statusLine'].get('command')):
                    previous = json_object(self.data / 'bin/statusline-previous.json')
                    if previous:
                        updated['statusLine'] = previous
                    else:
                        updated.pop('statusLine', None)
                if agent == 'copilot' and set(updated) <= {'version'}:
                    return None
                return updated
            self.edit_json(path, change)
        def antigravity(root):
            result = copy.deepcopy(root)
            text = json.dumps(result.get('mochi'))
            if 'mochi-hook' in text and '--agent antigravity' in text:
                result.pop('mochi', None)
            return result
        self.edit_json(self.home / '.gemini/config/hooks.json', antigravity)
        # Setup honors XDG; the app's agent installer also supports ~/.config.
        for config in {self.config, self.home / '.config'}:
            for rel in ('opencode/plugins/mochi.js', 'amp/plugins/mochi.ts'):
                path = config / rel
                raw = read(path)
                if raw is not None:
                    if b'generated by Mochi' in raw:
                        self.add_remove(path)
                    else:
                        raise Refusal(f'Plugin was not generated by Mochi; review manually: {path}')
        for name in ('__init__.py', 'plugin.yaml'):
            path = self.home / '.hermes/plugins/mochi' / name
            raw = read(path)
            if raw is not None:
                if b'generated by Mochi' not in raw:
                    raise Refusal(f'Plugin was not generated by Mochi: {path}')
                self.add_remove(path)

    def system_helpers(self, enabled, root=Path('/')):
        sources = {
            '/usr/local/bin/airdrop-helper': self.data / 'airdrop-mt7921/daemon/airdrop-helper',
            '/usr/local/bin/airdrop-ble-watch': self.data / 'airdrop-mt7921/daemon/ble-watch',
            '/usr/local/bin/airdrop-owl': self.data / 'owl/build/daemon/owl',
            '/usr/local/bin/hostapd-mt7921': self.data / 'build/mochi-hostapd-2.11/hostapd/hostapd',
            '/usr/local/bin/airdrop-go-hostapd': self.data / 'build/mochi-hostapd-2.11/hostapd/hostapd',
        }
        for target, source in sources.items():
            path = root / target.lstrip('/')
            if not path.exists():
                continue
            if enabled and read(source) is not None and not path.is_symlink() and path.read_bytes() == read(source):
                self.root_files.append((str(path), hashlib.sha256(path.read_bytes()).hexdigest()))
            else:
                self.messages.append(f'Keep shared/unverified system helper: {target}')
        sudoers = root / 'etc/sudoers.d/zz-airdrop'
        if enabled:
            # Do not read protected sudoers with a privileged arbitrary command.
            # Hash expected exact installer output; root revalidates the file.
            user = pwd.getpwuid(os.getuid()).pw_name
            expected = (f'{user} ALL=(root) NOPASSWD: /usr/local/bin/airdrop-helper\n'
                        f'{user} ALL=(root) NOPASSWD: /usr/local/bin/airdrop-ble-watch\n').encode()
            if self.root_files:
                self.root_files.insert(0, (str(sudoers), hashlib.sha256(expected).hexdigest()))

    def plan(self, purge=False, system=False):
        self.preflight()
        self.integrations()
        self.system_helpers(system)
        for name in ('mochi-app.service', 'mochi-opencode-cleanup.service', 'mochi-opencode-cleanup.timer'):
            path = self.config / 'systemd/user' / name
            raw = read(path)
            if raw is not None:
                timer = (name == 'mochi-opencode-cleanup.timer' and b'Description=Mochi ' in raw
                         and b'Unit=mochi-opencode-cleanup.service' in raw)
                timer = timer or (name == 'mochi-opencode-cleanup.timer'
                                  and b'Description=Remove Mochi chat sessions older than 30 days\n' in raw
                                  and b'[Timer]\n' in raw and b'OnUnitActiveSec=1d\n' in raw
                                  and not any(line.startswith(b'Unit=') and line != b'Unit=mochi-opencode-cleanup.service'
                                              for line in raw.splitlines()))
                if str(self.data / 'bin').encode() not in raw and not timer:
                    raise Refusal(f'Unit does not point to this installation: {path}')
                self.units.append(name)
                self.add_remove(path)
                for wants in ('default.target.wants', 'graphical-session.target.wants', 'timers.target.wants'):
                    link = path.parent / wants / name
                    if link.is_symlink() and link.resolve() == path.resolve():
                        checked(link.parent)
                        self.remove.append(link)
        for path in (self.data_home / 'applications/io.github.spydomain.mochi.desktop',
                     self.data_home / 'applications/mochi.desktop',
                     self.config / 'autostart/mochi.desktop',
                     self.config / 'autostart/mochi-session-cleanup.desktop'):
            raw = read(path)
            if raw is not None:
                if str(self.data / 'bin').encode() not in raw:
                    raise Refusal(f'Desktop entry does not point to Mochi: {path}')
                self.add_remove(path)
        self.add_remove(self.data_home / 'icons/hicolor/128x128/apps/mochi.png')
        self.add_remove(self.data_home / 'systemd/timers/stamp-mochi-opencode-cleanup.timer')
        for name in ('bin', 'airdrop-mt7921', 'owl', 'build', 'toolchain', 'installed-revision', 'installed-no-airdrop'):
            self.add_remove(self.data / name)
        if self.runtime:
            self.add_remove(self.runtime / 'mochi-airdrop')
            self.add_remove(self.runtime / 'mochi.sock')
        if self.runtime:
            self.messages.append(f'Keep shared backend runtime/logs: {self.runtime / "airdropd"}')
        # Only remove the installer-generated shared-mode config, never a
        # preexisting upstream configuration or identity shared with OpenDrop.
        config = self.config / 'airdrop/config'
        raw = read(config)
        if raw is not None and raw.startswith(b'# Mochi MT7922 shared-mode defaults.'):
            self.add_remove(config)
        waybar = self.config / 'waybar/airdrop-status.sh'
        if waybar.is_symlink() and os.readlink(waybar) == str(self.data / 'airdrop-mt7921/waybar/airdrop-status.sh'):
            # Intentional owned symlink: unlink it, never its target.
            checked(waybar.parent)
            self.remove.append(waybar)
        if purge:
            # Autostart backups can contain the user's old launcher, not just
            # Mochi data. Keep these even with --purge.
            for directory in (self.config / 'mochi', self.data, self.cache_home / 'mochi', self.state_home / 'mochi'):
                checked(directory)
                if directory.exists():
                    for child in directory.iterdir():
                        if child.name != 'autostart-backups':
                            self.add_remove(child)
            for base in (self.data_home, self.cache_home, self.config):
                self.add_remove(base / 'io.github.spydomain.mochi')
        settings = json_object(self.config / 'mochi/settings.json') or {}
        destination = settings.get('airdropDirectory') or str(self.home / 'Downloads')
        if not isinstance(destination, str) or not Path(destination).is_absolute():
            raise Refusal('Cannot safely determine the saved AirDrop directory.')
        destination = Path(destination).resolve()
        for path in self.remove:
            resolved = path.absolute() if path.is_symlink() else path.resolve()
            if resolved == destination or resolved in destination.parents or destination in resolved.parents:
                raise Refusal(f'Removal overlaps the AirDrop save folder; move/preserve it first: {path}')
            source = self.source
            if source is not None:
                if resolved == source or resolved in source.parents or source in resolved.parents:
                    raise Refusal(f'The source checkout overlaps managed data; preserve it manually first: {path}')
        return self

    def show(self):
        distro = self.distribution
        family = distro['manager'] or 'generic XDG'
        print(f'Detected {distro["name"]}; {family} family. Shared system packages will be kept.')
        for unit in self.units:
            if not shutil.which('systemctl'):
                continue
            print(f'Disable Mochi user unit: {unit}')
        for path, _ in self.edits:
            print(f'Remove Mochi hook entries (with backup): {path}')
        for path in self.remove:
            print(f'Remove: {path}')
        for path, _ in self.root_files:
            print(f'Remove verified shared AirDrop system file (sudo): {path}')
        for message in self.messages:
            print(message)

    def apply(self):
        self.preflight()
        for path, raw in self.snapshots.items():
            if read(path) != raw:
                raise Refusal(f'Config changed after preview; retry: {path}')
        # Obtain/check privilege before stopping/removing any user components.
        if self.root_files:
            root_args = [part for pair in self.root_files for part in pair]
            result = self.command('sudo', '--', 'python3', '-c', ROOT_CLEANUP, '--check', *root_args)
            if result.returncode:
                raise Refusal('System helper verification/removal failed; user installation left in place.\n' + result.stderr)
        for unit in self.units:
            if not shutil.which('systemctl'):
                continue
            result = self.command('systemctl', '--user', 'disable', '--now', unit)
            if result.returncode:
                # No user manager is normal on some autostart-only desktops;
                # do not ignore a genuine stop failure with an active unit.
                state = self.command('systemctl', '--user', 'is-active', unit)
                if state.stdout.strip() in ('active', 'activating', 'deactivating'):
                    raise Refusal(f'Could not stop {unit}; nothing further removed.')
        # Exact executable/script paths, never pkill by basename or any agent.
        targets = [(pid, args) for pid, args in self.processes() if self.owned_process(pid, args)]
        for pid, args in targets:
            try:
                if (self.proc / str(pid) / 'cmdline').read_bytes().split(b'\0')[:len(args)] != [os.fsencode(a) for a in args]:
                    continue
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 5
        def still_running(pid):
            try:
                return bool((self.proc / str(pid) / 'cmdline').read_bytes())
            except FileNotFoundError:
                return False
        while any(still_running(pid) for pid, _ in targets):
            if time.monotonic() >= deadline:
                raise Refusal('Mochi has not exited; retry after closing it. No files removed.')
            time.sleep(.1)
        # The app can no longer enable the receiver while a sudo prompt is up.
        # Recheck both the idle state and all privileged hashes before deletion.
        self.preflight()
        if self.root_files:
            result = self.command('sudo', '--', 'python3', '-c', ROOT_CLEANUP, *root_args)
            if result.returncode:
                raise Refusal('System helper cleanup refused; user files were not removed.\n' + result.stderr)
        for path, content in self.edits:
            raw = self.snapshots[path]
            if read(path) != raw:
                raise Refusal(f'Config changed during shutdown; left untouched: {path}')
            backup = path.with_name(path.name + f'.mochi-uninstall-{time.time_ns()}.bak')
            with backup.open('xb') as stream:
                os.chmod(backup, 0o600)
                stream.write(raw)
            if content is None:
                if read(path) != raw:
                    raise Refusal(f'Config changed before removal: {path}')
                path.unlink()
                continue
            fd, temporary = tempfile.mkstemp(prefix='.mochi-uninstall-', dir=path.parent)
            try:
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(content)
                if read(path) != raw:
                    raise Refusal(f'Config changed before write: {path}')
                os.replace(temporary, path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        for path in self.remove:
            if path.is_symlink():
                path.unlink()
            elif path.exists():
                checked(path)
                if path.is_dir():
                    shutil.rmtree(path)
                else:
                    path.unlink()
        for path in (self.home / '.hermes/plugins/mochi', self.data, self.config / 'mochi',
                     self.cache_home / 'mochi', self.state_home / 'mochi'):
            if path.is_dir() and not path.is_symlink():
                try:
                    path.rmdir()
                except OSError:
                    pass  # Never remove a nonempty container or unrelated data.
        if self.units and shutil.which('systemctl'):
            self.command('systemctl', '--user', 'daemon-reload')
        print('Mochi uninstalled. Shared packages, OpenCode/agent sessions, source checkout and received files were not removed.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dry-run', '--check', action='store_true', help='detect Linux and show the plan without changing anything or using sudo')
    parser.add_argument('--yes', action='store_true', help='confirm removal non-interactively (does not bypass safety checks)')
    parser.add_argument('--purge', action='store_true', help='also delete Mochi settings, logs, history, caches and incomplete-transfer recovery data')
    parser.add_argument('--remove-airdrop-system', action='store_true', help='also remove exact matching privileged AirDrop helpers/rules (sudo; may be shared)')
    args = parser.parse_args()
    try:
        if sys.platform != 'linux':
            raise Refusal('This uninstaller is for the Linux setup script only.')
        if os.geteuid() == 0:
            raise Refusal('Run as your desktop user, not root/sudo. Only optional system cleanup uses sudo.')
        uninstall = Uninstaller().plan(args.purge, args.remove_airdrop_system)
        uninstall.show()
        print('Keep: received files, shared OpenDrop identity (~/.opendrop), agent config backups, autostart backups, shared packages/toolchains outside Mochi.')
        if not args.purge:
            print('Keep: Mochi preferences/logs/history/recovery data. Use --purge to remove these too.')
        if args.dry_run:
            print('Dry run: nothing changed.')
            return 0
        if not args.yes:
            if not os.isatty(0) or input('Uninstall the files listed above? [y/N] ').lower() not in ('y', 'yes'):
                print('Cancelled; nothing changed.')
                return 1
        uninstall.apply()
        return 0
    except (Refusal, OSError) as error:
        print(f'[mochi-uninstall] {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
