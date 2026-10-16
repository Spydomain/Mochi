# Mochi AirDrop on Linux

Mochi can control an optional AWDL/AirDrop backend for exchanging files with nearby Apple devices. This guide covers the experimentally supported MediaTek MT7922 receiver, its source bundle, and safe diagnostics. It is not a Windows feature and does not use the optional Apple Live Activity relay.

[Project overview and Linux install](../../README.md) · [Desktop development](../README.md) · [Optional iPhone relay](../../relay/README.md)

![A real incoming iPhone photo request in Mochi](../../docs/media/mochi-airdrop-request.png)

*Captured from the running Linux build on October 16, 2026. The photo was accepted explicitly, its archive trailer was verified, and the receiver returned HTTP 200. [Watch the edited desktop recording](../../docs/media/mochi-demo.mp4).*

## Support and limitations

| Requirement | Current scope |
| --- | --- |
| Automated radio setup | MT7922 PCI ID `14c3:0616`, driver `mt7921e`. Other adapters are not enabled by this installer. |
| Desktop session | Linux with a running systemd user manager for the independent receiver service. |
| Wi-Fi | An existing 5 GHz association; shared P2P-GO mode keeps that association rather than deliberately disconnecting it. |
| Nearby iPhone | Wi-Fi and Bluetooth enabled; use Everyone for 10 Minutes during testing. |
| Verified direction | iPhone → Mochi on the development machine. Sending from Mochi to an iPhone remains unverified. |
| Performance | Experimental shared-radio behavior; discovery, throughput, and Wi-Fi responsiveness can vary. |

The recorded test received a 2.17 MB photo at a receiver-reported average of about 0.37 MB/s. That is one observation, **not a maximum-speed claim or a hardware compatibility guarantee**. Shared-radio operation can still stall the driver; do not rely on it during critical network activity. No extra iPhone app is required.

## Install and update

From the repository root, as your desktop user:

```bash
./mochi-full-setup.sh --check
./mochi-full-setup.sh
```

Setup detects supported hardware, fetches pinned source, builds as the desktop user, and asks for administrator privileges when installing fixed-path, root-owned radio helpers. It does not start the radio. Review the installer and its upstream components first. Use `--no-airdrop` to install Mochi without this optional backend.

For updates, run `./update-mochi.sh` from a clean checkout. A verified, current receiver can remain active through a normal app update. If radio components need replacement, finish the transfer, select **Turn off**, and rerun the updater. Backend installation refuses an active receiver or listener on TCP 8771; it does not stop a live transfer to force an upgrade. Unknown local source edits are preserved for manual review.

Read-only backend checks, also from the repository root:

```bash
bash windows/scripts/install-airdrop-mt7922.sh --check
bash windows/scripts/install-airdrop-mt7922.sh --verify
```

`--check` reports hardware eligibility. `--verify` checks the pinned installed components, persistent identity, and configured consent hook on eligible hardware. Neither command proves that an iPhone can discover or transfer to the machine; a successful skip on unsupported hardware is not a compatibility result.

## Receive a file

1. In **Settings → AirDrop (Linux)**, choose the advertised device name and an existing, user-owned absolute save folder. An empty folder setting uses `~/Downloads`. Turn AirDrop off and on after changing either setting.
2. Enable **AirDrop** in Mochi and wait for the receiver to report ready.
3. On the iPhone, open the file's **Share → AirDrop** sheet and choose Mochi, which may appear under **Other Devices**.
4. Check the sender and item shown in Mochi. Click **Accept** within 15 seconds; otherwise the request is declined. Click **Decline** for an unfamiliar request.
5. Wait for the completion check. Keep the originals on the iPhone until the received files have been checked.

The consent hook accepts only an explicit island decision. A missing app, an expired prompt, a malformed request, or a conflicting consent request fails closed. Do not work around a missed prompt by enabling blanket automatic acceptance.

Answers are bound to one request ID and published atomically, so an expired
request's answer cannot accept its successor. The receiver requires a fresh,
single-use accepted `/Ask` before reading a file upload. The grant is scoped
to the peer address and expires after two minutes; it is not cryptographic
device authentication. Control-request bodies are bounded to 1 MiB before
plist parsing. Share links are limited to HTTP(S), and a link acceptance does
not authorize a later file upload.

The security-patched receiver was retested on October 16: consent was published
about one second after `/Ask`, the user accepted, and a 3.67 MB iPhone photo
was extracted into the selected folder with a verified trailer and HTTP 200.
Discovery delays before `/Ask` remain possible on this experimental link.

The compact transfer indicator measures upload bytes and is capped at 99% until extraction is verified. With compressed iOS dvzip, the sender's `TotalBytes` can describe the decoded archive rather than wire bytes. Completion therefore requires a valid archive trailer and intact extraction, not a matching size alone. The receive timeout is five minutes **without incoming data**, not a five-minute total transfer limit.

![The compact indicator after a verified receive](../../docs/media/mochi-airdrop-received.png)

## Radio and session lifecycle

The receiver runs as `mochi-airdrop.service`, independently of the app window. Closing or restarting Mochi does not stop an enabled radio session; select **Turn off** to stop it. Logout ends the user service. The receiver owns one Bluetooth discovery advertisement while active and removes it on shutdown. It does not reset the Bluetooth controller or intentionally switch the managed Wi-Fi network.

Mochi's coexistence helper temporarily disables Wi-Fi station power saving while the radio is shared and restores the previous setting when AirDrop stops. This can increase battery use while enabled. The backend may temporarily stop Avahi/mDNS; shared mode is not a promise of uninterrupted Wi-Fi.

A persistent 12-digit hexadecimal service ID is saved in `~/.config/airdrop/config` and passed to OpenDrop. Restarting the receiver reuses that identity rather than advertising a new device. Old iPhone discovery tiles may persist until the phone refreshes its cache.

## Storage and recovery

The following are default locations; corresponding XDG environment overrides are respected:

| Data | Default location |
| --- | --- |
| Received user files | Selected save folder, or `~/Downloads`. |
| Active private staging | `~/.cache/mochi/airdrop/`. |
| Incomplete workspaces and retained edit sidecars | `~/.local/state/mochi/airdrop/recovery/`. |
| Radio configuration and persistent identity | `~/.config/airdrop/config`. |
| Consent and progress state | `$XDG_RUNTIME_DIR/mochi-airdrop/`. |
| Backend runtime log | `$XDG_RUNTIME_DIR/airdropd/airdropd.log`. |

The streaming workspace uses bounded-memory processing. Only whole user files are published into the save folder; iOS wrapper directories, raw archives, and partial members are not presented as completed downloads. Existing files are not overwritten: identical content can be deduplicated and conflicting names receive a suffix. Complete members can be recovered from an incomplete upload, but the **overall transfer still fails** and its remaining workspace is retained privately. Recovery data consumes disk space even though it is outside the save folder.

Older builds may have left `airdrop-received-*.dvzip`, `.cpio`, `.partial`, or iOS staging directories in a dedicated save folder. To inspect those artifacts without changing them, replace the example path with your actual dedicated folder:

```bash
python3 windows/scripts/recover-airdrop-files.py /absolute/path/to/airdrop-folder
```

After reviewing the report, finish all transfers and turn AirDrop off. To recover verified whole members and **move** the original work artifacts into private recovery storage, run:

```bash
python3 windows/scripts/recover-airdrop-files.py /absolute/path/to/airdrop-folder --apply
```

The default is a dry run. `--apply` changes files: originals are preserved in a timestamped recovery directory with a manifest, not deleted. Do not use your home directory or filesystem root as the save-folder argument. The recovery tool refuses to apply while a receiver is active.

## Sending and other adapters

To attempt Mochi → iPhone sharing, keep the phone unlocked with Everyone for 10 Minutes enabled, **close** its Share → AirDrop sheet, click **Find iPhone**, and select the named recipient before choosing files. On the MT7922 route, discovery uses a Bluetooth wake advertisement followed by an AWDL scan and may take about 30 seconds. Mochi passes the selected service ID to the sender instead of silently selecting the first device. This direction remains unverified on the development machine.

Other adapters require a separately configured backend such as Omdrop. See the [main guide's Omdrop instructions](../../README.md#other-linux-wi-fi-adapters-omdrop) for its dependency setup, adapter selection, firewall notes, and different consent behavior. A separate supported USB adapter can keep the internal radio free for normal Wi-Fi. Mochi's MT7922 name and save-folder controls do not configure Omdrop.

## Diagnostics

```bash
systemctl --user status mochi-app.service mochi-airdrop.service
journalctl --user -u mochi-airdrop.service -n 80 --no-pager
tail -n 40 "$XDG_RUNTIME_DIR/mochi-airdrop/hook.log"
tail -n 80 "$XDG_RUNTIME_DIR/airdropd/airdropd.log"
```

The app service command applies to the Niri installation; other desktops use XDG autostart for the app. Runtime files exist only after the relevant receiver or consent activity has occurred.

| Symptom | First check |
| --- | --- |
| Mochi is absent from the iPhone picker | Confirm receiver readiness, 5 GHz Wi-Fi, Bluetooth, and an open iPhone Share → AirDrop sheet. Allow discovery time. |
| Automatic decline | Check `hook.log` for expiry, a conflicting request, or an unavailable consent hook. An unanswered prompt expires in 15 seconds. |
| Upload stalls or fails | Keep the source file, test a smaller transfer nearby, inspect the backend log, and check private recovery storage. |
| App update asks to stop AirDrop | The installed backend needs replacement; finish the transfer and turn it off before retrying. |
| Wi-Fi becomes slow | Turn AirDrop off after transfers finish. Shared MT7922 operation remains experimental. |

Logs may include sender names, filenames, network identifiers, and tokens. **Redact them before sharing** through [GitHub Issues](https://github.com/Spydomain/Mochi/issues) or [contactme@bikashkumarsarraf.com.np](mailto:contactme@bikashkumarsarraf.com.np). Mochi does not add a cloud relay to this path, but local receipt still exposes a service to nearby peers while enabled.

## Pinned source bundle

[`install-airdrop-mt7922.sh`](../scripts/install-airdrop-mt7922.sh) fetches the following third-party source and applies the diffs in [`patches/`](patches/). Upstream license files stay in their downloaded checkouts.

| Source | Pinned revision / version | Local bundle |
| --- | --- | --- |
| [airdrop-mt7921](https://github.com/jedbillyb/airdrop-mt7921) | `27edf28900d6b9a948816ee5e864afe1ce245056` | `airdrop-mt7921-local.patch`, OpenDrop and OWL overlays. |
| [OWL](https://github.com/jedbillyb/owl) | `832d70f815c3d4a06a02117bf0fc5e868daa1ff0` | `owl-local.patch`. |
| [hostapd](https://w1.fi/hostapd/) | 2.11, SHA-256 verified by the installer. | P2P-GO interface patch from [mt7921-dual-channel](https://github.com/jedbillyb/mt7921-dual-channel). |

The patches cover iOS 26 archives, explicit consent, verified extraction, private receive workspaces, persistent discovery identity, OWL receive/transmit handling, P2P-GO operation, and Wi-Fi coexistence. Upgrade deltas apply only to recognized previously shipped patch trees. Do not broaden the hardware gate or substitute unreviewed upstream HEAD revisions.

The installed queue change sets only `awdl0`'s transmit queue to eight frames, leaving the station queue alone. It addresses acknowledgment latency observed with a large TAP queue; it does not guarantee a particular file-transfer rate. Temporary traffic-shaping experiments are not installed as production configuration.

## Regression checks

From the repository root, without starting a radio or invoking sudo:

```bash
python3 tests/airdrop-receive-test.py --no-network
bash tests/setup-airdrop-lifecycle-test.sh
bash tests/setup-installer-test.sh
bash tests/setup-airdrop-receiver-test.sh
bash tests/setup-distro-test.sh
bash tests/update-mochi-test.sh
bash tests/airdrop-stack-test.sh
```

The stack check recreates patched source in isolated checkouts when the local pinned backend sources are present; otherwise those portions report a skip. It exercises queue isolation, Bluetooth advertisement lifecycle, receiver overlays, archive validation, and identity checks where the required sources are available. These checks do not replace a real nearby-device transfer.

Interface and consent regressions run with the shared desktop test suite:

```bash
cd windows
npm test
```

## Licensing and acknowledgments

Mochi's [MIT License](../../LICENSE) does not replace upstream terms. The airdrop-mt7921, OWL, and mt7921-dual-channel sources and patches retain their [GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html) terms; hostapd retains its upstream BSD licensing. Consult the license files in each downloaded source checkout before redistributing those components.

**Mochi is a modified version of [Coucou](https://github.com/Louis-CFM/coucou). Special thanks to [Louis-CFM](https://github.com/Louis-CFM) and the Coucou project for the original foundation.** Thanks also to the upstream AirDrop, OWL, OpenDrop, and radio-helper maintainers whose work makes this experimental integration possible.
