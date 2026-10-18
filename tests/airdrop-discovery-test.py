#!/usr/bin/env python3
"""Sender regressions without radio access or sending files to any device."""
import ast
import json
import logging
import os
from pathlib import Path
from types import SimpleNamespace
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock


def method(path, classname, name, scope):
    tree = ast.parse(Path(path).read_text())
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == classname)
    node = next(node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name == name)
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), str(path), "exec"), scope)
    return scope[name]


client, cli = sys.argv[1:3]
del sys.argv[1:3]
browser_scope = {}
browser_init = method(client, "AirDropBrowser", "__init__", browser_scope)
cli_scope = {"os": os, "time": time, "json": json, "logger": logging.getLogger("test")}
recipient = method(cli, "AirDropCli", "_get_receiver_info", cli_scope)


class DiscoveryTests(unittest.TestCase):
    def test_linux_browser_uses_isolated_reply_socket_without_changing_macos(self):
        for system, unicast, apple_p2p in (("Linux", True, False), ("Darwin", False, True)):
            with self.subTest(system=system):
                factory = Mock()
                browser_scope.update(Zeroconf=factory, IPVersion=SimpleNamespace(V6Only="ipv6"),
                                     platform=SimpleNamespace(system=lambda: system),
                                     AirDropUtil=SimpleNamespace(get_ip_for_interface=lambda *a, **kw: "fe80::1"))
                browser = SimpleNamespace()
                browser_init(browser, SimpleNamespace(interface="awdl0"))
                factory.assert_called_once_with(interfaces=["fe80::1"], ip_version="ipv6",
                                                apple_p2p=apple_p2p, unicast=unicast)
                self.assertIs(browser.zeroconf, factory.return_value)

    def test_missing_awdl_address_fails_before_creating_discovery_socket(self):
        factory = Mock()
        browser_scope.update(Zeroconf=factory,
                             AirDropUtil=SimpleNamespace(get_ip_for_interface=lambda *a, **kw: None))
        with self.assertRaisesRegex(RuntimeError, "IPv6"):
            browser_init(SimpleNamespace(), SimpleNamespace(interface="awdl0"))
        factory.assert_not_called()

    def test_exact_service_ids_never_become_an_index_or_fallback_name(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "discovery.json"
            rows = [{"id": "abcdef123456", "name": "Mochi"},
                    {"id": "000000000000", "name": "Selected iPhone"},
                    {"id": "111111111111", "name": "Other iPhone"},
                    {"id": "fedcba987654", "name": "222222222222"}]
            report.write_text(json.dumps(rows))
            for selected, expected in (("000000000000", rows[1]), ("111111111111", rows[2]),
                                       ("ABCDEF123456", rows[0]), ("222222222222", None),
                                       ("333333333333", None), ("9", None), ("-1", None),
                                       ("1", rows[1]), ("Selected iPhone", rows[1])):
                with self.subTest(selected=selected):
                    cli = SimpleNamespace(receiver=selected, config=SimpleNamespace(discovery_report=str(report)))
                    self.assertEqual(recipient(cli), expected)
                    self.assertEqual(cli.receiver, selected, "selection must remain a string")

    def test_missing_report_returns_no_recipient(self):
        with tempfile.TemporaryDirectory() as directory:
            cli = SimpleNamespace(receiver="abcdef123456", config=SimpleNamespace(discovery_report=str(Path(directory) / "missing")))
            self.assertIsNone(recipient(cli))


if __name__ == "__main__":
    unittest.main()
