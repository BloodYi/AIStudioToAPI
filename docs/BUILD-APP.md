# Required first step: create your own Build App

**This repository does not include a usable default app. Create your own Google AI Studio Build App before starting the gateway.** An empty or invalid `AI_STUDIO_APP_URL` stops startup with setup instructions.

This workflow follows the ownership and sharing approach in [yunx738/ais2api's Build App tutorial](https://github.com/yunx738/ais2api/blob/main/docs/BUILD-APP.md), adapted to this repository. That project's `black-browser.js`, management buttons, and `TARGET_URL` slots are not used here.

## 1. Create the app in your Google account

Sign in to [Google AI Studio Build](https://aistudio.google.com/apps) with the account that will own the app and create a blank web app. Keep this owner account available so you can maintain the app.

## 2. Install this repository's bridge client

Copy these three files from the same checkout of this repository into the root of the Build App:

- [`scripts/client/index.html`](../scripts/client/index.html)
- [`scripts/client/build.js`](../scripts/client/build.js)
- [`scripts/client/package.json`](../scripts/client/package.json)

The supplied `index.html` loads `/build.js` as a module and initializes the parent-page account handshake. Keep both parts intact. Use this repository's client rather than another project's similarly named script.

If using AI Studio's assistant to add the files, ask it to preserve their contents and the existing license notices. Do not let it replace the bridge with a sample Gemini chat, add a Gemini API key, or invent a connected state. Save the files and confirm that the app builds.

Keep `ws://127.0.0.1:9998` in the client unchanged. Inside a gateway browser this points to the gateway container. A WebSocket connection error when previewing the app on your own computer is expected if that computer is not running the gateway. Cloud Run deployment is not required for this bridge.

## 3. Share with the accounts you will import

Open **Share** in AI Studio. To support your whole account pool, set **General access** to **Public: Anyone with the link can view**. People with the link can view the app and its code. Alternatively, grant access to every individual account that will use the gateway.

Do not include cookies, gateway login keys, passwords, or private server configuration in the app files. Keep the app available to your account pool; deleting it or revoking access breaks those connections.

Copy the app URL from your browser's address bar. Both of these URL forms are supported, including preview query parameters:

```text
https://aistudio.google.com/apps/YOUR_APP_ID
https://ai.studio/apps/YOUR_APP_ID
```

Drive-based `/apps/drive/FILE_ID` links are also supported. The placeholders above are examples; they are rejected by the startup check.

## 4. Configure and start the gateway

Clone this repository and copy `.env.example` to `.env`. Set the real app URL and your own gateway credentials:

```dotenv
AI_STUDIO_APP_URL=https://aistudio.google.com/apps/REPLACE_WITH_YOUR_REAL_APP_ID
API_KEYS=replace-with-a-strong-api-key
WEB_CONSOLE_USERNAME=admin
WEB_CONSOLE_PASSWORD=replace-with-a-strong-password
CHECK_UPDATE=false
```

Use the actual URL of the app you just created. The gateway cannot create the app or establish your ownership from a URL alone; the startup check validates the URL format, and the live connection verifies access and the client handshake.

```bash
docker compose up -d --build
docker compose logs -f app
```

For a source installation, follow the [English setup guide](../README_EN.md) after creating the app. Recreate the Compose container after changing `.env` so the new environment is loaded.

## 5. Verify every account

Import an account through the gateway console. Wait for its browser connection to become ready before testing a model. For multiple accounts, verify that each account can open the same app.

- `Page not found`: check the exact URL and app-sharing access for the failing account.
- WebSocket timeout: confirm the app contains the matching `build.js` and `index.html`, can build, and is accessible to that account.
- Missing Pro quota: the account must be connected and its paid entitlement confirmed. Each confirmed usable Pro contributes 50 daily requests to the displayed Argon estimate; imported-account count alone is insufficient.

After updating the gateway's bridge implementation, replace the Build App client files from the matching checkout and save again. Never substitute another person's app URL as a fallback.
