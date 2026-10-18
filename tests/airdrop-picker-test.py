#!/usr/bin/env python3
"""Desktop chooser lifecycle tests: no display, service, radio or transfer."""
import importlib.util
import io
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

source = Path(__file__).resolve().parents[1] / "windows/scripts/mochi-airdrop-pick.py"
spec = importlib.util.spec_from_file_location("mochi_picker", source)
picker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(picker)


class PickerTests(unittest.TestCase):
    def environment(self, answer="accept"):
        callbacks = {}
        paths = ["/files/document.pdf", "/files/image.png", "/files/unknown", "/files/line\nbreak.zip"]
        dialog = Mock()
        dialog.connect.side_effect = lambda event, callback: callbacks.update(response=callback)
        dialog.get_filenames.return_value = paths
        Gtk = SimpleNamespace(init_check=lambda: (True, []), FileChooserNative=Mock(new=Mock(return_value=dialog)),
                              FileChooserAction=SimpleNamespace(OPEN=1), ResponseType=SimpleNamespace(ACCEPT=2))
        def run():
            if answer == "signal":
                callbacks[1]()
            elif answer == "error":
                raise RuntimeError("desktop disappeared")
            else:
                callbacks["response"](dialog, 2 if answer == "accept" else 0)
        loop = SimpleNamespace(run=run, quit=Mock())
        GLib = SimpleNamespace(MainLoop=lambda: loop, PRIORITY_HIGH=-100, SOURCE_REMOVE=False,
                               MainContext=SimpleNamespace(default=lambda: SimpleNamespace(find_source_by_id=lambda _id: object())),
                               source_remove=Mock())
        def signal_add(priority, sig, callback):
            index = 1 + len([key for key in callbacks if isinstance(key, int)])
            callbacks[index] = callback
            return index
        return Gtk, GLib, signal_add, dialog, paths

    def test_selects_all_regular_file_types_without_filtering(self):
        Gtk, GLib, signal_add, dialog, paths = self.environment()
        self.assertEqual(picker.choose_files(Gtk, GLib, signal_add), paths)
        dialog.set_select_multiple.assert_called_once_with(True)
        dialog.set_local_only.assert_called_once_with(True)
        dialog.add_filter.assert_not_called()
        dialog.destroy.assert_called_once()
        self.assertEqual(GLib.source_remove.call_count, 3)

    def test_cancel_and_signals_close_the_native_request(self):
        for answer in ("cancel", "signal"):
            with self.subTest(answer=answer):
                Gtk, GLib, signal_add, dialog, _ = self.environment(answer)
                self.assertEqual(picker.choose_files(Gtk, GLib, signal_add), [])
                dialog.destroy.assert_called_once()

    def test_unexpected_desktop_failure_also_destroys_the_dialog(self):
        Gtk, GLib, signal_add, dialog, _ = self.environment("error")
        with self.assertRaisesRegex(RuntimeError, "desktop disappeared"):
            picker.choose_files(Gtk, GLib, signal_add)
        dialog.destroy.assert_called_once()

    def test_missing_display_fails_before_showing_a_dialog(self):
        Gtk, GLib, signal_add, _, _ = self.environment()
        Gtk.init_check = lambda: (False, [])
        with self.assertRaisesRegex(RuntimeError, "No graphical desktop"):
            picker.choose_files(Gtk, GLib, signal_add)
        Gtk.FileChooserNative.new.assert_not_called()

    def test_check_never_opens_a_dialog_and_paths_are_nul_delimited(self):
        Gtk, GLib, signal_add, _, paths = self.environment()
        gi = SimpleNamespace(require_version=Mock())
        repository = SimpleNamespace(Gtk=Gtk, GLib=GLib, GLibUnix=SimpleNamespace(signal_add=signal_add))
        with patch.dict(sys.modules, gi=gi, **{"gi.repository": repository}), patch.object(picker, "choose_files", return_value=paths) as choose:
            self.assertEqual(picker.main(["--check"]), 0)
            choose.assert_not_called()
            output = io.BytesIO()
            with patch.object(sys, "stdout", SimpleNamespace(buffer=output)):
                self.assertEqual(picker.main([]), 0)
            self.assertEqual(output.getvalue(), b"".join(path.encode() + b"\0" for path in paths))


if __name__ == "__main__":
    unittest.main()
