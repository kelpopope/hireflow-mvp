# HireFlow AI — MVP

WhatsApp hiring assistant and owner web page for small cafés (Assignment 5, Technology Entrepreneurship, group BDA-2405: Abylaikhan Torekhan, Aibyn Zhanashev).

## What it does

1. The owner creates a vacancy with days, hours, pay per shift and workload.
2. A candidate writes to the WhatsApp number (for example the vacancy code `HF-101`). The bot replies at once with the conditions and asks six short questions.
3. The bot marks the candidate as fitting or not. The owner sees ✓/✗ for each condition and invites with one click.
4. The candidate confirms; the owner sends a reminder, marks Came / No-show and Hire.
5. Check-ins on days 7, 30 and 90 record who stayed and why people left.
6. The owner pays only for a hire who is still working on day 30 (test price 5,000 KZT; first vacancy free).

## Files

| File | Purpose |
|---|---|
| `shared.js` | Bot and business logic, used by both the server and the browser |
| `server.js` | Express server: owner API, WhatsApp webhook, storage |
| `src/app.html` | Owner page and candidate phone view (source) |
| `tools/build-artifact.js` | Builds `public/index.html` (server) and `dist/artifact.html` (standalone demo) |

## Run locally

```
npm install
npm start          # http://localhost:3000
```

## Deploy on Render (free)

New → Web Service → this repository. Build `npm install`, start `npm start`, instance type Free.

Environment variables:

| Key | Value |
|---|---|
| `WHATSAPP_TOKEN` | Access token from Meta → WhatsApp → API Setup (temporary tokens last 24 hours) |
| `PHONE_NUMBER_ID` | Phone number ID from the same page |
| `VERIFY_TOKEN` | Any word; the same word goes into the Meta webhook settings |
| `WHATSAPP_DISPLAY_NUMBER` | Optional, e.g. `+1 555 146 0845`, shown to owners as the apply link |
| `DATABASE_URL` | Optional Postgres URL; without it data is kept in `data.json` and is lost on redeploy |
| `ADMIN_KEY` | Optional key that owner actions must send in the `x-admin-key` header |

## Connect WhatsApp

Meta for Developers → app → WhatsApp → Configuration → Webhook → Edit:

- Callback URL: `https://<your-service>.onrender.com/webhook`
- Verify token: the `VERIFY_TOKEN` value
- Subscribe to the `messages` field.

## Known limits of the MVP

- Free-form WhatsApp messages can be sent only within 24 hours of the candidate's last message. Later reminders and day 30/90 check-ins need approved templates; in the pilot the team sends them by hand.
- The Meta test number can message only five registered phone numbers. The beta needs the team's own number.
- The temporary access token expires after 24 hours. Generate a new one before a demo, or create a permanent System User token in Meta Business settings.
- The free Render service sleeps after inactivity; open the page a minute before a demo.
