# Mochi media captures

The current Linux screenshots and demo were captured from the running Mochi application on October 18, 2026, on a Niri desktop with MediaTek MT7922 hardware. The AirDrop prompt, explicit user acceptance, progress, and completion are from a real iPhone transfer, not simulated application events.

| File | Content |
| --- | --- |
| [mochi-overview.png](mochi-overview.png) | Clock, local weather, companion pills, battery, AirDrop, and Awake. |
| [mochi-airdrop-request.png](mochi-airdrop-request.png) | The incoming video request with explicit Decline and Accept buttons. |
| [mochi-airdrop-progress.png](mochi-airdrop-progress.png) | The compact indicator during the actual receive. |
| [mochi-airdrop-received.png](mochi-airdrop-received.png) | The compact completion check after verified extraction. |
| [mochi-demo.gif](mochi-demo.gif) | The looping, 27-second interface demonstration. |
| [mochi-demo.mp4](mochi-demo.mp4) | The same edit as H.264 video, without audio. |

## Editing and privacy

Only the application's top-of-screen region was recorded. A temporary, click-through dark backdrop hid unrelated desktop windows without changing Mochi's interface. That backdrop and the recorder were stopped afterward; no capture helper was installed into Mochi or its autostart configuration.

The edit joins real-time excerpts of Clock, consent, receiving, verification, and completion. Waiting intervals are omitted, and compact indicators are cropped and enlarged for readability. Neither the file bytes nor the on-screen transfer percentages were altered. The GIF and MP4 are 720 × 200 at eight frames per second. They are demonstrations, not elapsed-time benchmarks.

No microphone, system audio, or transferred-file contents are included. The consent prompt intentionally shows the demo device name and filename; never use sensitive files or identifying device names for public captures. Private raw recordings and debugging logs are not part of this media directory.

## Observed transfer

The receiver verified the archive trailer, extracted a 76.44 MB MOV, and returned HTTP 200. It reported an average of about 1.01 MB/s; `ffprobe` could read the saved video's container and stream metadata. The receiver also logged an incomplete HTTP-ending warning after the verified archive arrived. This capture does not establish a clean peer-side close, maximum throughput, universal adapter compatibility, or outgoing transfer performance.

Older files in this directory remain historical references; the October 18 capture does not retest Windows, macOS, iOS Live Activities, or the optional push relay.
