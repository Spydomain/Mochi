#!/usr/bin/env python3
"""Mochi's local, multi-file chooser. Emit NUL-delimited paths, never file data."""
import os
import signal
import sys


def choose_files(Gtk, GLib, signal_add):
    initialized = Gtk.init_check()
    if not (initialized[0] if isinstance(initialized, tuple) else initialized):
        raise RuntimeError("No graphical desktop is available for the file chooser.")
    chooser = Gtk.FileChooserNative.new("Send via AirDrop", None,
                                         Gtk.FileChooserAction.OPEN, "Send", "Cancel")
    chooser.set_select_multiple(True)
    chooser.set_local_only(True)
    # Deliberately no FileFilter: PDFs, unknown extensions and empty files are
    # selectable too. Native/portal handling is owned by GTK, not Omdrop.
    loop = GLib.MainLoop()
    selected = []
    def response(dialog, code):
        if code == Gtk.ResponseType.ACCEPT:
            selected.extend(dialog.get_filenames())
        loop.quit()
    def cancel():
        loop.quit()
        return GLib.SOURCE_REMOVE
    chooser.connect("response", response)
    sources = [signal_add(GLib.PRIORITY_HIGH, sig, cancel)
               for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)]
    try:
        chooser.show()
        loop.run()
    finally:
        # This also closes any portal request when the native operation is
        # cancelled, so an abandoned chooser is not left on the desktop.
        chooser.destroy()
        for source in sources:
            context = GLib.MainContext.default()
            if context.find_source_by_id(source) is not None:
                GLib.source_remove(source)
    return selected


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv not in ([], ["--check"]):
        print("Usage: mochi-airdrop-pick [--check]", file=sys.stderr)
        return 2
    try:
        import gi
        gi.require_version("Gtk", "3.0")
        from gi.repository import Gtk, GLib
        try:
            gi.require_version("GLibUnix", "2.0")
            from gi.repository import GLibUnix
            signal_add = GLibUnix.signal_add
        except (ValueError, ImportError):
            signal_add = GLib.unix_signal_add
        if argv == ["--check"]:
            return 0  # Validate dependencies without displaying a dialog.
        paths = choose_files(Gtk, GLib, signal_add)
        if not paths:
            return 1
        sys.stdout.buffer.write(b"".join(os.fsencode(path) + b"\0" for path in paths))
        return 0
    except Exception as error:
        print(f"Could not open Mochi's file chooser: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
