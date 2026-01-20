// index.js
import http from "http";
import { createClient } from "@supabase/supabase-js";
import TelegramBot from "node-telegram-bot-api";

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // e.g. https://your-app.onrender.com
const PORT = parseInt(process.env.PORT || "3000", 10);

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");
if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL");
if (!SUPABASE_SERVICE_KEY) throw new Error("Missing SUPABASE_SERVICE_KEY (service role)");
if (!WEBHOOK_URL) throw new Error("Missing WEBHOOK_URL (HTTPS)");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  realtime: { params: { eventsPerSecond: 50 } },
});

// webhook mode (no polling)
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

/* in-memory state */
const chatState = new Map(); // chatId -> { deviceId, cwd }
const pendingSubs = new Map(); // cmdId -> { resolve,reject,timeout,sub,promise }

/* ================
   Helpers / Formatters
   ================ */

function resolvePath(cwd, input) {
  if (!input || input.trim() === "") return cwd;
  const p = String(input).trim();
  if (p.startsWith("/")) return p;
  return `${cwd.replace(/\/+$/, "")}/${p}`;
}

function chunkMessage(text, max = 3800) {
  const parts = [];
  for (let i = 0; i < text.length; i += max) parts.push(text.slice(i, i + max));
  return parts;
}

function safeString(s) {
  if (s === null || s === undefined) return "";
  return String(s);
}

function formatInfo(obj) {
  const lines = [];
  if (obj.brand) lines.push(`Brand: ${safeString(obj.brand)}`);
  if (obj.model) lines.push(`Model: ${safeString(obj.model)}`);
  if (obj.device) lines.push(`Device: ${safeString(obj.device)}`);
  if (obj.manufacturer) lines.push(`Manufacturer: ${safeString(obj.manufacturer)}`);
  if (obj.android_version) lines.push(`Android: ${safeString(obj.android_version)}${obj.sdk ? ` (SDK ${safeString(obj.sdk)})` : ""}`);
  if (obj.is_physical_device !== undefined) lines.push(`Physical device: ${safeString(obj.is_physical_device)}`);
  if (obj.cwd) lines.push(`CWD: ${safeString(obj.cwd)}`);
  return lines.join("\n");
}

/**
 * New formatListing: returns plain, human-friendly list (folders first then files)
 * Example output:
 * Android
 * Images
 * Download
 * Movies
 * test.py
 * 5000.py
 */
function formatListingPlain(result, requestedPath = "") {
  const lines = [];
  lines.push(`Listing: ${requestedPath || ""}`);
  if (!result) {
    lines.push("No result.");
    return lines;
  }

  // Preferred: result.entries = [{name, path, type, size}]
  if (Array.isArray(result.entries) && result.entries.length >= 0) {
    const folders = [];
    const files = [];
    for (const e of result.entries) {
      const t = (e.type || "").toString().toLowerCase();
      const name = safeString(e.name || e.path || "");
      if (!name) continue;
      if (t === "dir" || t === "directory" || (e.path && e.path.endsWith("/"))) folders.push(name);
      else files.push(name);
    }
    // sort alphabetically within groups
    folders.sort((a,b)=>a.localeCompare(b));
    files.sort((a,b)=>a.localeCompare(b));
    // combine (folders first, then files) as requested
    for (const f of folders) lines.push(f);
    for (const f of files) lines.push(f);
    return lines;
  }

  // Older shape: result.folders / result.files arrays
  if ((Array.isArray(result.folders) && result.folders.length) || (Array.isArray(result.files) && result.files.length)) {
    const folders = Array.isArray(result.folders) ? result.folders.map(s => safeString(s)) : [];
    const files = Array.isArray(result.files) ? result.files.map(s => safeString(s)) : [];
    folders.sort((a,b)=>a.localeCompare(b));
    files.sort((a,b)=>a.localeCompare(b));
    for (const f of folders) lines.push(f);
    for (const f of files) lines.push(f);
    return lines;
  }

  // Fallback: if result is a simple array of names
  if (Array.isArray(result) && result.length) {
    const names = result.map(r => safeString(r)).sort((a,b) => a.localeCompare(b));
    for (const n of names) lines.push(n);
    return lines;
  }

  // Last fallback: pretty JSON string but plain text (avoid Markdown entities)
  try {
    lines.push(JSON.stringify(result, null, 2));
  } catch (e) {
    lines.push(String(result));
  }
  return lines;
}

/* ================
   DB helpers
   ================ */

async function validateDevice(deviceId) {
  const { data, error } = await supabase
    .from("devices")
    .select("id, online, consent, last_seen")
    .eq("id", deviceId)
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "device_not_found" };
  if (!data.consent) return { ok: false, error: "device_no_consent" };
  if (!data.online) return { ok: false, error: "device_offline" };
  return { ok: true };
}

async function getSelectedDevice(chatId) {
  const st = chatState.get(chatId);
  if (!st?.deviceId) {
    await bot.sendMessage(chatId, "❌ No device selected. Use /use <device_id>");
    return null;
  }
  const v = await validateDevice(st.deviceId);
  if (!v.ok) {
    await bot.sendMessage(chatId, `❌ Device invalid: ${v.error}`);
    chatState.delete(chatId);
    return null;
  }
  return st.deviceId;
}

async function sendCommand(deviceId, action, payload = {}) {
  const { data, error } = await supabase
    .from("device_commands")
    .insert({
      device_id: deviceId,
      action,
      payload,
      status: "pending",
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

function waitForResultRealtime(cmdId, timeoutMs = 90_000) {
  if (!cmdId) return Promise.reject(new Error("missing_cmd_id"));
  if (pendingSubs.has(cmdId)) return pendingSubs.get(cmdId).promise;

  let resolveFn, rejectFn;
  const promise = new Promise((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });

  const rec = { resolve: resolveFn, reject: rejectFn, sub: null, timeout: null, promise };
  pendingSubs.set(cmdId, rec);

  try {
    const channel = supabase
      .channel(`cmd-${cmdId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "device_commands", filter: `id=eq.${cmdId}` },
        (payload) => {
          try {
            const newRow = payload.new ?? payload.record ?? payload;
            const status = (newRow?.status || "").toString();
            if (status === "done" || status === "failed") {
              cleanup(true, newRow);
            }
          } catch (e) {}
        }
      )
      .subscribe((status) => {});
    rec.sub = channel;
  } catch (e) {
    console.warn("Realtime subscribe failed:", e);
  }

  const pollInterval = 1500;
  const poller = setInterval(async () => {
    try {
      const { data } = await supabase
        .from("device_commands")
        .select("status, result")
        .eq("id", cmdId)
        .maybeSingle();
      if (data && (data.status === "done" || data.status === "failed")) {
        cleanup(true, data);
      }
    } catch (_) {}
  }, pollInterval);

  function cleanup(success, data) {
    if (!pendingSubs.has(cmdId)) return;
    const r = pendingSubs.get(cmdId);
    clearInterval(poller);
    if (r.timeout) clearTimeout(r.timeout);
    if (r.sub) {
      try { supabase.removeChannel(r.sub); } catch (_) {}
    }
    pendingSubs.delete(cmdId);
    if (success) r.resolve(data);
    else r.reject(data);
  }

  rec.timeout = setTimeout(async () => {
    try {
      const { data } = await supabase
        .from("device_commands")
        .select("status, result")
        .eq("id", cmdId)
        .maybeSingle();
      if (data && (data.status === "done" || data.status === "failed")) {
        cleanup(true, data);
        return;
      }
    } catch (_) {}
    cleanup(false, new Error("timeout_waiting_result"));
  }, timeoutMs);

  return promise;
}

/* ===========================
   Bot command handlers
   =========================== */

// /start
bot.onText(/^\/start$/i, (msg) => {
  const text = [
    "✅ Bot online",
    "/use <device_id> — select device",
    "/devices — list devices",
    "/exit — clear selected device",
    "/help — view help",
  ].join("\n");
  bot.sendMessage(msg.chat.id, text);
});

// /help (plain text)
bot.onText(/^\/help$/i, (msg) => {
  const text = [
    "Quick Help:",
    "/use <device_id> — choose device",
    "/devices — show available devices",
    "/ls [path] — list files (defaults to cwd)",
    "/tree [path] — recursive tree (bounded)",
    "/cd <path> — change working directory",
    "/pwd — show working directory",
    "/upload <path> — prepare & upload file from device storage",
    "/rm <path> — remove file",
    "/rd <path> — remove directory recursively",
    "/ping — simple ping",
    "/info — device info (friendly)",
    "/exit — stop using current device",
  ].join("\n");
  bot.sendMessage(msg.chat.id, text);
});

// /devices — show devices; show LAST_SEEN only for offline devices
bot.onText(/^\/devices$/i, async (msg) => {
  try {
    const { data } = await supabase.from("devices").select("id, online, last_seen").order("last_seen", { ascending: false });
    if (!data?.length) {
      bot.sendMessage(msg.chat.id, "No devices.");
      return;
    }
    const now = Date.now();
    const lines = data.map(d => {
      let seen = "";
      if (!d.online && d.last_seen) {
        try {
          const diff = now - new Date(d.last_seen).getTime();
          const sec = Math.floor(diff / 1000);
          if (sec < 60) seen = `${sec}s ago`;
          else if (sec < 3600) seen = `${Math.floor(sec / 60)}m ago`;
          else if (sec < 86400) seen = `${Math.floor(sec / 3600)}h ago`;
          else seen = `${Math.floor(sec / 86400)}d ago`;
          seen = ` (seen ${seen})`;
        } catch (_) {}
      }
      return `• ${d.id} — ${d.online ? "online ✅" : "offline ❌"}${seen}`;
    });
    bot.sendMessage(msg.chat.id, lines.join("\n"));
  } catch (e) {
    bot.sendMessage(msg.chat.id, `Error listing devices: ${e.message || e}`);
  }
});

// /use <device>
bot.onText(/^\/use\s+(.+)$/i, async (msg, m) => {
  const deviceId = m[1].trim();
  const v = await validateDevice(deviceId);
  if (!v.ok) {
    bot.sendMessage(msg.chat.id, `❌ ${v.error}`);
    return;
  }
  chatState.set(msg.chat.id, { deviceId, cwd: "/storage/emulated/0/" });
  bot.sendMessage(msg.chat.id, `✅ Using device ${deviceId}`);
});

// /exit -> clear selected device
bot.onText(/^\/exit$/i, (msg) => {
  chatState.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, "✅ Cleared selected device/session");
});

// /cd <path>
bot.onText(/^\/cd\s+(.+)$/i, (msg, m) => {
  const st = chatState.get(msg.chat.id);
  if (!st) {
    bot.sendMessage(msg.chat.id, "❌ Select device first with /use");
    return;
  }
  const newPath = resolvePath(st.cwd, m[1].trim());
  st.cwd = newPath;
  bot.sendMessage(msg.chat.id, `📂 cwd = ${st.cwd}`);
});

// /pwd
bot.onText(/^\/pwd$/i, (msg) => {
  const st = chatState.get(msg.chat.id);
  if (!st) {
    bot.sendMessage(msg.chat.id, "❌ No device selected. Use /use <device_id>");
    return;
  }
  bot.sendMessage(msg.chat.id, `📁 cwd: ${st.cwd}`);
});

/* ===== /ls (fast + combined plain list) ===== */
bot.onText(/^\/ls(?:\s+(.*))?$/i, async (msg, m) => {
  const deviceId = await getSelectedDevice(msg.chat.id);
  if (!deviceId) return;
  const st = chatState.get(msg.chat.id);
  const requested = (m[1]?.trim() || st.cwd);
  const path = resolvePath(st.cwd, requested);
  try {
    // hint device to limit work: send limit param (device should honor)
    const cmd = await sendCommand(deviceId, "list_files", { path, limit: 500 });
    // give ls a bit more time (30s)
    const res = await waitForResultRealtime(cmd.id, 30_000);
    const payload = (res && (res.result ?? res)) || res;

    if (payload && payload.cwd) st.cwd = payload.cwd;

    const lines = formatListingPlain(payload, path);
    for (const chunk of chunkMessage(lines.join("\n"))) await bot.sendMessage(msg.chat.id, chunk);
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ ls failed: ${e.message || e}`);
  }
});

/* ===== /tree (bounded recursive) ===== */
bot.onText(/^\/tree(?:\s+(.*))?$/i, async (msg, m) => {
  const deviceId = await getSelectedDevice(msg.chat.id);
  if (!deviceId) return;
  const st = chatState.get(msg.chat.id);
  const requested = (m[1]?.trim() || st.cwd);
  const path = resolvePath(st.cwd, requested);
  try {
    const cmd = await sendCommand(deviceId, "list_files", { path, recursive: true, maxDepth: 5, limit: 1500 });
    const res = await waitForResultRealtime(cmd.id, 120_000);
    const payload = (res && (res.result ?? res)) || res;

    if (payload && payload.cwd) st.cwd = payload.cwd;

    let lines = [];
    if (Array.isArray(payload.entries) && payload.entries.length) {
      if (payload.entries.length > 1500) lines.push("⚠️ Tree truncated (too many files)");
      lines = lines.concat(buildTreeFromEntries(payload.entries, path));
    } else if (Array.isArray(payload.files) || Array.isArray(payload.folders)) {
      const entries = [];
      if (Array.isArray(payload.folders)) payload.folders.forEach(f => entries.push({ path: `${path.replace(/\/$/, "")}/${f}`, type: "dir" }));
      if (Array.isArray(payload.files)) payload.files.forEach(f => entries.push({ path: `${path.replace(/\/$/, "")}/${f}`, type: "file" }));
      lines = buildTreeFromEntries(entries, path);
    } else {
      lines = [JSON.stringify(payload, null, 2)];
    }

    for (const chunk of chunkMessage(lines.join("\n"))) await bot.sendMessage(msg.chat.id, chunk);
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ tree failed: ${e.message || e}`);
  }
});

/* ===== /upload (improved payload handling) ===== */
bot.onText(/^\/upload\s+(.+)$/i, async (msg, m) => {
  const chatId = msg.chat.id;
  const deviceId = await getSelectedDevice(chatId);
  if (!deviceId) return;
  const st = chatState.get(chatId);
  const requested = m[1].trim();
  const path = resolvePath(st.cwd, requested);

  bot.sendMessage(chatId, "📦 Preparing upload…");
  try {
    const prepCmd = await sendCommand(deviceId, "prepare_upload", { filename: path });
    const prepRes = await waitForResultRealtime(prepCmd.id, 90_000);
    const prepPayload = prepRes?.result ?? prepRes;
    if (!prepPayload) {
      bot.sendMessage(chatId, "❌ prepare_upload failed (no payload)");
      return;
    }

    const payload = {
      device_id: deviceId,
      source: prepPayload,
      bucket: "agent-uploads",
      dest: `${deviceId}/${Date.now()}_${(prepPayload.name || "file")}`,
    };

    bot.sendMessage(chatId, "☁️ Uploading to Supabase Storage…");

    const { data, error } = await supabase.functions.invoke("upload-file", { body: payload });
    if (error) {
      bot.sendMessage(chatId, `❌ Upload failed: ${error.message}`);
      return;
    }

    bot.sendMessage(chatId, `✅ Upload complete\nBucket: ${data.bucket}\nPath: ${data.path}`);
  } catch (e) {
    bot.sendMessage(chatId, `❌ upload error: ${e.message || e}`);
  }
});

bot.onText(/^\/rm\s+(.+)$/i, async (msg, m) => {
  const chatId = msg.chat.id;
  const deviceId = await getSelectedDevice(chatId);
  if (!deviceId) return;
  const st = chatState.get(chatId);
  const requested = m[1].trim();
  const path = resolvePath(st.cwd, requested);

  bot.sendMessage(chatId, `🗑️ Removing file: ${path}`);
  try {
    const cmd = await sendCommand(deviceId, "delete_file", { path });
    const res = await waitForResultRealtime(cmd.id, 30_000);
    const payload = res?.result ?? res;
    if (payload && payload.success) bot.sendMessage(chatId, `✅ Removed ${path}`);
    else bot.sendMessage(chatId, `❌ remove failed: ${JSON.stringify(payload || res || {})}`);
  } catch (e) {
    bot.sendMessage(chatId, `❌ rm error: ${e.message || e}`);
  }
});

/* ===== /rd (remove directory recursively) =====
   Sends action 'delete_dir' (agent should implement)
*/
bot.onText(/^\/rd\s+(.+)$/i, async (msg, m) => {
  const chatId = msg.chat.id;
  const deviceId = await getSelectedDevice(chatId);
  if (!deviceId) return;
  const st = chatState.get(chatId);
  const requested = m[1].trim();
  const path = resolvePath(st.cwd, requested);

  bot.sendMessage(chatId, `🗑️ Removing directory (recursively): ${path}`);
  try {
    const cmd = await sendCommand(deviceId, "delete_dir", { path });
    const res = await waitForResultRealtime(cmd.id, 60_000);
    const payload = res.result?.result ?? res.result ?? res;
    if (payload && payload.success) bot.sendMessage(chatId, `✅ Removed directory ${path}`);
    else bot.sendMessage(chatId, `❌ rd failed: ${JSON.stringify(payload || res || {})}`);
  } catch (e) {
    bot.sendMessage(chatId, `❌ rd error: ${e.message || e}`);
  }
});

// /ping
bot.onText(/^\/ping$/i, async (msg) => {
  const deviceId = await getSelectedDevice(msg.chat.id);
  if (!deviceId) return;
  try {
    const cmd = await sendCommand(deviceId, "ping");
    const res = await waitForResultRealtime(cmd.id, 20_000);
    const payload = res?.result ?? res;
    if (payload && payload.ts) bot.sendMessage(msg.chat.id, `🏓 Pong — ts: ${payload.ts}`);
    else bot.sendMessage(msg.chat.id, "🏓 Pong");
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ ping failed: ${e.message || e}`);
  }
});

// /info (friendly)
bot.onText(/^\/info$/i, async (msg) => {
  const deviceId = await getSelectedDevice(msg.chat.id);
  if (!deviceId) return;
  try {
    const cmd = await sendCommand(deviceId, "device_info");
    const res = await waitForResultRealtime(cmd.id, 20_000);
    const payload = res?.result ?? res;

    // update local cwd if device returns one
    const st = chatState.get(msg.chat.id);
    if (payload && payload.cwd && st) st.cwd = payload.cwd;

    const text = formatInfo(payload);
    for (const chunk of chunkMessage(text)) await bot.sendMessage(msg.chat.id, chunk);
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ info failed: ${e.message || e}`);
  }
});

/* ================
   Webhook server + health
   ================ */

async function ensureWebhook() {
  try {
    const hook = `${WEBHOOK_URL.replace(/\/$/, "")}/bot${BOT_TOKEN}`;
    await bot.setWebHook(hook);
    console.log("Webhook set to:", hook);
  } catch (err) {
    console.error("Failed to set webhook:", err?.response?.body || err?.message || err);
    if (err?.response?.statusCode === 409 || (err?.message && err.message.includes("409"))) {
      console.error("Conflict while setting webhook (409). Ensure no other bot instance is running with getUpdates/polling.");
    }
  }
}

await ensureWebhook();

const server = http.createServer(async (req, res) => {
  try {
    // webhook receiver
    if (req.method === "POST" && req.url === `/bot${BOT_TOKEN}`) {
      let body = "";
      req.on("data", chunk => (body += chunk));
      req.on("end", async () => {
        try {
          if (!body) {
            res.writeHead(400); res.end("no body"); return;
          }
          const json = JSON.parse(body);
          await bot.processUpdate(json);
          res.writeHead(200); res.end("ok");
        } catch (e) {
          console.error("processUpdate error:", e);
          res.writeHead(500); res.end("error");
        }
      });
      return;
    }

    // health / root
    if (req.method === "GET" && req.url === "/") {
      const connectedChats = Array.from(chatState.keys()).length;
      const activeSubs = Array.from(pendingSubs.keys()).length;
      const u = { ok: true, uptime: process.uptime(), connectedChats, activePendingCommands: activeSubs };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(u));
      return;
    }

    res.writeHead(404); res.end("not found");
  } catch (e) {
    console.error("server error:", e);
    res.writeHead(500); res.end("fatal");
  }
});

server.listen(PORT, async () => {
  console.log(`🚀 Webhook server listening on port ${PORT}`);
  console.log(`Webhook endpoint: POST ${WEBHOOK_URL.replace(/\/$/, "")}/bot${BOT_TOKEN}`);

  await ensureWebhook();
});

/* housekeeping: friendly error guards */
bot.on("polling_error", (err) => {
  // should not occur in webhook mode, but keep for diagnostics
  console.warn("polling_error:", err?.message || err);
  if (err?.response?.body) console.warn("->", err.response.body);
});

process.on("unhandledRejection", (e) => {
  console.error("Unhandled promise:", e);
});
process.on("uncaughtException", (e) => {
  console.error("Uncaught exception:", e);
});
