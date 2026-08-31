# Zen Marketplace Bot

Production-ready Discord marketplace and order-management bot for Roblox communities. Customers verify their Roblox account, get tracked for community membership, and place persistent orders through private ticket channels. Staff manage products, eligibility, and the full order lifecycle.

Built with TypeScript (strict), discord.js v14, PostgreSQL, and Prisma. All workflow state lives in the database — bot restarts never lose orders, tickets, or verification state.

## Features

- **Roblox verification** — profile-description challenge that proves account ownership. One Discord account ↔ one Roblox account, enforced in the database.
- **Honest membership tracking** — first-seen tracking (never fabricates join dates), leave/rejoin policies (`RESET_ON_LEAVE`, `KEEP_ORIGINAL`, `STAFF_REVIEW`), staff date overrides with audit history.
- **Eligibility engine** — per-community required-day requirements, live `/eligible` reports with pagination, automatic DM announcement when a member becomes eligible.
- **Persistent orders** — draft orders survive restarts; persistent order embed edited in place through a strict state machine (draft → submitted → review → quoted → payment → progress → ready → completed, with cancel/refund paths).
- **Ticket system** — private order/support channels with strict permissions, close confirmations, and automatic channel cleanup.
- **Multi-guild** — every server configures its own marketplace, roles, channels, currency, and communities.
- **Audit logging** — every meaningful action writes a durable audit row plus optional Discord log-channel posts.
- **Background jobs** — scheduled membership refresh, verification expiry, eligibility notifications, and ticket recovery.
- **Resilient Roblox API layer** — timeouts, bounded retries with backoff, throttling, TTL caching, strict JSON validation, and a hard rule: API failure is never reported as "not a member".

## Requirements

- Node.js >= 20
- PostgreSQL 13+
- A Discord application with a bot token (no privileged gateway intents required)

## Getting Started

### 1. Create the Discord application

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application and a bot user.
2. Copy the **bot token** and the **application (client) ID**.
3. Invite the bot to your server with the `bot` and `applications.commands` scopes and the **Administrator** permission (or at minimum: Manage Channels, Manage Roles, Manage Messages, Send Messages, Embed Links, Read Message History, Attach Files).
4. Enable **Message Content Intent: not required** — the bot works entirely on interactions.

### 2. Create the database

```sql
CREATE DATABASE zenmarketplace;
```

### 3. Configure

```bash
cp .env.example .env
```

| Variable | Description |
| --- | --- |
| `DISCORD_TOKEN` | Bot token from the Developer Portal. |
| `DISCORD_CLIENT_ID` | Application ID. |
| `GUILD_ID` | Optional. Set to register slash commands to one guild instantly; leave empty for global registration (up to ~1h to propagate). |
| `DATABASE_URL` | PostgreSQL connection string. |
| `NODE_ENV` | `development` or `production`. |
| `CRON_ELIGIBILITY_NOTIFIER` | Cron for the eligibility DM job (default: every 6h). |
| `CRON_MEMBERSHIP_REFRESH` | Cron for the membership re-check job (default: every 30m). |
| `CRON_VERIFICATION_SWEEPER` | Cron for expiring pending verifications (default: every 5m). |
| `ROBLOX_REQUEST_TIMEOUT_MS` | Per-request timeout (1000–30000, default 10000). |
| `ROBLOX_MAX_RETRIES` | Retries for network/timeout/429/5xx (0–5, default 2). |
| `HEALTH_PORT` | HTTP port for `GET /healthz` (default 3000, `0` = disabled). Used by platform health checks. |

The process refuses to boot with a missing or malformed variable.

### 4. Install and migrate

```bash
npm install
npm run prisma:generate
npm run prisma:migrate   # creates/updates the database schema
npm run deploy-commands  # registers slash commands
npm run bot              # local dev in ONE terminal: boots the embedded Postgres, then the bot. Ctrl+C stops both.
```

Prefer separate terminals? `npm run db:start` (keep open) + `npm run dev`. `npm run bot` reuses a Postgres that's already listening on port 5432. `npm run dev:stop` kills everything (bot + dev database).

### 5. First server setup

Run `/setup` as a server owner (or Administrator). Then:

1. `/setup role staff @Role` and `/setup role admin @Role`
2. `/setup tickets name:Tickets` — category where ticket channels are created (auto-created if missing)
3. `/setup channel panel <channel>` — where the order/support panel is posted
4. Optional log channels: `/setup channel verification-log <channel>`, `ticket-log`, `order-log`, `eligibility-log`, `error-log`
5. `/setup publish panel` — posts the ticket panel
6. `/community add name:My Group roblox-group-id:123456789 required-days:30`

## Production (Northflank / Docker)

The repo ships a multi-stage `Dockerfile`. On every container start it runs
`npx prisma migrate deploy` (applies pending schema migrations) and then the bot.

### Northflank

1. **Postgres** — create a PostgreSQL workload. Note its connection string
   (`postgresql://user:password@<service-host>:5432/<db>`).
2. **Bot service** — create a Docker service from this repo (the `Dockerfile` is auto-detected).
3. **Environment variables** — set on the bot service:

   | Variable | Value |
   | --- | --- |
   | `DISCORD_TOKEN` | bot token |
   | `DISCORD_CLIENT_ID` | application id |
   | `GUILD_ID` | your server id (instant command registration) |
   | `DATABASE_URL` | the Postgres connection string |
   | `NODE_ENV` | `production` (also set in the image) |

   Leave `ROBLOX_*`, `CRON_*` at defaults. `HEALTH_PORT` defaults to 3000.
4. **Health check** — HTTP, `GET /healthz` on port 3000. Returns 200 when Discord is connected **and** the DB answers; 503 otherwise.
5. **Scale: keep it at 1 replica.** Background jobs use in-process overlap guards (not distributed locks), so multiple replicas would double-run jobs.

### Any other Docker host

```bash
docker build -t zen-marketplace .
docker run --env-file .env -p 3000:3000 zen-marketplace
```

### Non-Docker hosts

```bash
npm ci && npm run build
npx prisma migrate deploy
NODE_ENV=production node dist/index.js
```

Run under a supervisor that restarts the process on exit (pm2, systemd, etc.). The bot exits on `uncaughtException` by design — all state is in Postgres, so a supervised restart is safe. Example pm2:

```bash
pm2 start dist/index.js --name zen-marketplace
pm2 save
```

Schema changes are deployed by pushing a new image (migrations run at boot) or, for non-Docker, `npm run prisma:deploy`.

> The embedded Postgres (`npm run db:start` / `npm run bot`) is **development only** — production always uses your own PostgreSQL via `DATABASE_URL`.

## Commands

### Customers

| Command | Description |
| --- | --- |
| `/verify roblox username:<name>` | Start the profile-description challenge. |
| `/verify status` | Show your verification state. |
| `/verify unlink` | Unlink your verified Roblox account. |
| `/eligible [user]` | Live eligibility report (staff may view others). |
| `/roblox profile [user]` | Show a verified user's Roblox profile. |

Order flow: click **Create Order** on the panel → pick a product in your private ticket → fill the persistent form (details modal) → submit. Buttons then track the order through its lifecycle.

### Staff

| Command | Description |
| --- | --- |
| `/setup ...` | Configure the marketplace (name, roles, channels, currency, timezone, enable/disable, publish). |
| `/community add\|edit\|remove\|list\|enable\|disable` | Manage tracked Roblox groups, required days, and leave policy. |
| `/eligibility set user:<u> community:<name> started-at:YYYY-MM-DD reason:<why>` | Staff-verify a membership start date (audit-logged). |
| `/product add\|edit\|list\|enable\|disable` | Manage products, prices, quantity bounds, and community restrictions. |
| `/customer profile [user]` | Customer profile: verification, order counts, warnings, notes, order history. |
| `/ticket setup` | Post the ticket panel in this channel. |
| `/ticket close` | Close the ticket in this channel. |

## How Eligibility Works

- Membership is tracked when a verified member's group list is checked (on `/eligible`, on orders, and every 30 minutes by the refresh job).
- The first time a membership is seen, that timestamp becomes the eligibility clock (`FIRST_SEEN`). The bot **never claims to know a Roblox join date it hasn't observed** — it says "first seen".
- When a member leaves, the configured leave policy applies:
  - `RESET_ON_LEAVE` — the clock restarts on rejoin.
  - `KEEP_ORIGINAL` — the original date is kept (flagged as such).
  - `STAFF_REVIEW` — the member must be staff-verified before eligibility resumes.
- Staff can override the start date with `/eligibility set`, which is fully audit-logged with previous values.
- When a member crosses the required-day threshold, the notifier DMs them (once; failed DMs retry the next cycle).
- **RoProxy failure never produces a "not a member" result.** Infrastructure errors surface as "services unavailable" and are retried by the next job run.

## Roblox Data Policy

- Only **public** Roblox endpoints are used, via the public RoProxy mirror (username resolution, profiles, group memberships, avatar headshots).
- The bot never sends, stores, requests, or logs `.ROBLOSECURITY` or any Roblox credential. Verification is proof of ownership via a public profile description code.
- All outbound Roblox calls are throttled (serialized with a gap), timeout-bounded, retried with backoff, and TTL-cached.

## Background Jobs

| Job | Schedule (default) | What it does |
| --- | --- | --- |
| Verification sweeper | every 5m | Deletes expired pending verification challenges. |
| Membership refresh | every 30m | Re-checks group membership for every tracked member across all guilds. |
| Eligibility notifier | every 6h | DMs newly-eligible members once. |
| Ticket recovery | every 1m | Deletes channels of closed tickets whose delete timer fired, and force-closes tickets whose channels vanished. |

Jobs are overlap-guarded: a long-running job never runs concurrently with itself. On restart, the sweeper and ticket recovery run immediately, then on schedule.

## Project Structure

```
prisma/schema.prisma        Database schema (PostgreSQL)
src/
  index.ts                  Entry point, lifecycle, graceful shutdown
  config/                   Env validation (zod), shared constants
  commands/                 Slash command definitions (registry in index.ts)
  handlers/                 Command + interaction dispatch, error boundary
  events/                   Gateway events (ready, interaction, channel delete)
  interactions/             Persistent button/select/modal handlers
  jobs/                     Cron jobs (membership, notifications, recovery)
  services/                 Domain logic (orders, eligibility, tickets, ...)
  utils/                    Errors, embeds, rate limiting, text, permissions
scripts/deployCommands.ts   Slash command registration
test/                       Unit tests (vitest)
```

## Development

```bash
npm run dev            # tsx watch
npm run lint           # eslint
npm run typecheck      # tsc --noEmit
npm test               # vitest (unit tests; no database needed)
npm run prisma:studio  # browse the database
```

Tests cover the order state machine, input sanitization, rate limiting, custom-id grammar, and the Roblox API client (mocked fetch: retry, 404 handling, malformed-JSON rejection).

## Troubleshooting

- **Commands not appearing** — run `npm run deploy-commands`; global registrations can take up to an hour, guild registrations are instant.
- **"This server is not set up yet"** — run `/setup` first (owner/Administrator only).
- **Eligibility says "first seen" but I joined earlier** — that is by design; the bot only reports what it observed. Use `/eligibility set` with a reason to staff-verify the real date.
- **"Roblox services unavailable"** — RoProxy is failing or rate-limited. Nothing is marked wrong; the next job run and command retry will recover. Check the error log channel and `ROBLOX_REQUEST_TIMEOUT_MS`.
- **Ticket channel disappeared mid-order** — the order stays in the database; the recovery job marks the ticket closed, and staff can continue the order via the order message in the channel's history or start a new ticket.
