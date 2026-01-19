// index.js
import http from "http";
import TelegramBot from "node-telegram-bot-api";
import { createClient } from "@supabase/supabase-js";

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PORT = parseInt(process.env.PORT || "3000", 10);

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");
if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL");
if (!SUPABASE_SERVICE_KEY) throw new Error("Missing SUPABASE_SERVICE_KEY (service role)");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  realtime: { params: { eventsPerSecond: 50 } },
});
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

/* in-memory state */
const chatState = new Map(); // chatId -> { deviceId, cwd }
const pendingSubs = new Map(); // cmdId -> { resolve, reject, timeout, sub, promise }

/* simple per-chat rate limiter */
const lastCmd = new Map(); // chatId -> timestamp
function canRun(chatId, ms = 700) {
  const now = Date.now();
  const last = lastCmd.get(chatId) || 0;
  if (now - last < ms) return false;
  lastCmd.set(chatId, now);
  return true;
}

/* helpers */

// Normalize/resolve paths (relative -> absolute based on cwd)
function resolvePath(cwd, input) {
  if (!input || input.trim() === "") return cwd;
  const p = input.trim();
  if (p.startsWith("/")) return p;
  // remove trailing slash from cwd, then append
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
  lines.push("📱 *Device Info*");
  if (obj.brand) lines.push(`Brand: ${safeString(obj.brand)}`);
  if (obj.model) lines.push(`Model: ${safeString(obj.model)}`);
  if (obj.device) lines.push(`Device: ${safeString(obj.device)}`);
  if (obj.manufacturer) lines.push(`Manufacturer: ${safeString(obj.manufacturer)}`);
  if (obj.android_version) lines.push(`Android: ${safeString(obj.android_version)}${obj.sdk ? ` (SDK ${safeString(obj.sdk)})` : ""}`);
  if (obj.is_physical_device !== undefined) lines.push(`Physical device: ${safeString(obj.is_physical_device)}`);
  if (obj.cwd) lines.push(`CWD: ${safeString(obj.cwd)}`);
  return lines.join("\n");
}

// Accepts many listing shapes and returns lines array
function formatListing(result, requestedPath = "") {
  const lines = [];
  lines.push(`📂 Listing: ${requestedPath || ""}`);
  if (!result) {
    lines.push("No result.");
    return lines;
  }

  if (Array.isArray(result.entries) && result.entries.length > 0) {
    const folders = [];
    const files = [];
    for (const e of result.entries) {
      const t = (e.type || "").toString();
      if (t === "dir" || t === "directory" || (e.path && e.path.endsWith("/"))) folders.push(e);
      else files.push(e);
    }
    if (folders.length) {
      lines.push("\n📁 Folders:");
      folders.forEach(f => lines.push(`• ${safeString(f.name || f.path)}`));
    }
    if (files.length) {
      lines.push("\n📄 Files:");
      files.forEach(f => lines.push(`• ${safeString(f.name || f.path)} — ${safeString(f.size ?? "")} bytes`));
    }
    return lines;
  }

  if (Array.isArray(result.folders) || Array.isArray(result.files)) {
    if (Array.isArray(result.folders) && result.folders.length) {
      lines.push("\n📁 Folders:");
      result.folders.forEach(f => lines.push(`• ${safeString(f)}`));
    }
    if (Array.isArray(result.files) && result.files.length) {
      lines.push("\n📄 Files:");
      result.files.forEach(f => lines.push(`• ${safeString(f)}`));
    }
    return lines;
  }

  if (result.count !== undefined && result.count === 0) {
    lines.push("No entries.");
    return lines;
  }

  lines.push("```json");
  try {
    lines.push(JSON.stringify(result, null, 2));
  } catch (e) {
    lines.push(String(result));
  }
  lines.push("```");
  return lines;
}

// Build ASCII tree from entries: expects entries array with path + type
function buildTreeFromEntries(entries, rootPath) {
  const root = (rootPath || "").replace(/\/+$/, "");
  const map = { _children: {} };
  for (const e of entries) {
    const p = (e.path || e.name || "").toString();
    const rel = root && p.startsWith(root) ? p.slice(root.length).replace(/^\/+/, "") : p;
    if (!rel) continue;
    const parts = rel.split("/").filter(Boolean);
    let cur = map;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!cur._children) cur._children = {};
      if (!cur._children[part]) cur._children[part] = { _meta: null, _children: {} };
      if (i === parts.length - 1) {
        cur._children[part]._meta = { type: e.type || (e.path && e.path.endsWith("/") ? "dir" : "file"), raw: e };
      }
      cur = cur._children[part];
    }
  }

  function render(nodeChildren, prefix = "") {
    const names = Object.keys(nodeChildren || {}).sort((a, b) => a.localeCompare(b));
    const out = [];
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const isLast = i === names.length - 1;
      const meta = nodeChildren[name]._meta;
      const typ = (meta && meta.type) ? meta.type : "file";
      const line = `${prefix}${isLast ? "└─ " : "├─ "}${name}${typ && typ.startsWith("dir") ? "/" : ""}`;
      out.push(line);
      const child = nodeChildren[name]._children;
      if (child && Object.keys(child).length) {
        out.push(...render(child, `${prefix}${isLast ? "   " : "│  "}`));
      }
    }
    return out;
  }

  const rootChildren = map._children || map;
  const lines = [`📂 Tree: ${rootPath || "/"}`, ...render(rootChildren)];
  return lines;
}

/* DB helpers */
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

// Realtime wait: subscribe to UPDATEs for this id. fallback to polling on timeout/failure.
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
      try {
        supabase.removeChannel(r.sub);
      } catch (_) {}
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

/* BOT COMMANDS */

// /start
bot.onText(/^\/start$/i, (msg) => {
  const text = [
    "✅ Bot online",
    "/use <device_id> — select device",
    "/devices — list devices",
    "/exit — exit selected device",
    "/help — view help commands",
  ].join("\n");
  bot.sendMessage(msg.chat.id, text);
});

// /help
bot.onText(/^\/help$/i, (msg) => {
  const text = [
    "*Quick Help*",
    "/use `<device_id>` — choose device",
    "/devices — show available devices",
    "/ls [path] — list files; defaults to cwd",
    "/tree [path] — recursive tree (bounded)",
    "/cd `<path>` — change working directory",
    "/upload `<path>` — prepare & upload file from device storage",
    "/ping — simple ping",
    "/info — get device info (friendly)",
    "/exit — stop using current device",
  ].join("\n\n");
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

// /devices (include last_seen human readable)
bot.onText(/^\/devices$/i, async (msg) => {
  try {
    const { data } = await supabase
      .from("devices")
      .select("id, online, last_seen")
      .order("last_seen", { ascending: false });

    if (!data?.length) {
      bot.sendMessage(msg.chat.id, "No devices.");
      return;
    }

    const now = Date.now();
    const lines = data.map(d => {
      let seen = "";
      if (d.last_seen) {
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
  if (!canRun(msg.chat.id)) {
    bot.sendMessage(msg.chat.id, "⏳ Slow down a bit…");
    return;
  }
  const st = chatState.get(msg.chat.id);
  if (!st) {
    bot.sendMessage(msg.chat.id, "❌ Select device first with /use");
    return;
  }
  const newPath = resolvePath(st.cwd, m[1].trim());
  st.cwd = newPath;
  bot.sendMessage(msg.chat.id, `📂 cwd = ${st.cwd}`);
});

// /ls [path]
bot.onText(/^\/ls(?:\s+(.*))?$/i, async (msg, m) => {
  if (!canRun(msg.chat.id)) {
    bot.sendMessage(msg.chat.id, "⏳ Slow down a bit…");
    return;
  }
  const deviceId = await getSelectedDevice(msg.chat.id);
  if (!deviceId) return;
  const st = chatState.get(msg.chat.id);
  const requested = (m[1]?.trim() || st.cwd);
  const path = resolvePath(st.cwd, requested);
  try {
    const cmd = await sendCommand(deviceId, "list_files", { path });
    const res = await waitForResultRealtime(cmd.id);
    const payload = res.result ?? res;

    // auto-sync cwd if device returned it
    if (payload && payload.cwd) st.cwd = payload.cwd;

    const lines = formatListing(payload, path);
    const text = lines.join("\n");
    for (const chunk of chunkMessage(text)) await bot.sendMessage(msg.chat.id, chunk, { parse_mode: "Markdown" });
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ ls failed: ${e.message || e}`);
  }
});

// /tree [path] (bounded)
bot.onText(/^\/tree(?:\s+(.*))?$/i, async (msg, m) => {
  if (!canRun(msg.chat.id, 1200)) {
    bot.sendMessage(msg.chat.id, "⏳ Slow down a bit…");
    return;
  }
  const deviceId = await getSelectedDevice(msg.chat.id);
  if (!deviceId) return;
  const st = chatState.get(msg.chat.id);
  const requested = (m[1]?.trim() || st.cwd);
  const path = resolvePath(st.cwd, requested);

  try {
    // ask device for recursive listing; include a soft maxDepth hint
    const cmd = await sendCommand(deviceId, "list_files", { path, recursive: true, maxDepth: 5, limit: 1500 });
    const res = await waitForResultRealtime(cmd.id, 120_000);
    const payload = res.result ?? res;

    if (payload && payload.cwd) st.cwd = payload.cwd;

    let lines = [];
    if (Array.isArray(payload.entries) && payload.entries.length) {
      if (payload.entries.length > 1500) {
        lines.push("⚠️ Tree truncated (too many files)");
      }
      lines = buildTreeFromEntries(payload.entries, path);
    } else if (Array.isArray(payload.files) || Array.isArray(payload.folders)) {
      const entries = [];
      if (Array.isArray(payload.folders)) payload.folders.forEach(f => entries.push({ path: `${path.replace(/\/$/, "")}/${f}`, type: "dir" }));
      if (Array.isArray(payload.files)) payload.files.forEach(f => entries.push({ path: `${path.replace(/\/$/, "")}/${f}`, type: "file" }));
      lines = buildTreeFromEntries(entries, path);
    } else {
      lines = ["```json", JSON.stringify(payload, null, 2), "```"];
    }

    for (const chunk of chunkMessage(lines.join("\n"))) {
      await bot.sendMessage(msg.chat.id, chunk, { parse_mode: "Markdown" });
    }
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ tree failed: ${e.message || e}`);
  }
});

// /upload <path_on_device>
bot.onText(/^\/upload\s+(.+)$/i, async (msg, m) => {
  if (!canRun(msg.chat.id)) {
    bot.sendMessage(msg.chat.id, "⏳ Slow down a bit…");
    return;
  }
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
    if (!prepRes || prepRes.status !== "done") {
      bot.sendMessage(chatId, "❌ prepare_upload failed");
      return;
    }

    const payload = {
      device_id: deviceId,
      source: prepRes.result ?? {},
      bucket: "agent-uploads",
      dest: `${deviceId}/${Date.now()}_${(prepRes.result?.name || "file")}`,
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

// /ping
bot.onText(/^\/ping$/i, async (msg) => {
  if (!canRun(msg.chat.id, 500)) {
    bot.sendMessage(msg.chat.id, "⏳ Slow down a bit…");
    return;
  }
  const deviceId = await getSelectedDevice(msg.chat.id);
  if (!deviceId) return;
  try {
    const cmd = await sendCommand(deviceId, "ping");
    const res = await waitForResultRealtime(cmd.id);
    const payload = res.result ?? res;
    if (payload && payload.ts) {
      bot.sendMessage(msg.chat.id, `🏓 Pong — ts: ${payload.ts}`);
    } else {
      bot.sendMessage(msg.chat.id, "🏓 Pong");
    }
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ ping failed: ${e.message || e}`);
  }
});

// /info (friendly)
bot.onText(/^\/info$/i, async (msg) => {
  if (!canRun(msg.chat.id, 500)) {
    bot.sendMessage(msg.chat.id, "⏳ Slow down a bit…");
    return;
  }
  const deviceId = await getSelectedDevice(msg.chat.id);
  if (!deviceId) return;
  try {
    const cmd = await sendCommand(deviceId, "device_info");
    const res = await waitForResultRealtime(cmd.id);
    const payload = res.result ?? res;
    const text = formatInfo(payload);
    for (const chunk of chunkMessage(text)) await bot.sendMessage(msg.chat.id, chunk, { parse_mode: "Markdown" });
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ info failed: ${e.message || e}`);
  }
});

/* HTTP health / dummy connected link */
http.createServer(async (req, res) => {
  if (req.url === "/") {
    const connectedChats = Array.from(chatState.keys()).length;
    const activeSubs = Array.from(pendingSubs.keys()).length;
    const u = { ok: true, uptime: process.uptime(), connectedChats, activePendingCommands: activeSubs };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(u));
    return;
  }
  res.writeHead(404);
  res.end("not found");
}).listen(PORT, () => console.log(`🚀 Bot + health running on port ${PORT}`));

/* global error guards */
process.on("unhandledRejection", (e) => {
  console.error("Unhandled promise:", e);
});
process.on("uncaughtException", (e) => {
  console.error("Uncaught exception:", e);
});
