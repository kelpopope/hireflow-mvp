/* HireFlow AI MVP server.
 * - Serves the web service (public/index.html) for café owners.
 * - Receives WhatsApp messages from Twilio (/twilio) or the Meta Cloud API webhook (/webhook) and answers through the shared bot engine.
 * - Stores everything in Postgres when DATABASE_URL is set, otherwise in data.json (lost on redeploy).
 */
"use strict";
const express = require("express");
const path = require("path");
const fs = require("fs");
const HF = require("./shared.js");

const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "";
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "hireflow-verify";
const ADMIN_KEY = process.env.ADMIN_KEY || ""; // optional: protects owner actions
const GRAPH = "https://graph.facebook.com/v21.0";
// Twilio WhatsApp (sandbox or approved sender): an alternative to the Meta Cloud API.
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM = process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886";
const TWILIO_API = process.env.TWILIO_API || "https://api.twilio.com";
const TWILIO_ON = !!(TWILIO_SID && TWILIO_TOKEN);
const META_ON = !!(WHATSAPP_TOKEN && PHONE_NUMBER_ID);
const crypto = require("crypto");

// ---------- storage ----------
let pool = null;
const FILE = path.join(__dirname, "data.json");
async function initStore() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pool.query("create table if not exists hf_state (id int primary key, body jsonb not null)");
  }
}
async function load() {
  if (pool) {
    const r = await pool.query("select body from hf_state where id = 1");
    if (r.rows[0]) return r.rows[0].body;
    const s = seeded(); await save(s); return s;
  }
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) { const s = seeded(); fs.writeFileSync(FILE, JSON.stringify(s)); return s; }
}
// The free server loses data.json when it sleeps; start again from the example vacancy (code HF-101).
function seeded() { return HF.seed(Date.now(), process.env.SEED_LANG || "ru"); }
async function save(s) {
  if (pool) {
    await pool.query("insert into hf_state (id, body) values (1, $1) on conflict (id) do update set body = $1", [s]);
    return;
  }
  fs.writeFileSync(FILE, JSON.stringify(s));
}

// One queue so two messages never overwrite each other's changes.
let chain = Promise.resolve();
function run(action) {
  const job = chain.then(async () => {
    const before = await load();
    const r = HF.apply(before, action);
    await save(r.state);
    await deliver(r.outbound);
    return r.state;
  });
  chain = job.catch(() => {});
  return job;
}

// ---------- WhatsApp ----------
async function postMessage(to, text) {
  const body = { messaging_product: "whatsapp", to, type: "text", text: { body: text.slice(0, 4000) } };
  const res = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, text: await res.text() };
}
async function sendTwilio(to, text) {
  const form = new URLSearchParams({ From: TWILIO_FROM, To: "whatsapp:+" + String(to).replace(/\D/g, ""), Body: text.slice(0, 1600) });
  try {
    const res = await fetch(`${TWILIO_API}/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: "POST",
      headers: { Authorization: "Basic " + Buffer.from(TWILIO_SID + ":" + TWILIO_TOKEN).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const body = await res.text();
    if (!res.ok) console.error("Twilio send failed", res.status, body.slice(0, 300));
    else console.log("Twilio accepted for", String(to).slice(0, 5) + "…");
  } catch (e) {
    console.error("Twilio send error", e.message);
  }
}
async function sendWhatsApp(to, text) {
  if (TWILIO_ON && to) return sendTwilio(to, text);
  if (!META_ON || !to) return;
  try {
    let used = to;
    let r = await postMessage(to, text);
    // Meta's test console stores Kazakh/Russian numbers with a trunk "8" (+7 8 7xx...).
    // If the number is "not in allowed list", retry in that stored form.
    if (!r.ok && r.text.indexOf("131030") >= 0 && /^7\d{10}$/.test(to)) {
      used = "78" + to.slice(1);
      r = await postMessage(used, text);
    }
    if (!r.ok) console.error("WhatsApp send failed", r.status, r.text);
    else console.log("WhatsApp accepted for", used.slice(0, 5) + "…", r.text);
  } catch (e) {
    console.error("WhatsApp send error", e.message);
  }
}
async function deliver(outbound) {
  for (const m of outbound) {
    if (m.channel === "whatsapp") await sendWhatsApp(m.phone, m.text);
  }
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/twilio", express.urlencoded({ extended: false }));

function ownerOnly(req, res, next) {
  if (!ADMIN_KEY || req.get("x-admin-key") === ADMIN_KEY) return next();
  res.status(401).json({ error: "Enter the owner key to make changes." });
}

app.get("/api/state", async (req, res) => {
  const s = await load();
  res.json({ state: s, live: TWILIO_ON || META_ON, waNumber: process.env.WHATSAPP_DISPLAY_NUMBER || (TWILIO_ON ? TWILIO_FROM.replace("whatsapp:", "") : ""), waJoin: process.env.TWILIO_JOIN_WORDS || "", needsKey: !!ADMIN_KEY });
});

// Owner actions and the in-page simulator use the same engine as WhatsApp.
const OWNER_ACTIONS = ["createVacancy", "updateVacancy", "invite", "remind", "mark", "checkin", "ownerCheck", "reset", "deleteCandidate"];
app.post("/api/action", async (req, res, next) => {
  const a = req.body || {};
  if (OWNER_ACTIONS.indexOf(a.type) >= 0) return ownerOnly(req, res, next);
  next();
}, async (req, res) => {
  const a = Object.assign({}, req.body, { now: Date.now() });
  const allowed = OWNER_ACTIONS.concat(["incoming", "feedback"]);
  if (allowed.indexOf(a.type) < 0) return res.status(400).json({ error: "Unknown action" });
  if (a.type === "incoming") { a.channel = "sim"; delete a.phone; }
  try {
    const s = await run(a);
    res.json({ state: s });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not save. Try again." });
  }
});

// Meta webhook verification
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

// Incoming WhatsApp messages
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // answer Meta at once
  const raw = JSON.stringify(req.body);
  console.log("webhook:", raw.indexOf('"statuses"') >= 0 ? raw.slice(raw.indexOf('"statuses"'), raw.indexOf('"statuses"') + 900) : raw.slice(0, 400));
  try {
    const entries = (req.body && req.body.entry) || [];
    for (const e of entries) {
      for (const ch of e.changes || []) {
        const val = ch.value || {};
        const names = {};
        (val.contacts || []).forEach((c) => { names[c.wa_id] = c.profile && c.profile.name; });
        for (const m of val.messages || []) {
          let text = "";
          if (m.type === "text") text = m.text.body;
          else if (m.type === "button") text = m.button.text;
          else if (m.type === "interactive") text = (m.interactive.button_reply || m.interactive.list_reply || {}).title || "";
          else text = "?";
          await run({ type: "incoming", channel: "whatsapp", phone: m.from, profileName: names[m.from] || "", text, now: Date.now() });
        }
      }
    }
  } catch (e) {
    console.error("webhook error", e);
  }
});

// Incoming WhatsApp messages through Twilio. The request is checked with Twilio's signature.
function twilioSignatureOk(req) {
  const sig = req.get("x-twilio-signature") || "";
  const url = (process.env.PUBLIC_URL || ("https://" + req.get("host"))) + req.originalUrl;
  const params = req.body || {};
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  const expected = crypto.createHmac("sha1", TWILIO_TOKEN).update(Buffer.from(data, "utf-8")).digest("base64");
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
app.post("/twilio", async (req, res) => {
  if (!TWILIO_ON) return res.sendStatus(404);
  if (!twilioSignatureOk(req)) { console.error("Twilio signature mismatch"); return res.sendStatus(403); }
  res.type("text/xml").send("<Response></Response>"); // replies go out through the API
  const b = req.body || {};
  const phone = String(b.From || "").replace(/\D/g, "");
  const text = b.Body || (Number(b.NumMedia) > 0 ? "?" : "");
  if (!phone) return;
  try {
    await run({ type: "incoming", channel: "whatsapp", phone, profileName: b.ProfileName || "", text, now: Date.now() });
  } catch (e) {
    console.error("twilio webhook error", e);
  }
});

// Free Twilio trials cannot set an incoming-message webhook, so the server can instead ask Twilio
// for new incoming messages every few seconds (TWILIO_POLL=1).
const seen = new Set();
let pollReady = false;
async function pollTwilio() {
  const to = TWILIO_FROM;
  const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const url = `${TWILIO_API}/2010-04-01/Accounts/${TWILIO_SID}/Messages.json?To=${encodeURIComponent(to)}&DateSent%3E=${day}&PageSize=50`;
  try {
    const res = await fetch(url, { headers: { Authorization: "Basic " + Buffer.from(TWILIO_SID + ":" + TWILIO_TOKEN).toString("base64") } });
    if (!res.ok) { console.error("Twilio poll failed", res.status, (await res.text()).slice(0, 200)); return; }
    const list = ((await res.json()).messages || []).filter((m) => m.direction === "inbound");
    list.sort((a, b) => new Date(a.date_created) - new Date(b.date_created));
    for (const m of list) {
      if (seen.has(m.sid)) continue;
      seen.add(m.sid);
      // On start, skip old history but keep messages from the last two minutes (sent while the server was waking up).
      if (!pollReady && Date.now() - new Date(m.date_created).getTime() > 120000) continue;
      const phone = String(m.from || "").replace(/\D/g, "");
      if (!phone || /^join\s/i.test(m.body || "")) continue;
      await run({ type: "incoming", channel: "whatsapp", phone, profileName: "", text: m.body || "?", now: Date.now() });
    }
    pollReady = true;
  } catch (e) {
    console.error("Twilio poll error", e.message);
  }
}
function startPolling() {
  let busy = false;
  setInterval(async () => { if (busy) return; busy = true; await pollTwilio(); busy = false; }, 4000);
  // Free Render services sleep without incoming traffic; a ping through the public URL keeps polling alive.
  if (process.env.PUBLIC_URL) setInterval(() => { fetch(process.env.PUBLIC_URL + "/healthz").catch(() => {}); }, 10 * 60 * 1000);
  console.log("Polling Twilio for incoming WhatsApp messages");
}

app.get("/shared.js", (req, res) => res.sendFile(path.join(__dirname, "shared.js")));
app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (req, res) => res.send("ok"));
app.get("/privacy", (req, res) => res.sendFile(path.join(__dirname, "public", "privacy.html")));

initStore().then(() => {
  if (TWILIO_ON && process.env.TWILIO_POLL === "1") startPolling();
  app.listen(PORT, () => console.log("HireFlow MVP on port " + PORT + (TWILIO_ON ? " (WhatsApp via Twilio)" : META_ON ? " (WhatsApp via Meta)" : " (WhatsApp off)")));
});
