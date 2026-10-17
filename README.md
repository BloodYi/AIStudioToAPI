# AIStudioToAPI

A self-hosted API gateway for Google AI Studio Build Apps, with multi-account scheduling, automatic Pro/Ultra detection, and a usage dashboard.

[English setup guide](README_EN.md) | [中文文档](README_ZH.md) | [License](LICENSE)

## Highlights

- **Automatic Pro/Ultra enrollment:** imported accounts are checked individually while idle. Confirmed paid accounts can use `gemini-4-argon` without a manually maintained allowlist.
- **Pro quota aggregation:** each confirmed usable Pro account contributes **50 requests per day** to the Argon estimate. Usage is deducted per account and remaining allowances are combined.
- **Separate Ultra reporting:** Ultra entitlement enables dispatch, while its unverified quota is shown as unknown.
- **Session-aware records:** entitlement records survive restarts and are invalidated when login data changes. Expired, disabled, and unavailable accounts do not contribute to the estimate.
- **Your own Build App:** configure `AI_STUDIO_APP_URL` with a compatible app accessible to your imported accounts.
- **Clearer model cards:** Argon appears first; models without known quotas are labeled accordingly.

The inherited service includes OpenAI-, Gemini-, and Anthropic-compatible endpoints, account imports, queues, per-model cooldowns, proxy management, and usage statistics. Model availability depends on Google and account permissions.

## Quick start

Requirements: Docker Engine or Docker Desktop, Docker Compose v2, and an account that can access your configured AI Studio Build App.

```bash
git clone https://github.com/BloodYi/AIStudioToAPI.git
cd AIStudioToAPI
cp .env.example .env
```

Set your own credentials in `.env`:

```dotenv
API_KEYS=replace-with-a-strong-api-key
WEB_CONSOLE_USERNAME=admin
WEB_CONSOLE_PASSWORD=replace-with-a-strong-password
AI_STUDIO_APP_URL=https://ai.studio/apps/YOUR_APP_ID
CHECK_UPDATE=false
```

The Build App must use the compatible bridge client in [`scripts/client`](scripts/client). Each imported account must be able to open that app; a paid subscription alone does not provide app access.

```bash
docker compose up -d --build
```

Open `http://localhost:7860`, sign in, and import your accounts. The included Compose configuration binds to loopback; configure your own HTTPS proxy or tunnel for remote access.

OpenAI-compatible base URL: `http://localhost:7860/v1`. Use your `API_KEYS` value for authentication and query `GET /v1/models` for the available model catalog. See the [English setup guide](README_EN.md) for browser installation, additional protocols, and configuration.

## Quotas and verification

The 50-request Pro allowance is a **dashboard estimate**, not an allowance granted or guaranteed by Google. Actual upstream limits remain authoritative. Accounting follows the scheduler's Pacific-time day boundary. Ultra quota is not assumed to equal Pro quota.

These changes passed 156 local regression checks, quota-card rendering checks, frontend builds, and 11 isolated server browser checks. An existing live Pro account was automatically detected and completed an Argon request after removal of the manual allowlist. Multiple-Pro aggregation and Ultra behavior were tested with fixtures; a second live Pro account and a live Ultra account have not been validated.

```bash
node --test tests/auto-benefit.test.js tests/model-scheduler.test.js tests/browser-workers.test.js tests/browser-recovery.test.js
node tests/quota-cards.test.cjs
npm run build:ui
```

Real-browser entitlement fixtures additionally require Playwright Firefox and OpenSSL; see the setup guide.

## Attribution and license

This independent derivative is based on [Naoya666/AIStudioToAPI](https://github.com/Naoya666/AIStudioToAPI) at revision `b1512d69faa045a28da0ba3514df72793811923d`, which derives from [iBUHub/AIStudioToAPI](https://github.com/iBUHub/AIStudioToAPI) and [Ellinav/ais2api](https://github.com/Ellinav/ais2api).

Existing author credits, source notices, and the **Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)** license are retained. Changes here include automatic entitlement enrollment, Pro quota aggregation, Build App URL configuration, and a narrower app-initialization failure check. This project is not affiliated with Google.
