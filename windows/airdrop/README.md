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

The local patches include iOS 26 archive support, explicit consent, partial
transfer reporting, OWL receive/transmit fixes, dual-channel P2P-GO and
Wi-Fi coexistence. The tested radio is **only** MT7922 (`14c3:0616`,
`mt7921e`). Do not broaden the hardware gate or replace these revisions with
unreviewed HEADs. Unknown local source edits are left intact and stop setup.

Rebuilding and consent tests are in `../../tests/airdrop-stack-test.sh` and
`../tests/airdrop-confirm.test.mjs`. Installing does not start a receiver;
an iPhone transfer is still needed to test the link and progress display.
