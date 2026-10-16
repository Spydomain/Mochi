#!/usr/bin/env python3
"""Exercise OpenDrop's persistent mDNS identity without opening a radio."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import sys

spec = importlib.util.spec_from_file_location("opendrop.mochi_identity_test", Path(sys.argv.pop(1)))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class IdentityTests(unittest.TestCase):
    def test_stable_across_receiver_starts_and_explicit_override(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(os.environ, {"MOCHI_AIRDROP_SERVICE_ID": "04b3489ce4b7"}), \
                patch.object(module.AirDropConfig, "create_default_key"):
            first = module.AirDropConfig(airdrop_dir=directory)
            second = module.AirDropConfig(airdrop_dir=directory)
            self.assertEqual(first.service_id, second.service_id)
            self.assertEqual(first.service_id, "04b3489ce4b7")
            self.assertEqual(module.AirDropConfig(airdrop_dir=directory, service_id="fedcba987654").service_id,
                             "fedcba987654")

    def test_invalid_identity_fails_instead_of_advertising_it(self):
        for invalid in ("", "bad", "ABCDEF123456", "0123456789ab._airdrop._tcp.local."):
            with self.subTest(invalid=invalid), \
                    patch.dict(os.environ, {"MOCHI_AIRDROP_SERVICE_ID": invalid}), \
                    self.assertRaises(ValueError):
                module.AirDropConfig()

    def test_other_opendrop_clients_remain_unaffected(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(os.environ, {}, clear=True), \
                patch.object(module.AirDropConfig, "create_default_key"), \
                patch.object(module.random, "randint", return_value=0x123):
            self.assertEqual(module.AirDropConfig(airdrop_dir=directory).service_id,
                             "000000000123")


if __name__ == "__main__":
    unittest.main()
