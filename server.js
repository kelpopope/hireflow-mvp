/* HireFlow AI MVP server.
 * - Serves the web service (public/index.html) for café owners.
 * - Receives WhatsApp messages from the Meta Cloud API webhook and answers through the shared bot engine.
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
  return { ok: res.ok, status: res.status, text: res.ok ? "" : await res.text() };
}
async function sendWhatsApp(to, text) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID || !to) return;
  try {
    let r = await postMessage(to, text);
    // Meta's test console stores Kazakh/Russian numbers with a trunk "8" (+7 8 7xx...).
    // If the number is "not in allowed list", retry in that stored form.
    if (!r.ok && r.text.indexOf("131030") >= 0 && /^7\d{10}$/.test(to)) {
      r = await postMessage("78" + to.slice(1), text);
    }
    if (!r.ok) console.error("WhatsApp send failed", r.status, r.text);
    else console.log("WhatsApp sent to", to.slice(0, 4) + "…");
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

function ownerOnly(req, res, next) {
  if (!ADMIN_KEY || req.get("x-admin-key") === ADMIN_KEY) return next();
  res.status(401).json({ error: "Enter the owner key to make changes." });
}

app.get("/api/state", async (req, res) => {
  const s = await load();
  res.json({ state: s, live: !!(WHATSAPP_TOKEN && PHONE_NUMBER_ID), waNumber: process.env.WHATSAPP_DISPLAY_NUMBER || "", needsKey: !!ADMIN_KEY });
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
  console.log("webhook:", JSON.stringify(req.body).slice(0, 400));
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

app.get("/shared.js", (req, res) => res.sendFile(path.join(__dirname, "shared.js")));
app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (req, res) => res.send("ok"));
app.get("/privacy", (req, res) => res.sendFile(path.join(__dirname, "public", "privacy.html")));

initStore().then(() => {
  app.listen(PORT, () => console.log("HireFlow MVP on port " + PORT + (WHATSAPP_TOKEN ? " (WhatsApp on)" : " (WhatsApp off)")));
});
