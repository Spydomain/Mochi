#!/usr/bin/env python3
"""Isolated fixtures only: no live app, service, radio or sudo is modified."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

REPO = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('uninstall', REPO / 'windows/scripts/uninstall-mochi.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class UninstallTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='mochi-uninstall-', dir='/tmp/opencode')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.home = self.root / 'home with spaces'
        self.env = {'HOME': str(self.home)}
        for key, name in [('XDG_CONFIG_HOME', 'config'), ('XDG_DATA_HOME', 'data'),
                          ('XDG_CACHE_HOME', 'cache'), ('XDG_STATE_HOME', 'state'), ('XDG_RUNTIME_DIR', 'runtime')]:
            self.env[key] = str(self.root / name)
        self.calls = []
        self.run = Mock(side_effect=self.runner)
        self.app = module.Uninstaller(self.env, proc=self.root / 'proc', run=self.run)
        self.system = patch.object(self.app, 'system_helpers')
        self.system.start()
        self.addCleanup(self.system.stop)
        self.write(self.app.data / 'bin/mochi', 'binary')
        self.write(self.app.data / 'installed-revision', 'revision')
        self.write(self.app.data / 'installed-no-airdrop', '1\n')
        self.settings = self.app.config / 'mochi/settings.json'
        self.write_json(self.settings, {'airdropDirectory': str(self.home / 'received'), 'identity': 'keep'})
        self.write(self.home / 'received/phone.pdf', 'received file')
        self.write(self.app.cache_home / 'mochi/airdrop/recovery/raw.dvzip', 'partial recovery')
        self.write(self.home / '.opendrop/keys/private.pem', 'shared identity')
        self.write(self.app.data_home / 'opencode/sessions/user', 'unrelated session')
        self.write(self.root / 'checkout/user-work', 'uncommitted source')

    def runner(self, args, **kwargs):
        self.calls.append(args)
        active = 'is-active' in args
        return subprocess.CompletedProcess(args, 3 if active else 0, 'inactive\n' if active else '', '')

    def write(self, path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def write_json(self, path, value):
        return self.write(path, json.dumps(value))

    def process(self, pid, *args):
        path = self.root / 'proc' / str(pid) / 'cmdline'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'\0'.join(os.fsencode(arg) for arg in args) + b'\0')
        return path

    def apply(self, purge=False):
        with contextlib.redirect_stdout(io.StringIO()):
            self.app.plan(purge=purge).apply()

    def test_default_removes_install_but_preserves_settings_recovery_identity_files_and_sessions(self):
        self.apply()
        self.assertFalse((self.app.data / 'bin').exists())
        self.assertFalse((self.app.data / 'installed-revision').exists())
        self.assertFalse((self.app.data / 'installed-no-airdrop').exists())
        self.assertTrue(self.settings.exists())
        self.assertTrue((self.app.cache_home / 'mochi/airdrop/recovery/raw.dvzip').exists())
        self.assert_preserved()

    def assert_preserved(self):
        for path in (self.home / 'received/phone.pdf', self.home / '.opendrop/keys/private.pem',
                     self.app.data_home / 'opencode/sessions/user', self.root / 'checkout/user-work'):
            self.assertTrue(path.exists(), str(path))
        self.assertFalse(any(command[0] in ('sudo', 'nmcli', 'iw', 'opencode', 'pkill') for command in self.calls))

    def test_purge_removes_app_data_and_webview_cache_but_not_user_backups(self):
        self.write(self.app.config / 'mochi/autostart-backups/coucou.desktop', 'old user launcher')
        self.write(self.app.data / 'mochi.log', 'private log')
        self.write(self.app.data_home / 'io.github.spydomain.mochi/storage', 'webview')
        self.apply(purge=True)
        self.assertFalse(self.settings.exists())
        self.assertFalse((self.app.data / 'mochi.log').exists())
        self.assertFalse((self.app.cache_home / 'mochi').exists())
        self.assertFalse((self.app.data_home / 'io.github.spydomain.mochi').exists())
        self.assertTrue((self.app.config / 'mochi/autostart-backups/coucou.desktop').exists())
        self.assert_preserved()

    def test_purge_is_idempotent(self):
        self.apply(purge=True)
        self.app = module.Uninstaller(self.env, proc=self.root / 'proc', run=self.run)
        with patch.object(self.app, 'system_helpers'):
            self.apply(purge=True)
        self.assert_preserved()

    def test_busy_receiver_service_refuses_without_disabling_anything(self):
        self.run.side_effect = lambda args, **kw: subprocess.CompletedProcess(args, 0, 'active\n', '')
        with self.assertRaisesRegex(module.Refusal, 'Turn AirDrop off'):
            self.app.plan(purge=True)
        self.assertTrue((self.app.data / 'bin/mochi').exists())
        self.assertTrue(self.settings.exists())
        self.assertFalse(any('disable' in call.args[0] for call in self.run.call_args_list))

    def test_sender_chooser_and_receiver_processes_block_uninstall(self):
        for rel, extra in [('bin/mochi-airdrop-pick', []), ('bin/mochi-airdrop-send', []),
                           ('owl/.venv-opendrop/bin/opendrop', ['receive']),
                           ('airdrop-mt7921/daemon/airdropd', ['run'])]:
            with self.subTest(program=rel):
                self.process(123, 'python3', str(self.app.data / rel), *extra)
                with self.assertRaisesRegex(module.Refusal, 'turn AirDrop off'):
                    self.app.plan()
        self.assertTrue((self.app.data / 'bin/mochi').exists())

    def test_incoming_consent_refuses(self):
        self.write(self.app.runtime / 'mochi-airdrop/active/request.json', '{}')
        with self.assertRaisesRegex(module.Refusal, 'consent request'):
            self.app.plan()

    def test_unrelated_python_and_opencode_are_never_killed(self):
        self.process(123, '/other/mochi')
        self.process(124, 'opencode', 'serve')
        self.process(125, 'python3', '/other/opendrop', 'receive')
        self.process(126, 'vim', str(self.app.data / 'bin/mochi'))
        self.process(127, 'grep', str(self.app.data / 'bin/mochi-airdrop-browse'))
        with patch.object(os, 'kill') as kill:
            self.apply()
        kill.assert_not_called()

    def test_only_exact_app_and_browser_paths_are_terminated(self):
        app = self.process(123, str(self.app.data / 'bin/mochi'))
        browse = self.process(124, 'python3', '-u', str(self.app.data / 'bin/mochi-airdrop-browse'))
        self.process(125, 'opencode', 'serve')
        def stop(pid, sig):
            {123: app, 124: browse}[pid].unlink()
        with patch.object(os, 'kill', side_effect=stop) as kill:
            self.apply()
        self.assertEqual({call.args[0] for call in kill.call_args_list}, {123, 124})

    def test_json_hooks_preserve_other_commands_in_mixed_groups_and_restore_statusline(self):
        path = self.home / '.claude/settings.json'
        root = {'theme': 'keep', 'hooks': {'PreToolUse': [{'matcher': '*', 'hooks': [
            {'command': 'mochi-hook PreToolUse'}, {'command': 'other-hook'}]}]},
            'statusLine': {'command': 'mochi-hook --statusline'}}
        self.write_json(path, root)
        self.write_json(self.app.data / 'bin/statusline-previous.json', {'command': 'my-status', 'padding': 2})
        self.apply()
        self.assertEqual(json.loads(path.read_text()), {'theme': 'keep', 'hooks': {'PreToolUse': [
            {'matcher': '*', 'hooks': [{'command': 'other-hook'}]}]},
            'statusLine': {'command': 'my-status', 'padding': 2}})
        backups = list(path.parent.glob('*.mochi-uninstall-*.bak'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(json.loads(backups[0].read_text()), root)
        self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)

    def test_other_statusline_is_not_changed(self):
        path = self.home / '.claude/settings.json'
        self.write_json(path, {'statusLine': {'command': 'mine'}})
        before = path.read_bytes()
        self.apply()
        self.assertEqual(path.read_bytes(), before)

    def test_all_agent_hook_shapes_and_plugins(self):
        for agent, rel in [('gemini', '.gemini/settings.json'), ('codex', '.codex/hooks.json'),
                           ('cursor', '.cursor/hooks.json'), ('muse', '.config/muse/settings.json')]:
            self.write_json(self.home / rel, {'model': 'keep', 'hooks': {'start': [
                {'command': f'mochi-hook --agent {agent}'}, {'command': 'other'}]}})
        copilot = self.write_json(self.home / '.copilot/hooks/mochi.json',
                                 {'version': 1, 'hooks': {'start': [{'bash': 'mochi-hook --agent copilot'}]}})
        antigravity = self.write_json(self.home / '.gemini/config/hooks.json',
                                     {'mochi': {'command': 'mochi-hook --agent antigravity'}, 'other': {}})
        plugins = [self.app.config / 'opencode/plugins/mochi.js', self.home / '.config/amp/plugins/mochi.ts',
                   self.home / '.hermes/plugins/mochi/__init__.py', self.home / '.hermes/plugins/mochi/plugin.yaml']
        for path in plugins:
            self.write(path, '// generated by Mochi')
        self.apply()
        for rel in ('.gemini/settings.json', '.codex/hooks.json', '.cursor/hooks.json', '.config/muse/settings.json'):
            self.assertEqual(json.loads((self.home / rel).read_text()), {'model': 'keep', 'hooks': {'start': [{'command': 'other'}]}})
        self.assertFalse(copilot.exists())
        self.assertEqual(json.loads(antigravity.read_text()), {'other': {}})
        for path in plugins:
            self.assertFalse(path.exists())
        self.assertFalse((self.home / '.hermes/plugins/mochi').exists())

    def test_invalid_json_or_foreign_plugin_refuses_before_mutation(self):
        path = self.write(self.home / '.claude/settings.json', '{ broken')
        with self.assertRaises(module.Refusal):
            self.app.plan()
        path.unlink()
        self.write(self.app.config / 'opencode/plugins/mochi.js', '// my own plugin')
        with self.assertRaisesRegex(module.Refusal, 'not generated'):
            self.app.plan()
        self.assertTrue((self.app.data / 'bin/mochi').exists())

    def test_symlinked_managed_directory_is_refused_but_internal_link_is_not_followed(self):
        outside = self.root / 'outside'
        self.write(outside / 'keep', 'keep')
        (self.app.data / 'owl').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(module.Refusal, 'Symlink'):
            self.app.plan()
        (self.app.data / 'owl').unlink()
        (self.app.data / 'bin/link').symlink_to(outside, target_is_directory=True)
        self.apply()
        self.assertTrue((outside / 'keep').exists())

    def test_receive_folder_inside_managed_tree_is_protected_even_with_purge(self):
        self.write_json(self.settings, {'airdropDirectory': str(self.app.data / 'bin/received')})
        self.write(self.app.data / 'bin/received/file', 'keep')
        with self.assertRaisesRegex(module.Refusal, 'overlaps'):
            self.app.plan(purge=True)
        self.assertTrue((self.app.data / 'bin/received/file').exists())

    def test_relative_xdg_or_home_root_is_rejected(self):
        for key, value in [('XDG_DATA_HOME', 'relative'), ('HOME', '/'), ('XDG_CONFIG_HOME', '/home/../')]:
            with self.subTest(key=key), self.assertRaises(module.Refusal):
                module.Uninstaller({**self.env, key: value})

    def test_config_changes_after_plan_are_not_overwritten(self):
        path = self.write_json(self.home / '.claude/settings.json', {'hooks': {'start': [{'command': 'mochi-hook'}]}})
        self.app.plan()
        self.write_json(path, {'user': 'new work'})
        with self.assertRaisesRegex(module.Refusal, 'changed after preview'):
            self.app.apply()
        self.assertTrue((self.app.data / 'bin/mochi').exists())
        self.assertEqual(json.loads(path.read_text()), {'user': 'new work'})

    def test_user_units_launchers_and_owned_links_are_removed(self):
        for name in ('mochi-app.service', 'mochi-opencode-cleanup.service'):
            self.write(self.app.config / 'systemd/user' / name, f'ExecStart={self.app.data}/bin/mochi')
        timer = self.write(self.app.config / 'systemd/user/mochi-opencode-cleanup.timer',
                           '[Unit]\nDescription=Mochi cleanup\n[Timer]\nUnit=mochi-opencode-cleanup.service\n')
        link = self.app.config / 'systemd/user/timers.target.wants' / timer.name
        link.parent.mkdir(parents=True)
        link.symlink_to(timer)
        desktop = self.write(self.app.config / 'autostart/mochi.desktop', f'Exec={self.app.data}/bin/mochi')
        waybar = self.app.config / 'waybar/airdrop-status.sh'
        waybar.parent.mkdir()
        waybar.symlink_to(self.app.data / 'airdrop-mt7921/waybar/airdrop-status.sh')
        self.apply()
        self.assertFalse(timer.exists())
        self.assertFalse(link.is_symlink())
        self.assertFalse(waybar.is_symlink())
        self.assertFalse(desktop.exists())
        self.assertEqual(len([call for call in self.calls if 'disable' in call]), 3)

    def test_foreign_unit_and_preexisting_airdrop_config_are_preserved(self):
        config = self.write(self.app.config / 'airdrop/config', '# preexisting upstream config')
        unit = self.write(self.app.config / 'systemd/user/mochi-app.service', 'ExecStart=/other/program')
        with self.assertRaisesRegex(module.Refusal, 'does not point'):
            self.app.plan()
        unit.unlink()
        self.apply()
        self.assertEqual(config.read_text(), '# preexisting upstream config')

    def test_installer_airdrop_config_is_removed(self):
        config = self.write(self.app.config / 'airdrop/config', '# Mochi MT7922 shared-mode defaults.\nmode=shared')
        self.apply()
        self.assertFalse(config.exists())

    def test_plan_does_not_disable_services_kill_processes_or_use_sudo(self):
        with patch.object(os, 'kill') as kill, contextlib.redirect_stdout(io.StringIO()):
            self.app.plan(purge=True)
            self.app.show()
        kill.assert_not_called()
        self.assertTrue(self.settings.exists())
        self.assertTrue(all('is-active' in call for call in self.calls))

    def test_optional_system_inventory_only_selects_matching_installed_copies(self):
        prefix = self.root / 'system'
        target = self.write(prefix / 'usr/local/bin/airdrop-helper', 'exact copy')
        self.write(self.app.data / 'airdrop-mt7921/daemon/airdrop-helper', 'exact copy')
        foreign = self.write(prefix / 'usr/local/bin/airdrop-owl', 'another installation')
        self.write(self.app.data / 'owl/build/daemon/owl', 'our build')
        module.Uninstaller.system_helpers(self.app, True, root=prefix)
        self.assertIn((str(target), hashlib.sha256(b'exact copy').hexdigest()), self.app.root_files)
        self.assertFalse(any(path == str(foreign) for path, _ in self.app.root_files))
        self.assertTrue(any(path.endswith('/etc/sudoers.d/zz-airdrop') for path, _ in self.app.root_files))
        self.assertTrue(foreign.exists())

    def test_current_hostapd_helper_is_selected_by_exact_installed_bytes(self):
        prefix = self.root / 'system'
        target = self.write(prefix / 'usr/local/bin/airdrop-go-hostapd', 'our hostapd')
        self.write(self.app.data / 'build/mochi-hostapd-2.11/hostapd/hostapd', 'our hostapd')
        module.Uninstaller.system_helpers(self.app, True, root=prefix)
        self.assertIn((str(target), hashlib.sha256(b'our hostapd').hexdigest()), self.app.root_files)
        self.assertIn("'/usr/local/bin/airdrop-go-hostapd'", module.ROOT_CLEANUP)

    def test_distro_detection_matches_setup_families_and_derivatives(self):
        release = self.root / 'os-release'
        for distro, like, manager in [('cachyos', 'arch', 'pacman'), ('manjaro', '', 'pacman'),
            ('linuxmint', 'ubuntu debian', 'apt-get'), ('kali', '', 'apt-get'),
            ('fedora', '', 'dnf'), ('rocky', 'rhel fedora', 'dnf'),
            ('opensuse-tumbleweed', 'suse', 'zypper'), ('derived', 'unsupported ubuntu', 'apt-get')]:
            with self.subTest(distro=distro):
                self.write(release, f'ID={distro}\nID_LIKE="{like}"\nPRETTY_NAME="Test {distro}"\n')
                detected = module.linux_distribution(release)
                self.assertEqual(detected['manager'], manager)
                self.assertEqual(detected['name'], f'Test {distro}')
        self.write(release, 'ID=alpine\nPRETTY_NAME="Alpine Linux"\n')
        self.assertIsNone(module.linux_distribution(release)['manager'])
        self.assertIsNone(module.linux_distribution(self.root / 'missing')['manager'])

    def test_os_release_is_never_executed_and_unknown_distros_keep_safe_xdg_cleanup(self):
        release = self.write(self.root / 'os-release', 'ID=unrecognized\nPRETTY_NAME="$(touch attacker)"\n')
        env = {**self.env, 'MOCHI_OS_RELEASE_FILE': str(release)}
        app = module.Uninstaller(env, proc=self.root / 'proc', run=self.run)
        self.assertEqual(app.distribution['name'], '$(touch attacker)')
        with patch.object(app, 'system_helpers'), contextlib.redirect_stdout(io.StringIO()) as output:
            app.plan().show()
        self.assertIn('generic XDG', output.getvalue())
        self.assertTrue((self.app.data / 'bin/mochi').exists(), 'detection/preview must not uninstall')
        self.assertFalse((REPO / 'attacker').exists())
        self.assert_preserved()

    def test_failed_system_cleanup_leaves_user_installation(self):
        self.app.plan()
        self.app.root_files = [('/usr/local/bin/airdrop-helper', 'not-a-real-hash')]
        self.run.side_effect = lambda args, **kwargs: subprocess.CompletedProcess(args, 1, '', 'verification failed')
        with self.assertRaisesRegex(module.Refusal, 'left in place'):
            self.app.apply()
        self.assertTrue((self.app.data / 'bin/mochi').exists())
        self.assertTrue(self.settings.exists())

    def test_root_cleanup_validates_all_files_before_deleting_any(self):
        first = self.write(self.root / 'first', 'one')
        second = self.write(self.root / 'second', 'changed')
        # Simulated root namespace/ownership; never run sudo or target system files.
        program = module.ROOT_CLEANUP.replace("allowed = {", f"allowed = {{{str(first)!r}, {str(second)!r}, ", 1)
        program = program.replace('info.st_uid == 0', f'info.st_uid == {os.getuid()}')
        program = program.replace('/sys/class/net/', str(self.root / 'no-interfaces') + '/')
        result = subprocess.run([sys.executable, '-c', program, str(first), hashlib.sha256(b'one').hexdigest(),
                                 str(second), hashlib.sha256(b'two').hexdigest()], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(first.exists())
        self.assertTrue(second.exists())

    def test_root_cleanup_removes_verified_simulated_copies_and_never_accepts_other_paths(self):
        path = self.write(self.root / 'root-helper', 'one')
        program = module.ROOT_CLEANUP.replace("allowed = {", f"allowed = {{{str(path)!r}, ", 1)
        program = program.replace('info.st_uid == 0', f'info.st_uid == {os.getuid()}')
        program = program.replace('/sys/class/net/', str(self.root / 'no-interfaces') + '/')
        result = subprocess.run([sys.executable, '-c', program, '--check', str(path), hashlib.sha256(b'one').hexdigest()], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(path.exists(), 'Privilege preflight cannot remove anything')
        result = subprocess.run([sys.executable, '-c', program, str(path), hashlib.sha256(b'one').hexdigest()], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(path.exists())
        other = self.write(self.root / 'unrelated', 'one')
        result = subprocess.run([sys.executable, '-c', program, str(other), hashlib.sha256(b'one').hexdigest()], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(other.exists())

    def test_privileged_delete_runs_only_after_app_exits_and_uses_the_previewed_hashes(self):
        self.app.plan()
        self.app.root_files = [('/usr/local/bin/airdrop-helper', 'previewed-hash')]
        app = self.process(123, str(self.app.data / 'bin/mochi'))
        order = []
        def runner(args, **kwargs):
            if args[0] == 'sudo':
                order.append('check' if '--check' in args else 'remove')
                self.assertEqual(args[-2:], ('/usr/local/bin/airdrop-helper', 'previewed-hash'))
                if '--check' not in args:
                    self.assertFalse(app.exists())
            return self.runner(args, **kwargs)
        self.run.side_effect = runner
        def stop(pid, sig):
            order.append('app-exit')
            app.unlink()
        with patch.object(os, 'kill', side_effect=stop), contextlib.redirect_stdout(io.StringIO()):
            self.app.apply()
        self.assertEqual(order, ['check', 'app-exit', 'remove'])

    def test_sudoers_validation_failure_restores_rules_before_removing_helpers(self):
        rules = self.write(self.root / 'simulated-sudoers', 'exact rules\n')
        helper = self.write(self.root / 'simulated-helper', 'helper')
        visudo = self.write(self.root / 'commands/visudo', '#!/bin/sh\nexit 1\n')
        visudo.chmod(0o755)
        program = module.ROOT_CLEANUP.replace('/etc/sudoers.d/zz-airdrop', str(rules))
        program = program.replace('/usr/local/bin/airdrop-helper', str(helper))
        program = program.replace('info.st_uid == 0', f'info.st_uid == {os.getuid()}')
        program = program.replace('/sys/class/net/', str(self.root / 'no-interfaces') + '/')
        result = subprocess.run([sys.executable, '-c', program, str(rules), hashlib.sha256(rules.read_bytes()).hexdigest(),
                                 str(helper), hashlib.sha256(helper.read_bytes()).hexdigest()], capture_output=True,
                                env={**os.environ, 'PATH': str(visudo.parent) + ':' + os.environ.get('PATH', '')})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(rules.read_text(), 'exact rules\n')
        self.assertEqual(helper.read_text(), 'helper')

    def test_cli_dry_run_and_cancellation_do_not_apply(self):
        for extra in (['--dry-run'], ['--check'], ['--check', '--yes', '--purge', '--remove-airdrop-system'], []):
            with self.subTest(args=extra), patch.object(module, 'Uninstaller', return_value=self.app), \
                    patch.object(sys, 'argv', ['uninstall-mochi', *extra]), \
                    patch.object(os, 'geteuid', return_value=1000), patch.object(os, 'isatty', return_value=False), \
                    patch.object(self.app, 'apply') as apply, contextlib.redirect_stdout(io.StringIO()):
                module.main()
                apply.assert_not_called()
        self.assertTrue(self.settings.exists())

    def test_cli_purge_yes_passes_both_explicit_options_to_plan(self):
        app = Mock()
        app.plan.return_value = app
        with patch.object(module, 'Uninstaller', return_value=app), \
                patch.object(sys, 'argv', ['uninstall-mochi', '--yes', '--purge', '--remove-airdrop-system']), \
                patch.object(os, 'geteuid', return_value=1000), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(module.main(), 0)
        app.plan.assert_called_once_with(True, True)
        app.apply.assert_called_once()

    def test_standalone_installed_wrapper_works_without_a_checkout(self):
        directory = self.root / 'standalone/bin'
        directory.mkdir(parents=True)
        (directory / 'uninstall-mochi').write_bytes((REPO / 'uninstall-mochi.sh').read_bytes())
        (directory / 'uninstall-mochi.py').write_bytes((REPO / 'windows/scripts/uninstall-mochi.py').read_bytes())
        result = subprocess.run(['bash', str(directory / 'uninstall-mochi'), '--help'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--purge', result.stdout)
        self.assertIn('--check', result.stdout)
        self.assertIn('--remove-airdrop-system', result.stdout)


if __name__ == '__main__':
    unittest.main()
