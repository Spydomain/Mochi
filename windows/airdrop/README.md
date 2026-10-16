# MT7922 AirDrop source bundle

`../scripts/install-airdrop-mt7922.sh` fetches pinned third-party source,
applies the patches in this directory, builds it as the desktop user, and
installs only fixed-path, root-owned radio helpers. The patches are source
diffs, not a copy of the third-party repositories. Upstream source and license
files are kept in their own checkouts:

| Source | Pinned revision / version | Bundle |
| --- | --- | --- |
| [airdrop-mt7921](https://github.com/jedbillyb/airdrop-mt7921) | `27edf28900d6b9a948816ee5e864afe1ce245056` | `airdrop-mt7921-local.patch`, `opendrop-*`, `owl-*` |
| [OWL](https://github.com/jedbillyb/owl) | `832d70f815c3d4a06a02117bf0fc5e868daa1ff0` | `owl-local.patch` |
| [hostapd](https://w1.fi/hostapd/) | 2.11; SHA-256 verified by installer | `hostapd-p2p-go-iftype.patch` from [mt7921-dual-channel](https://github.com/jedbillyb/mt7921-dual-channel) |

Licensing: Mochi's [MIT license](../../LICENSE) does not replace upstream
terms. The airdrop-mt7921, OWL and mt7921-dual-channel sources and patches
are [GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html); hostapd is
[BSD-licensed](https://w1.fi/hostapd/) upstream. Refer to the license files
in each downloaded source checkout when redistributing these components.

The local patches include iOS 26 archive support, explicit consent, partial
transfer reporting, OWL receive/transmit fixes, dual-channel P2P-GO and
Wi-Fi coexistence. The tested radio is **only** MT7922 (`14c3:0616`,
`mt7921e`). Do not broaden the hardware gate or replace these revisions with
unreviewed HEADs. Unknown local source edits are left intact and stop setup.

`opendrop-verified-archive.patch` follows the existing incomplete-response
patch. iOS 26 can declare the decoded cpio size in `TotalBytes` while sending
a smaller compressed dvzip payload. Success now requires a parsed cpio trailer
and intact extracted files, not equality between unlike byte counts. Missing
trailers, broken gzip streams and partial members still fail closed. The
`airdrop-mt7921-upgrade-v1.patch` migrates **only** the exact previous Mochi
checkout to this patch series. Turn AirDrop off after any transfers finish
before installing; the installer refuses to replace an active receiver.

`opendrop-receive-workspace.patch` and `mochi_receive.py` stream uploads into
a private cache with bounded memory, validate the archive before reporting
success, and publish only whole files into the selected save folder. iOS
staging directories and sidecars stay private; incomplete archives remain in
`~/.local/state/mochi/airdrop/recovery` for recovery. The upload timeout measures
five minutes of inactivity, not total transfer duration.

`opendrop-stable-service-id.patch` reads Mochi's 12-digit hex service ID from
the receiver environment. The installer saves this ID in the per-user
`~/.config/airdrop/config` once, preventing each restart from advertising a
new device to iOS. Existing stale tiles on the phone may linger until its
AirDrop cache refreshes; only one receiver is advertised by Mochi.

`airdrop-mt7921-upgrade-v2.patch` adds the measured short-TAP-queue fix and a
receiver-owned Bluetooth discovery advert to the exact previously shipped
backend. The helper sets only `awdl0`'s transmit
queue to eight frames on each radio start; it does not throttle file data or
change the Wi-Fi station's queue. Packet timing on the development machine
showed the old 1000-frame queue delaying TCP acknowledgments by about 18
seconds; the short queue reduced typical delay to milliseconds and sustained
roughly 0.75–0.8 MB/s during a real iPhone upload, versus about 0.18 MB/s before
tuning. These are observations, not a speed guarantee: peer channel schedules
and radio conditions still cause variability. Temporary traffic-shaping
experiments are not part of the installed configuration. The receiver starts
one BlueZ advert while AirDrop is on and stops it on shutdown; it does not
reset the Bluetooth controller or change the managed Wi-Fi association.

`../../tests/airdrop-tap-queue-test.py` checks queue changes without root or
radio, including failure handling and isolation from the Wi-Fi interface.
`../../tests/airdrop-wake-lifecycle-test.sh` checks the advert starts once and
stops with the receiver using a fake script instead of BlueZ.

Rebuilding and consent tests are in `../../tests/airdrop-stack-test.sh` and
`../tests/airdrop-confirm.test.mjs`. Installing does not start a receiver;
an iPhone transfer is still needed to test the link and progress display.
