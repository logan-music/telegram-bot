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

// webhook (no polling)
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

/* in-memory state */
const chatState = new Map(); // chatId -> { deviceId, cwd }
const pendingSubs = new Map(); // cmdId -> { resolve,reject,timeout,sub,poll, promise }

/* ===== Upload button state ===== */
const fileActions = new Map();
const groupActions = new Map();
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function generateToken() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

function humanSize(bytes) {
  if (bytes == null) return "unknown";
  const b = Number(bytes);
  if (!b) return "0b";
  if (b < 1024) return `${b}b`;
  if (b < 1024 ** 2) return `${Math.round(b / 1024)}kb`;
  if (b < 1024 ** 3) return `${Math.round(b / 1024 ** 2)}mb`;
  return `${Math.round(b / 1024 ** 3)}gb`;
}

/* ===========================
   Helpers / Formatters
   =========================== */

function resolvePath(cwd, input) {
  if (!input || input.trim() === "") return cwd;
  const p = String(input).trim();
  if (p.startsWith("/")) return p;
  if (p === "..") {
    const parts = cwd.split("/").filter(Boolean);
    parts.pop();
    return "/" + parts.join("/");
  }
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

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return "";
  bytes = Number(bytes);
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + " " + sizes[i];
}

function timeAgo(date) {
  const diff = Math.floor((Date.now() - new Date(date)) / 1000);

  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)} mins ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hrs ago`;
  return `${Math.floor(diff / 86400)} days ago`;
}

// Shorter last-seen text, used in device button label (e.g. "3h ago" or "45m ago")
function shortAgo(date) {
  try {
    const diff = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  } catch (e) {
    return "";
  }
}

function formatInfo(obj, deviceId) {
  const lines = [];

  // Device ID
  if (deviceId) {
    lines.push(`📱 Device: ${safeString(deviceId)}`);
  }

  // Model
  if (obj.manufacturer || obj.model) {
    const model = [obj.manufacturer, obj.model].filter(Boolean).join(" ");
    lines.push(`📦 Model: ${safeString(model)}`);
  }

  // Android version
  if (obj.android_version) {
    const sdk = obj.sdk ? ` (SDK ${safeString(obj.sdk)})` : "";
    lines.push(`🤖 Android: ${safeString(obj.android_version)}${sdk}`);
  }

  // Physical device
  if (obj.is_physical_device !== undefined) {
    lines.push(
      `🧠 Physical: ${obj.is_physical_device ? "Yes" : "No"}`
    );
  }

  // Online status (from DB or payload)
  if (obj.online !== undefined) {
    lines.push(
      `${obj.online ? "🟢 Online" : "🔴 Offline"}`
    );
  }

  // Last seen (human readable)
  if (obj.last_seen) {
    lines.push(`🕒 Last seen: ${timeAgo(obj.last_seen)}`);
  }

  return lines.join("\n");
}

// formatListingPlain returns a string (one item per line, folders first)
function formatListingPlain(result) {
  if (!result) return "";

  const folders = [];
  const files = [];

  // Preferred shape: result.entries = [{name, path, type}, ...]
  if (Array.isArray(result.entries)) {
    for (const e of result.entries) {
      const t = (e.type || "").toString().toLowerCase();
      const name = safeString(e.name || e.path || "");
      if (!name) continue;
      if (t === "dir" || t === "directory" || (e.path && e.path.endsWith("/"))) folders.push(name.replace(/\/+$/, ""));
      else files.push(name.replace(/\/+$/, ""));
    }
  }
  // Older shape: result.folders & result.files
  else if (Array.isArray(result.folders) || Array.isArray(result.files)) {
    if (Array.isArray(result.folders)) folders.push(...result.folders.map(s => safeString(s).replace(/\/+$/, "")));
    if (Array.isArray(result.files)) files.push(...result.files.map(s => safeString(s).replace(/\/+$/, "")));
  }
  // If result is a simple array of names
  else if (Array.isArray(result)) {
    result.forEach(r => {
      const s = safeString(r);
      if (s) files.push(s.replace(/\/+$/, ""));
    });
  } else {
    // unknown shape: stringify nicely
    try {
      return JSON.stringify(result, null, 2) + "\n";
    } catch (e) {
      return String(result) + "\n";
    }
  }

  // sort and build lines
  folders.sort((a, b) => a.localeCompare(b));
  files.sort((a, b) => a.localeCompare(b));

  const lines = [
    ...folders.map(n => `📁 ${n}`),
    ...files.map(n => `${n}`)
  ];

  return lines.join("\n") + (lines.length ? "\n" : "");
}

/* ===========================
   DB helpers (adjusted for offline-queue behavior)
   =========================== */

async function validateDevice(deviceId) {
  try {
    const { data, error } = await supabase
      .from("devices")
      .select("id, online, consent, enabled, last_seen")
      .eq("id", deviceId)
      .maybeSingle();

    if (error) {
      console.error("Validate device error:", error);
      return { ok: false, error: error.message };
    }
    if (!data) return { ok: false, error: "device_not_found" };
    if (!data.consent) return { ok: false, error: "device_no_consent" };
    if (!data.enabled) return { ok: false, error: "device_disabled" };

    // IMPORTANT: we no longer fail on offline. We return online flag so callers decide.
    return { ok: true, online: !!data.online, last_seen: data.last_seen };
  } catch (e) {
    console.error("Validate device exception:", e);
    return { ok: false, error: String(e) };
  }
}

/**
 * Get selected device for chat, with validation
 * Returns { deviceId, online } or null
 */
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

  if (!v.online) {
    // Inform user but still proceed (we'll queue & wait long-poll)
    await bot.sendMessage(chatId, "⚠️ Device is currently offline — commands will be queued and delivered when it reconnects. I will wait for a result for up to 7 days.");
  }

  return { deviceId: st.deviceId, online: !!v.online };
}

/**
 * Insert command into database for device to execute
 */
async function sendCommand(deviceId, action, payload = {}) {
  try {
    const { data, error } = await supabase
      .from("device_commands")
      .insert({
        device_id: deviceId,
        action,
        payload,
        status: "pending",
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;

    console.log(`✅ Command created: ${action} for ${deviceId} (id: ${data.id})`);
    return data;
  } catch (e) {
    console.error(`❌ Failed to create command:`, e);
    throw e;
  }
}

/* ===========================
   Realtime wait (subscribe + polling fallback)
   =========================== */
function waitForResultRealtime(cmdId, timeoutMs = 90_000) {
  if (!cmdId) return Promise.reject(new Error("missing_cmd_id"));

  if (pendingSubs.has(cmdId)) {
    return pendingSubs.get(cmdId).promise;
  }

  let resolveFn, rejectFn;
  const promise = new Promise((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });

  const rec = {
    resolve: resolveFn,
    reject: rejectFn,
    sub: null,
    poller: null,
    timeout: null,
    startTime: Date.now(),
    promise,
  };
  pendingSubs.set(cmdId, rec);

  // Realtime subscription
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
          } catch (e) {
            console.error("Realtime handler error:", e);
          }
        }
      )
      .subscribe((status) => {
        // optional: log subscribe status
        console.log(`Realtime subscribe for ${cmdId}: ${status}`);
      });

    rec.sub = channel;
  } catch (e) {
    console.warn("Realtime subscribe failed:", e);
  }

  // Polling fallback
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
    } catch (e) {
      console.error("Polling error:", e);
    }
  }, pollInterval);
  rec.poller = poller;

  function cleanup(success, data) {
    if (!pendingSubs.has(cmdId)) return;
    const r = pendingSubs.get(cmdId);
    clearInterval(r.poller);
    if (r.timeout) clearTimeout(r.timeout);
    if (r.sub) {
      try {
        supabase.removeChannel(r.sub);
      } catch (e) {
        console.warn("Failed to remove channel:", e);
      }
    }
    pendingSubs.delete(cmdId);
    if (success) {
      r.resolve(data);
    } else {
      r.reject(data);
    }
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
    } catch (e) {
      console.error("Timeout check error:", e);
    }
    cleanup(false, new Error("timeout_waiting_result"));
  }, timeoutMs);

  return promise;
}

function unwrapResult(res) {
  if (!res) return null;
  let payload = res.result ?? res;
  if (payload && payload.result) payload = payload.result;
  // If payload is a stringified JSON, try to parse it
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch (e) {
      // leave as-is
    }
  }
  return payload;
}

/* ===========================
   Bot command handlers
   =========================== */

bot.onText(/^\/start$/i, (msg) => {
  const text = [
    "🤖 Media Agent Bot - Online",
    "",
    "Quick Start:",
    "1️⃣ /use <device_id> — Select device",
    "2️⃣ /ls — List files",
    "3️⃣ /send <path> — Upload & get link",
    "4️⃣ /help - View command reference",
    "5️⃣ /devices — list devices",
  ].join("\n");
  bot.sendMessage(msg.chat.id, text);
});

bot.onText(/^\/help$/i, (msg) => {
  const text = [
    "📋 Command Reference",
    "",
    "Device Management:",
    "/use <device_id> — Select device",
    "/devices — List devices (interactive)",
    "/exit — Clear selected device",
    "",
    "File Operations:",
    "/ls [path] — List files (default: cwd)",
    "/tree [path] — Recursive tree (bounded)",
    "/cd <path> — Change directory",
    "/pwd — Show current directory",
    "",
    "File Transfer:",
    "/send <path> — Upload file & get public URL",
    "/upload <path> — Upload via edge function",
    "",
    "Device Info:",
    "/ping — Test connection",
    "/info — Show device details",
  ].join("\n");
  bot.sendMessage(msg.chat.id, text);
});

/* ===========================
   UPDATED: /devices -> send inline buttons
   (replaces old text-only listing)
   =========================== */
bot.onText(/^\/devices$/i, async (msg) => {
  try {
    const { data, error } = await supabase
      .from("devices")
      .select("id, online, last_seen, enabled, consent")
      .order("last_seen", { ascending: false });
    if (error) throw error;
    if (!data?.length) {
      bot.sendMessage(msg.chat.id, "📱 No devices registered yet.");
      return;
    }

    // Build inline keyboard rows: one row per device (single button)
    // Button text includes id + online/offline + last seen + lock/consent flags
    const now = Date.now();
    const inlineRows = [];

    for (const d of data) {
      let statusText = d.online ? "✅ online" : "❌ offline";
      let lastSeenText = "";
      if (!d.online && d.last_seen) {
        const short = shortAgo(d.last_seen);
        if (short) lastSeenText = ` (last seen ${short})`;
      }

      const locked = d.enabled ? "" : " 🔒disabled";
      const consent = d.consent ? "" : " ⚠️no-consent";

      // Build the visible button text (keep it reasonably short)
      // Example: "📱 device-id — ❌ offline (last seen 3h ago) 🔒disabled"
      const btnText = `📱 ${d.id} — ${statusText}${lastSeenText}${locked}${consent}`;

      // Telegram inline button text max length ~64? but it supports longer;
      // Generally keep concise — if it's too long it will be trimmed by UI.
      inlineRows.push([{ text: btnText, callback_data: `use_device:${d.id}` }]);
    }

    await bot.sendMessage(msg.chat.id, `📱 Devices (${data.length}):`, {
      reply_markup: {
        inline_keyboard: inlineRows,
      },
    });

  } catch (e) {
    console.error("List devices error:", e);
    bot.sendMessage(msg.chat.id, `❌ Error: ${e.message || e}`);
  }
});

bot.onText(/^\/use\s+(.+)$/i, async (msg, m) => {
  const deviceId = m[1].trim();
  const v = await validateDevice(deviceId);
  if (!v.ok) {
    bot.sendMessage(msg.chat.id, `❌ Cannot use device: ${v.error}`);
    return;
  }
  chatState.set(msg.chat.id, { deviceId, cwd: "/storage/emulated/0/" });
  bot.sendMessage(msg.chat.id, `✅ Using device: ${deviceId}`);
});

bot.onText(/^\/exit$/i, (msg) => {
  chatState.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, "✅ Session cleared");
});

bot.onText(/^\/cd\s+(.+)$/i, (msg, m) => {
  const st = chatState.get(msg.chat.id);
  if (!st) {
    bot.sendMessage(msg.chat.id, "❌ No device selected. Use /use first.");
    return;
  }
  const newPath = resolvePath(st.cwd, m[1].trim());
  st.cwd = newPath;
  bot.sendMessage(msg.chat.id, `📂 CWD: ${st.cwd}`);
});

bot.onText(/^\/pwd$/i, (msg) => {
  const st = chatState.get(msg.chat.id);
  if (!st) {
    bot.sendMessage(msg.chat.id, "❌ No device selected. Use /use <device_id>");
    return;
  }
  bot.sendMessage(msg.chat.id, `📁 ${st.cwd}`);
});

/* ===== /ls (fast + combined plain list) ===== */
bot.onText(/^\/ls(?:\s+(.*))?$/i, async (msg, m) => {
  const sel = await getSelectedDevice(msg.chat.id);
  if (!sel) return;
  const { deviceId, online } = sel;
  const st = chatState.get(msg.chat.id);
  const requested = (m[1]?.trim() || st.cwd);
  const path = resolvePath(st.cwd, requested);

  try {
    const cmd = await sendCommand(deviceId, "list_files", { path, limit: 500 });
    // if offline, wait long
    const timeout = online ? 30_000 : SEVEN_DAYS_MS;
    if (!online) await bot.sendMessage(msg.chat.id, `⚠️ Device offline — queued command. I will wait for result (up to 7 days).`);

    const res = await waitForResultRealtime(cmd.id, timeout);
    const payload = unwrapResult(res) ?? {};
    if (payload.cwd) st.cwd = payload.cwd;

    const text = formatListingPlain(payload); // now returns single string with trailing newline
    if (!text || text.trim() === "") {
      await bot.sendMessage(msg.chat.id, "📂 (empty)");
    } else {
      const toSend = text.endsWith("\n") ? text : text + "\n";
      for (const chunk of chunkMessage(toSend)) await bot.sendMessage(msg.chat.id, chunk);
    }
  } catch (e) {
    console.error("ls error:", e);
    bot.sendMessage(msg.chat.id, `❌ ls failed: ${e.message || e}`);
  }
});

/* ===== /tree (bounded recursive) ===== */
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
  return [`📁 tree: ${rootPath || "/"}`, ...render(rootChildren)];
}

/* ---------- extract flat file list for buttons ---------- */
function extractFilesFromEntries(entries, rootPath) {
  const files = [];
  for (const e of entries) {
    const p = (e.path || e.name || "").toString();
    const rel = rootPath && p.startsWith(rootPath) ? p.slice(rootPath.length).replace(/^\/+/, "") : p;
    if (!rel) continue;
    const isDir = (e.type && ("" + e.type).toLowerCase().includes("dir")) || (p.endsWith("/"));
    if (isDir) continue;
    const name = rel.split("/").pop() || rel;
    const raw = e;
    const size = raw.size ?? raw.bytes ?? raw.length ?? raw.sizeBytes ?? null;
    files.push({ path: p, name, sizeBytes: size });
  }
  return files;
}

/* ===== /tree command handler with buttons ===== */
bot.onText(/^\/tree(?:\s+(.*))?$/i, async (msg, m) => {
  const chatId = msg.chat.id;
  const sel = await getSelectedDevice(chatId);
  if (!sel) return;
  const { deviceId, online } = sel;
  const st = chatState.get(chatId);
  const requested = (m[1]?.trim() || st.cwd);
  const path = resolvePath(st.cwd, requested);

  try {
    // push history (root if not set)
    const root = st.cwd || "/storage/emulated/0/";
    resetHistory(chatId, root);
    pushHistory(chatId, path);

    const cmd = await sendCommand(deviceId, "list_files", { path, recursive: false, maxDepth: 1, limit: 1500 });
    const timeout = online ? 60_000 : SEVEN_DAYS_MS;
    if (!online) await bot.sendMessage(chatId, `⚠️ Device offline — queued tree command. I will wait for result (up to 7 days).`);

    const res = await waitForResultRealtime(cmd.id, timeout);
    const payload = unwrapResult(res) ?? {};

    const entries = payload.entries || (payload.files || payload.folders ? [] : []);
    // Build view
    const { text, reply_markup } = makeFolderViewPayload(entries, path, deviceId, chatId);

    // send initial message (so subsequent navigation edits this message)
    await bot.sendMessage(chatId, text, { reply_markup });

  } catch (e) {
    console.error("tree error:", e);
    bot.sendMessage(chatId, `❌ tree failed: ${e.message || e}`);
  }
});

/* ===== handler for upload command links (/up_<token>) ===== */
bot.onText(/^\/up_(\w+)/, async (msg, m) => {
  const token = m[1];
  const info = fileActions.get(token);

  if (!info) {
    bot.sendMessage(msg.chat.id, "⚠️ File link expired or invalid.");
    return;
  }

  await bot.sendMessage(
    msg.chat.id,
    `📤 Uploading ${info.name}...`
  );

  try {
    const cmd = await sendCommand(info.deviceId, "upload_file", {
      path: info.path
    });

    const v = await validateDevice(info.deviceId);
    const timeout = v.ok && v.online ? 120_000 : SEVEN_DAYS_MS;

    if (!v.online) {
      await bot.sendMessage(
        msg.chat.id,
        "⚠️ Device offline — upload queued."
      );
    }

    const res = await waitForResultRealtime(cmd.id, timeout);
    const payload = unwrapResult(res) ?? {};

    if (payload.success || payload.url || payload.publicUrl) {
      await bot.sendMessage(
        msg.chat.id,
        `✅ Uploaded: ${info.name}`
      );
    } else {
      await bot.sendMessage(
        msg.chat.id,
        `❌ Upload failed: ${JSON.stringify(payload)}`
      );
    }
  } catch (e) {
    await bot.sendMessage(
      msg.chat.id,
      `❌ Upload error: ${e.message || e}`
    );
  } finally {
    // keep token for a bit or remove depending on preference
    // fileActions.delete(token);
  }
});

/* ===== callback_query handler for navigation + uploads ===== */
bot.on("callback_query", async (q) => {
  try {
    const data = q.data || "";
    const chatId = q.message?.chat?.id ?? q.from?.id;
    // NAVIGATION: nav_<token>  | nav_back | nav_home
    if (data.startsWith("nav_")) {
      // token e.g. nav_<token>
      const token = data.split(":").length > 1 ? data.split(":")[1] : data.slice(4);
      // handle special actions
      if (token === "back" || data === "nav_back") {
        // pop history and show previous
        const prev = popHistory(chatId);
        if (!prev) {
          await bot.answerCallbackQuery(q.id, { text: "No previous folder" });
          return;
        }
        const st = chatState.get(chatId);
        if (!st) { await bot.answerCallbackQuery(q.id, { text: "No device selected" }); return; }
        const deviceId = st.deviceId;
        const v = await validateDevice(deviceId);
        if (!v.ok) {
          await bot.answerCallbackQuery(q.id, { text: `Device invalid: ${v.error}`, show_alert: true });
          return;
        }

        try {
          const cmd = await sendCommand(deviceId, "list_files", { path: prev, recursive: false, maxDepth: 1, limit: 1500 });
          const timeout = v.online ? 60_000 : SEVEN_DAYS_MS;
          const res = await waitForResultRealtime(cmd.id, timeout);
          const payload = unwrapResult(res) ?? {};
          const entries = payload.entries || [];

          const { text, reply_markup } = makeFolderViewPayload(entries, prev, deviceId, chatId);
          // edit the message that had the buttons
          await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: q.message.message_id,
            reply_markup
          });
          await bot.answerCallbackQuery(q.id);
        } catch (err) {
          console.error("nav back error:", err);
          await bot.answerCallbackQuery(q.id, { text: `Error: ${err?.message || err}`, show_alert: true });
        }
        return;
      }

      if (data === "nav_home") {
        const st = chatState.get(chatId);
        if (!st) { await bot.answerCallbackQuery(q.id, { text: "No device selected" }); return; }
        const deviceId = st.deviceId;
        const root = st.cwd || "/storage/emulated/0/";
        resetHistory(chatId, root);
        pushHistory(chatId, root);

        try {
          const v = await validateDevice(deviceId);
          if (!v.ok) {
            await bot.answerCallbackQuery(q.id, { text: `Device invalid: ${v.error}`, show_alert: true });
            return;
          }
          const cmd = await sendCommand(deviceId, "list_files", { path: root, recursive: false, maxDepth: 1, limit: 1500 });
          const timeout = v.online ? 60_000 : SEVEN_DAYS_MS;
          const res = await waitForResultRealtime(cmd.id, timeout);
          const payload = unwrapResult(res) ?? {};
          const entries = payload.entries || [];

          const { text, reply_markup } = makeFolderViewPayload(entries, root, deviceId, chatId);
          await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: q.message.message_id,
            reply_markup
          });
          await bot.answerCallbackQuery(q.id);
        } catch (err) {
          console.error("nav home error:", err);
          await bot.answerCallbackQuery(q.id, { text: `Error: ${err?.message || err}`, show_alert: true });
        }
        return;
      }

      // Normal folder navigation token
      const navToken = data.slice(4);
      const info = navTokens.get(navToken);
      if (!info) {
        await bot.answerCallbackQuery(q.id, { text: "⚠️ Link expired or invalid", show_alert: true });
        return;
      }

      const { deviceId, path } = info;
      // push to history
      pushHistory(chatId, path);

      // fetch entries for path and edit message
      try {
        const v = await validateDevice(deviceId);
        if (!v.ok) {
          await bot.answerCallbackQuery(q.id, { text: `Device invalid: ${v.error}`, show_alert: true });
          return;
        }

        const cmd = await sendCommand(deviceId, "list_files", { path, recursive: false, maxDepth: 1, limit: 1500 });
        const timeout = v.online ? 60_000 : SEVEN_DAYS_MS;
        const res = await waitForResultRealtime(cmd.id, timeout);
        const payload = unwrapResult(res) ?? {};
        const entries = payload.entries || [];

        const { text, reply_markup } = makeFolderViewPayload(entries, path, deviceId, chatId);

        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: q.message.message_id,
          reply_markup
        });

        await bot.answerCallbackQuery(q.id);
      } catch (err) {
        console.error("nav token error:", err);
        await bot.answerCallbackQuery(q.id, { text: `Error: ${err?.message || err}`, show_alert: true });
      }
      return;
    }

    /* ===== existing upload handlers ===== */

    /* Single file upload via inline-upload button (if still used elsewhere) */
    if (data.startsWith("upload:")) {
      const token = data.split(":")[1];
      const info = fileActions.get(token);
      if (!info) {
        await bot.answerCallbackQuery(q.id, { text: "⚠️ Action expired or invalid", show_alert: true });
        return;
      }

      await bot.answerCallbackQuery(q.id, { text: `📤 Uploading ${info.name}...` });
      await bot.sendMessage(info.chatId, `📤 Upload started for: ${info.name}\nPath: ${info.path}`);

      const cmd = await sendCommand(info.deviceId, "upload_file", { path: info.path });
      const v = await validateDevice(info.deviceId);
      const isOnline = v.ok ? !!v.online : true;
      const timeout = isOnline ? 120_000 : SEVEN_DAYS_MS;
      if (!isOnline) {
        await bot.sendMessage(info.chatId, `⚠️ Device is offline — upload queued. I will wait for result (up to 7 days).`);
      }

      let res;
      try {
        res = await waitForResultRealtime(cmd.id, timeout);
      } catch (err) {
        await bot.sendMessage(info.chatId, `❌ Upload failed / timed out: ${err?.message || err}`);
        fileActions.delete(token);
        return;
      }

      const payload = unwrapResult(res) ?? {};
      const success = payload.success === true || payload.publicUrl || payload.public_url || payload.url;

      if (!success) {
        const errMsg = payload.error || payload.detail || JSON.stringify(payload);
        await bot.sendMessage(info.chatId, `❌ Upload failed for ${info.name}: ${errMsg}`);
      } else {
        const publicUrl = payload.publicUrl || payload.public_url || payload.url;
        const actualDest = payload.path || payload.dest || `${info.deviceId}/${info.name}`;
        const sizeText = payload.size ? formatBytes(payload.size) : "";
        if (publicUrl) {
          await bot.sendMessage(info.chatId, `✅ Uploaded: ${info.name}\n📁 ${actualDest}\n${sizeText ? `📊 ${sizeText}\n` : ""}🔗 ${publicUrl}`);
        } else {
          await bot.sendMessage(info.chatId, `✅ Uploaded: ${info.name}\n📁 ${actualDest}\n${sizeText ? `📊 ${sizeText}` : ""}`);
        }
      }

      fileActions.delete(token);
      return;
    }

    // Upload all handler (kept for compatibility)
    if (data.startsWith("upload_all:")) {
      const gtoken = data.split(":")[1];
      const list = groupActions.get(gtoken);
      if (!list || !Array.isArray(list) || list.length === 0) {
        await bot.answerCallbackQuery(q.id, { text: "⚠️ Group expired or invalid", show_alert: true });
        return;
      }

      await bot.answerCallbackQuery(q.id, { text: `📤 Uploading ${list.length} files...` });
      const info = list[0];
      const chatId = info.chatId;
      await bot.sendMessage(chatId, `📤 Upload-all started for ${list.length} files...`);

      // Sequential processing (safer & gives nicer progress)
      let idx = 0;
      for (const item of list) {
        idx++;
        try {
          await bot.sendMessage(chatId, `⏳ (${idx}/${list.length}) Uploading ${item.name} ...`);
        } catch (_) {}
        try {
          const cmd = await sendCommand(item.deviceId, "upload_file", { path: item.path });
          const v = await validateDevice(item.deviceId);
          const isOnline = v.ok ? !!v.online : true;
          const timeout = isOnline ? 120_000 : SEVEN_DAYS_MS;
          if (!isOnline) {
            await bot.sendMessage(chatId, `⚠️ Device offline — ${item.name} queued. I will wait (up to 7 days).`);
          }

          let res;
          try {
            res = await waitForResultRealtime(cmd.id, timeout);
          } catch (err) {
            await bot.sendMessage(chatId, `❌ (${idx}/${list.length}) ${item.name} failed / timed out: ${err?.message || err}`);
            continue;
          }

          const payload = unwrapResult(res) ?? {};
          const success = payload.success === true || payload.publicUrl || payload.public_url || payload.url;
          if (!success) {
            const errMsg = payload.error || payload.detail || JSON.stringify(payload);
            await bot.sendMessage(chatId, `❌ (${idx}/${list.length}) ${item.name} failed: ${errMsg}`);
          } else {
            const publicUrl = payload.publicUrl || payload.public_url || payload.url;
            const actualDest = payload.path || payload.dest || `${item.deviceId}/${item.name}`;
            const sizeText = payload.size ? formatBytes(payload.size) : "";
            if (publicUrl) {
              await bot.sendMessage(chatId, `✅ (${idx}/${list.length}) Uploaded: ${item.name}\n📁 ${actualDest}\n${sizeText ? `📊 ${sizeText}\n` : ""}🔗 ${publicUrl}`);
            } else {
              await bot.sendMessage(chatId, `✅ (${idx}/${list.length}) Uploaded: ${item.name}\n📁 ${actualDest}\n${sizeText ? `📊 ${sizeText}` : ""}`);
            }
          }
        } catch (err) {
          console.error("upload_all item error:", err);
          try {
            await bot.sendMessage(chatId, `❌ (${idx}/${list.length}) ${item.name} error: ${err?.message || err}`);
          } catch (_) {}
        }
      }

      // Done
      try {
        await bot.sendMessage(chatId, `🏁 Upload-all finished for ${list.length} files.`);
      } catch (_) {}

      groupActions.delete(gtoken);
      return;
    }

    // not our callback
  } catch (e) {
    console.error("callback_query handler error:", e);
    try {
      await bot.answerCallbackQuery(q.id, { text: `❌ Handler error`, show_alert: true });
    } catch (_) {}
  }
});

/* ===== /send <path> (upload helper) ===== */
bot.onText(/^\/send\s+(.+)$/i, async (msg, m) => {
  const chatId = msg.chat.id;
  const sel = await getSelectedDevice(chatId);
  if (!sel) return;
  const { deviceId, online } = sel;
  const st = chatState.get(chatId);
  const requested = m[1].trim();
  const path = resolvePath(st.cwd, requested);

  await bot.sendMessage(chatId, "📤 Sending file...");
  try {
    const destName = (path.split("/").pop() || "file").replace(/\s+/g, "_");
    const dest = `${deviceId}/${Date.now()}_${destName}`;
    const bucket = "device-uploads";

    const cmd = await sendCommand(deviceId, "upload_file", { path, bucket, dest });
    const timeout = online ? 120_000 : SEVEN_DAYS_MS;
    if (!online) await bot.sendMessage(chatId, `⚠️ Device offline — upload queued. I will wait for result (up to 7 days).`);

    const res = await waitForResultRealtime(cmd.id, timeout);
    const payload = unwrapResult(res) ?? {};

    const success = payload.success === true || payload.publicUrl || payload.public_url || payload.url;
    if (!success) {
      const errorMsg = payload.error || payload.detail || "Unknown error";
      await bot.sendMessage(chatId, `❌ Upload failed: ${errorMsg}`);
      return;
    }

    const publicUrl = payload.publicUrl || payload.public_url || payload.url;
    const actualDest = payload.path || payload.dest || dest;
    const size = payload.size ? formatBytes(payload.size) : "unknown size";

    if (publicUrl) {
      await bot.sendMessage(chatId, `✅ File uploaded\n📁 ${actualDest}\n📊 ${size}\n🔗 ${publicUrl}`);
    } else {
      await bot.sendMessage(chatId, `✅ File uploaded to ${actualDest} (${size})`);
    }
  } catch (e) {
    console.error("send error:", e);
    bot.sendMessage(chatId, `❌ Error: ${e.message || e}`);
  }
});

/* ===== /upload (edge function) ===== */
bot.onText(/^\/upload\s+(.+)$/i, async (msg, m) => {
  const chatId = msg.chat.id;
  const sel = await getSelectedDevice(chatId);
  if (!sel) return;
  const { deviceId, online } = sel;
  const st = chatState.get(chatId);
  const requested = m[1].trim();
  const path = resolvePath(st.cwd, requested);

  await bot.sendMessage(chatId, "📦 Preparing upload...");
  try {
    const prepCmd = await sendCommand(deviceId, "prepare_upload", { path });
    const timeout = online ? 90_000 : SEVEN_DAYS_MS;
    if (!online) await bot.sendMessage(chatId, `⚠️ Device offline — upload queued. I will wait for result (up to 7 days).`);

    const prepRes = await waitForResultRealtime(prepCmd.id, timeout);
    const prepPayload = unwrapResult(prepRes);
    if (!prepPayload || !prepPayload.success) {
      bot.sendMessage(chatId, `❌ Prepare failed: ${JSON.stringify(prepPayload)}`);
      return;
    }

    const source = {
      is_content_uri: !!prepPayload.is_content_uri,
      uri: prepPayload.uri || null,
      file_path: prepPayload.path || path,
      meta: prepPayload,
    };

    const destName = (prepPayload.name || path.split("/").pop() || "file").replace(/\s+/g, "_");
    const payload = {
      device_id: deviceId,
      bucket: "device-uploads",
      dest: `${deviceId}/${Date.now()}_${destName}`,
      source,
    };

    await bot.sendMessage(chatId, "☁️ Uploading to storage...");
    const { data, error } = await supabase.functions.invoke("upload-file", { body: payload });

    if (error) {
      bot.sendMessage(chatId, `❌ Upload failed: ${error.message || JSON.stringify(error)}`);
      return;
    }
    if (data && data.error) {
      bot.sendMessage(chatId, `❌ Upload failed (function): ${data.error}`);
      return;
    }

    const size = data.size ? formatBytes(data.size) : "unknown";
    bot.sendMessage(chatId, `✅ Uploaded\n📁 Bucket: ${data.bucket}\n📄 Path: ${data.path}\n📊 Size: ${size}`);
  } catch (e) {
    console.error("upload error:", e);
    bot.sendMessage(chatId, `❌ upload error: ${e.message || e}`);
  }
});

/* ===== /ping ===== */
bot.onText(/^\/ping$/i, async (msg) => {
  const sel = await getSelectedDevice(msg.chat.id);
  if (!sel) return;
  const { deviceId, online } = sel;
  try {
    const cmd = await sendCommand(deviceId, "ping");
    const timeout = online ? 20_000 : SEVEN_DAYS_MS;
    if (!online) await bot.sendMessage(msg.chat.id, `⚠️ Device offline — ping queued. I will wait (up to 7 days).`);

    const res = await waitForResultRealtime(cmd.id, timeout);
    const payload = unwrapResult(res) ?? {};
    const ts = payload.timestamp || payload.ts || Date.now();
    bot.sendMessage(msg.chat.id, `🏓 Pong\n⏱️ ${ts}`);
  } catch (e) {
    console.error("ping error:", e);
    bot.sendMessage(msg.chat.id, `❌ Ping failed: ${e.message || e}`);
  }
});

/* ===== /info ===== */
bot.onText(/^\/info$/i, async (msg) => {
  const sel = await getSelectedDevice(msg.chat.id);
  if (!sel) return;

  const { deviceId, online } = sel;

  try {
    const cmd = await sendCommand(deviceId, "device_info");
    const timeout = online ? 20_000 : SEVEN_DAYS_MS;

    if (!online) {
      await bot.sendMessage(
        msg.chat.id,
        "⚠️ Device offline — info command queued. Waiting for response..."
      );
    }

    const res = await waitForResultRealtime(cmd.id, timeout);
    const payload = unwrapResult(res) ?? {};

    const st = chatState.get(msg.chat.id);
    if (payload.cwd && st) st.cwd = payload.cwd;

    const text = formatInfo(payload, deviceId) || "No info.";
    for (const chunk of chunkMessage(text)) {
      await bot.sendMessage(msg.chat.id, chunk);
    }
  } catch (e) {
    bot.sendMessage(
      msg.chat.id,
      `❌ info failed: ${e.message || e}`
    );
  }
});

/* ===========================
   Webhook server + health
   =========================== */

async function ensureWebhook() {
  try {
    const hook = `${WEBHOOK_URL.replace(/\/$/, "")}/bot${BOT_TOKEN}`;
    await bot.setWebHook(hook);
    console.log("Webhook set:", hook);
  } catch (err) {
    console.error("Failed to set webhook:", err?.response?.body || err?.message || err);
    if (err?.response?.statusCode === 409) {
      console.error("Conflict (409) - ensure no other bot instance is running.");
    }
  }
}

await ensureWebhook();

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === `/bot${BOT_TOKEN}`) {
      let body = "";
      req.on("data", chunk => (body += chunk));
      req.on("end", async () => {
        try {
          if (!body) { res.writeHead(400); res.end("no body"); return; }
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

    if (req.method === "GET" && req.url === "/") {
      const connectedChats = chatState.size;
      const activeSubs = pendingSubs.size;
      const u = { ok: true, uptime: process.uptime(), connectedChats, activePendingCommands: activeSubs, timestamp: new Date().toISOString() };
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

server.listen(PORT, () => {
  console.log(`🚀 Webhook server listening on port ${PORT}`);
  console.log(`Webhook endpoint: POST ${WEBHOOK_URL.replace(/\/$/, "")}/bot${BOT_TOKEN}`);
});

/* housekeeping */
bot.on("polling_error", (err) => {
  console.warn("polling_error:", err?.message || err);
});

process.on("unhandledRejection", (e) => {
  console.error("Unhandled promise:", e);
});
process.on("uncaughtException", (e) => {
  console.error("Uncaught exception:", e);
  process.exit(1);
});