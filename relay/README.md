# Optional iPhone Live Activity relay

This Cloudflare Worker forwards Mochi activity from the macOS app to Apple Push Notification service (APNs), so a paired iPhone can show the activity in the Dynamic Island and on the Lock Screen while the Mac is locked. The APNs signing key stays in Worker secrets; it must never be packaged with a desktop or phone app.

![Mochi Live Activity on an iPhone](../docs/media/iphone-live-activity.jpg)

*Example from the Apple-platform integration. The relay is not required for the Linux or Windows app.*

```text
Mac app ── activity state + iPhone push token ──▶ your Cloudflare Worker ──▶ APNs ──▶ iPhone
```

## Before you deploy

You need an Apple Developer team with APNs access, an iOS app configured for Live Activities and push notifications, a Cloudflare account, and Node.js/npm. The `APNS_TOPIC` must match your iOS app's bundle identifier followed by `.push-type.liveactivity`. The repository's `wrangler.toml` contains project-specific example team/topic values; replace them with values for **your** Apple Developer team and iOS build.

The macOS source currently has a default relay URL pointing to an existing deployment. If you deploy your own Worker, set the Mac app's `phoneRelayURL` preference to **your** URL before enabling the feature. This avoids sending activity tokens and state to that default deployment.

## Deploy your Worker

1. In Apple Developer, create an APNs signing key and download its `AuthKey_*.p8` file. Save its Key ID and your Team ID. Treat the key file as a secret; Apple may allow only one download.
2. Edit `relay/wrangler.toml`: set `APNS_TEAM_ID` and `APNS_TOPIC` for your Apple account and app. Do not put the private key in this file.
3. From the `relay` directory, install dependencies and add the two Worker secrets:

   ```bash
   npm ci
   npx wrangler login
   npx wrangler secret put APNS_KEY_ID
   npx wrangler secret put APNS_KEY < /secure/path/AuthKey_XXXXXXXXXX.p8
   npm run typecheck
   npm run deploy
   ```

   At the `APNS_KEY_ID` prompt, enter the Key ID. Replace the example file path with the downloaded key file's actual path; input redirection sends the entire PEM file to Wrangler without putting its contents in shell history or a command argument. Keep the file private.

4. Verify the deployment URL printed by Wrangler:

   ```bash
   curl https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/
   ```

   A healthy Worker replies `Mochi relay`. This only checks the route; a real Live Activity additionally requires working Apple credentials, entitlements, a valid phone token, and a paired Mac/iPhone.

5. On the Mac, point Mochi at your deployed Worker, then restart the Mac app:

   ```bash
   defaults write fr.louisraille.NotchBuddy phoneRelayURL "https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev"
   ```

   The preference domain above comes from the current macOS source. If you change the app's bundle identifier, use its new preference domain. Enable the iPhone Live Activity integration in the Mac app after configuring the URL.

## Request contract

The Mac app posts `POST /v1/live-activity` with an iPhone Live Activity push token, APNs environment (`development` or `production`), event (`start`, `update`, or `end`), and a bounded activity state. That state includes the agent name, visual state, short status text, counters, and optionally a SHA-256 fingerprint for a pending approval. The Worker validates known fields and forwards a constructed payload to APNs; it does not accept arbitrary notification content.

| Response | Meaning |
| --- | --- |
| `200` | APNs accepted the request. |
| `400` / `413` | Invalid request or oversized declared body. |
| `410` | APNs says the token is no longer valid. |
| `502` | APNs or relay delivery failed; inspect `x-apns-status`. |

`GET /` is a simple health response, not an end-to-end push test.

## Security and privacy

The Worker code has no database and its Wrangler configuration disables observability, but requests pass through Cloudflare and Apple. They include a push token and activity status; treat both as sensitive. The current `POST` route has **no independent caller authentication or rate limiting**. A public deployment should add suitable access control and abuse protection, and the Mac client must be configured to use it. Do not publish APNs keys, push tokens, or request bodies in issues or logs. Review Cloudflare and Apple data handling for your deployment.

For the primary desktop install, return to the [Mochi guide](../README.md).

**Mochi is a modified version of [Coucou](https://github.com/Louis-CFM/coucou). Special thanks to [Louis-CFM](https://github.com/Louis-CFM) and the Coucou project for the original foundation.**
