# iPhone Duo pickup watch

Built while looking for an iPhone Duo to gift my wife. The tracker helped me watch pickup availability and jump into Apple checkout when stock appeared. Checkout itself stayed manual.

Self-hosted stock alerts using a Cloudflare Worker and Durable Object, an optional signed Google Apps Script collector, and standards-based Web Push for an iPhone Home Screen web app.

This is a sanitized source release of a personal prototype. It is not an Apple product or a guaranteed inventory service. Apple may reject requests; blocked, stale or incomplete responses remain UNKNOWN. The collector respects Retry-After and persistent cooldowns. Do not bypass access controls or increase request rates to evade blocking.

## Features

- Exact product, store, unlocked price and selectable today/tomorrow pickup validation.
- Freshness expiry, stock-event history, alert deduplication and persistent scheduling.
- Encrypted Web Push and allowlisted Apple product links. iOS decides whether a link opens Safari or the Apple Store app.
- Observe-only checkout coordination and isolated rehearsal fixtures. There is no live browser executor, automatic ordering, payment submission or purchase guarantee.

## Requirements and checks

Use Node.js 22 or newer and npm. Run:

```sh
npm ci
npm test
npm run build
npm run test:runtime
npm run test:phone
npm run test:checkout
npm run test:native
```

The integration commands use local Workers/SQLite fixtures with mocked upstream services. They do not demonstrate live Apple access. `build` creates a dry-run Worker bundle, not a deployment.

## Configure your own installation

1. Choose your own Worker name in `wrangler.jsonc`. Replace `https://your-worker.example.com` in source with your own HTTPS Worker origin. Never point a fork at somebody else's deployment.
2. Review products, public example stores, location ZIP and timezone in `src/apple.mjs` and `google/Collector.gs` together. The sample ZIP is the public Holyoke store ZIP, not an owner's address. This prototype has intentionally strict product and price rules and is not a generic drop-in tracker for arbitrary models.
3. Create fresh high-entropy `ADMIN_TOKEN` and `SETUP_TOKEN` secrets. Set `PUSH_MODE` to `webpush`, and provide your own `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` using Cloudflare secret bindings. Generate keys using a trusted Web Push utility. Never commit keys, subscriptions or setup links.
4. For the Google collector, create your own Apps Script project from `google/Collector.gs`, set its Script Property `COLLECTOR_KEY` to a fresh 64-character lowercase hexadecimal key, and deploy a web app running as yourself with endpoint access suitable for Worker requests. The endpoint validates signed requests. Review Google's external-request permission and quotas before deploying. Set the Worker secret `GOOGLE_COLLECTOR_CONFIG` to JSON containing `url` (your Apps Script deployment URL) and `key` (the matching signing key). Do not commit this JSON. Review the collector configuration and tests before enabling it.
5. Deploy to your own account with `npm run deploy`. This creates/changes cloud resources and may have provider costs. Nothing in this source publication deploys or starts a monitor automatically.
6. Open `https://YOUR-WORKER/setup/YOUR-SETUP-TOKEN/` privately in Safari, add it to the Home Screen, open that app and enable notifications. Treat this URL as a private capability, not a share link.
7. Start or pause explicitly with `PICKUP_ADMIN_TOKEN` in your local environment and `node tools/control.mjs https://YOUR-WORKER start` or `pause`. Use `status` to inspect current evidence. The `test` command sends a real test notification on a configured deployment.

The native Mac collector is a legacy optional experiment and is not required for the cloud source. Its installation commands create a login agent and must not be run merely to test the code. Historical fixture card suffixes and order identifiers have been replaced with unmistakable dummy values. Checkout stays observe-only; these placeholders are not purchase authorization.

## Privacy and security

This release excludes deployment credentials, runtime state, browser captures, personal transaction history, private project URLs, generated native installers, dependencies and build outputs. Never copy a private deployment directory wholesale into a public repository. `.gitignore` is defense in depth, not a secret scanner. Keep owner APIs and setup links private, use separate credentials per installation, and review changes before deployment.

## Limitations

The upstream retail endpoint is undocumented for developer polling and has no promised SLA. Ten-second scheduling is an implementation target, not a reliability promise; rejected requests create gaps. Provider quotas and current pricing must be checked independently. Notification arrival does not reserve stock. This release has no license grant yet; the owner must choose a license before it should be described as open-source.
