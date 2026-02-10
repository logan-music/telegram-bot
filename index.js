// media-agent-bot-compact.js
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
const pendingSubs = new Map(); // cmdId -> { resolve,reject,timeout,sub,poller,promise }

/* token maps */
const fileActions = new Map();   // token -> { deviceId, path, name, chatId, createdAt }
const dirActions = new Map();    // token -> { path, chatId, deviceId, createdAt }
const groupActions = new Map();  // token -> [ { deviceId, path, name, chatId } ]
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function generateToken() {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

/* ===========================
   Auto-clean per-command helpers
   =========================== */

// map key = `${chatId}:${command}` -> array of message_ids
const lastCommandMessages = new Map();

/**
 * Register a message id produced by a particular command for a chat.
 */
function registerCommandMessage(chatId, command, messageId) {
  if (!chatId || !command || !messageId) return;
  const key = `${chatId}:${command}`;
  if (!lastCommandMessages.has(key)) lastCommandMessages.set(key, []);
  lastCommandMessages.get(key).push(messageId);
}

/**
 * Clean previous messages created by `command` in `chatId`.
 * Attempt to delete each message; if deletion fails, clear its inline keyboard.
 */
async function cleanCommandMessages(chatId, command) {
  if (!chatId || !command) return;
  const key = `${chatId}:${command}`;
  const msgs = lastCommandMessages.get(key);
  if (!msgs || !msgs.length) return;
  for (const mid of msgs) {
    try {
      await bot.deleteMessage(chatId, mid);
    } catch (delErr) {
      // If deletion fails (too old or already deleted), try to disable the keyboard
      try {
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: mid });
      } catch (_) {
        // swallow
      }
    }
  }
  lastCommandMessages.delete(key);
}

/**
 * Convenience wrapper: sends a message and registers it under a command.
 * If `options` is provided, pass to bot.sendMessage.
 */
async function sendAndRegister(chatId, command, text, options = {}) {
  const sent = await bot.sendMessage(chatId, text, options);
  try {
    registerCommandMessage(chatId, command, sent.message_id);
  } catch (_) {}
  return sent;
}

/* ===========================
   Small helpers & formatters
   =========================== */

function humanSize(bytes) {
  if (bytes == null) return "unknown";
  const b = Number(bytes);
  if (!b) return "0b";
  if (b < 1024) return `${b}b`;
  if (b < 1024 ** 2) return `${Math.round(b / 1024)}kb`;
  if (b < 1024 ** 3) return `${Math.round(b / 1024 ** 2)}mb`;
  return `${Math.round(b / 1024 ** 3)}gb`;
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
  try {
    const diff = Math.floor((Date.now() - new Date(date)) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)} mins ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} hrs ago`;
    return `${Math.floor(diff / 86400)} days ago`;
  } catch (e) {
    return "";
  }
}

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

function safeString(s) {
  if (s === null || s === undefined) return "";
  return String(s);
}

function chunkMessage(text, max = 3800) {
  const parts = [];
  for (let i = 0; i < text.length; i += max) parts.push(text.slice(i, i + max));
  return parts;
}

const truncate = (s, n = 20) => {
  try {
    if (!s) return "";
    return (typeof s === "string" && s.length > n) ? (s.slice(0, n - 1) + "…") : s;
  } catch (_) {
    return s;
  }
};

// Escape special characters for Telegram to avoid entity parsing errors
function escapeMarkdown(text) {
  if (!text) return "";
  return String(text)
    .replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

/* ===========================
   Listing & formatting helpers
   =========================== */

function formatListingPlain(result) {
  if (!result) return "";

  const folders = [];
  const files = [];

  if (Array.isArray(result.entries)) {
    for (const e of result.entries) {
      const t = (e.type || "").toString().toLowerCase();
      const name = safeString(e.name || e.path || "");
      if (!name) continue;
      if (t === "dir" || t === "directory" || (e.path && e.path.endsWith("/"))) folders.push(name.replace(/\/+$/, ""));
      else files.push(name.replace(/\/+$/, ""));
    }
  } else if (Array.isArray(result.folders) || Array.isArray(result.files)) {
    if (Array.isArray(result.folders)) folders.push(...result.folders.map(s => safeString(s).replace(/\/+$/, "")));
    if (Array.isArray(result.files)) files.push(...result.files.map(s => safeString(s).replace(/\/+$/, "")));
  } else if (Array.isArray(result)) {
    result.forEach(r => {
      const s = safeString(r);
      if (s) files.push(s.replace(/\/+$/, ""));
    });
  } else {
    try {
      return JSON.stringify(result, null, 2) + "\n";
    } catch (e) {
      return String(result) + "\n";
    }
  }

  folders.sort((a, b) => a.localeCompare(b));
  files.sort((a, b) => a.localeCompare(b));

  const lines = [
    ...folders.map(n => `📁 ${n}`),
    ...files.map(n => `${n}`)
  ];

  return lines.join("\n") + (lines.length ? "\n" : "");
}

/* ===========================
   DB helpers
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

    return { ok: true, online: !!data.online, last_seen: data.last_seen };
  } catch (e) {
    console.error("Validate device exception:", e);
    return { ok: false, error: String(e) };
  }
}

async function getSelectedDevice(chatId) {
  const st = chatState.get(chatId);
  if (!st?.deviceId) {
    await bot.sendMessage(chatId, "❌ No device selected. Use /use <device_id> or pick one from /devices");
    return null;
  }

  const v = await validateDevice(st.deviceId);
  if (!v.ok) {
    await bot.sendMessage(chatId, `❌ Device invalid: ${v.error}`);
    chatState.delete(chatId);
    return null;
  }

  if (!v.online) {
    await bot.sendMessage(chatId, "⚠️ Device is currently offline — commands will be queued and delivered when it reconnects. I will wait for a result for up to 7 days.");
  }

  return { deviceId: st.deviceId, online: !!v.online };
}

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
   Realtime wait w/ polling fallback
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
        console.log(`Realtime subscribe for ${cmdId}: ${status}`);
      });

    rec.sub = channel;
  } catch (e) {
    console.warn("Realtime subscribe failed:", e);
  }

  // Polling fallback (500ms)
  const pollInterval = 250;
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
   Compact listing UI: clickable folders & files
   (Now auto-cleans previous "ls" results per-chat)
   =========================== */
async function sendListingWithButtonsCompact(chatId, deviceId, st, payload) {
  const COMMAND = "ls";
  // Clean previous ls results in this chat
  try { await cleanCommandMessages(chatId, COMMAND); } catch (_) {}

  const entries = [];

  if (Array.isArray(payload.entries)) {
    entries.push(...payload.entries);
  } else if (Array.isArray(payload.folders) || Array.isArray(payload.files)) {
    if (Array.isArray(payload.folders)) {
      payload.folders.forEach(f =>
        entries.push({
          path: `${st.cwd.replace(/\/$/, "")}/${f}`,
          type: "dir",
          name: f
        })
      );
    }
    if (Array.isArray(payload.files)) {
      payload.files.forEach(f =>
        entries.push({
          path: `${st.cwd.replace(/\/$/, "")}/${f}`,
          type: "file",
          name: f
        })
      );
    }
  } else {
    const txt = JSON.stringify(payload, null, 2);
    for (const chunk of chunkMessage(txt)) {
      const sent = await sendAndRegister(chatId, COMMAND, chunk);
      // plain text chunks without keyboard are also registered to be removed next time
    }
    return;
  }

  // split dirs & files
  const dirs = [];
  const files = [];

  for (const e of entries) {
    const p = e.path || e.name || "";
    const isDir =
      (e.type && ("" + e.type).toLowerCase().includes("dir")) ||
      String(p).endsWith("/");

    const name =
      e.name || String(p).split("/").filter(Boolean).pop() || p;

    const size =
      e.size ?? e.bytes ?? e.length ?? e.sizeBytes ?? null;

    if (isDir) {
      dirs.push({ name, path: p });
    } else {
      files.push({ name, path: p, sizeBytes: size });
    }
  }

  // if no folders → show empty folder button
  if (dirs.length === 0) {
    dirs.push({
      name: "(empty)",
      path: null,
      isEmpty: true
    });
  }

  // simple header (NO tree view)
  let txt = `📂 ${st.cwd}\n`;
  txt += `Folders: ${dirs.length === 1 && dirs[0].isEmpty ? 0 : dirs.length} | Files: ${files.length}`;

  // keyboard
  const kb = [];

  function pushGrid(items, labelFunc, callbackPrefix, perRow = 2) {
    for (let i = 0; i < items.length; i += perRow) {
      const row = [];

      for (let j = i; j < Math.min(i + perRow, items.length); j++) {
        const it = items[j];

        // empty folder → no action
        if (it.isEmpty) {
          row.push({
            text: "📁 (empty)",
            callback_data: "nav:noop"
          });
          continue;
        }

        const token = generateToken();

        if (callbackPrefix === "nav:cd:") {
          dirActions.set(token, {
            path: it.path,
            chatId,
            deviceId,
            createdAt: Date.now()
          });
          setTimeout(() => dirActions.delete(token), SEVEN_DAYS_MS);
        } else if (callbackPrefix === "upload:") {
          fileActions.set(token, {
            deviceId,
            path: it.path,
            name: it.name,
            chatId,
            createdAt: Date.now()
          });
          setTimeout(() => fileActions.delete(token), SEVEN_DAYS_MS);
        }

        row.push({
          text: labelFunc(it, j),
          callback_data: `${callbackPrefix}${token}`
        });
      }

      kb.push(row);
    }
  }

  // folders buttons only
  pushGrid(
    dirs,
    it => `📁 ${truncate(it.name, 16)}`,
    "nav:cd:",
    2
  );

  // files buttons
  pushGrid(
    files,
    (it, idx) => `${idx + 1}. ${truncate(it.name, 16)}`,
    "upload:",
    2
  );

  // bottom navigation
  const navRow = [
    {
      text: "📱 Devices",
      callback_data: "action:devices"
    },
    {
      text: "🔄 Refresh",
      callback_data: "action:browse"
    }
  ];
  kb.push(navRow);

  // send message(s) — register them for "ls" command
  const chunks = chunkMessage(txt);
  const lastIdx = chunks.length - 1;

  for (let i = 0; i < chunks.length; i++) {
    if (i === lastIdx) {
      const sent = await sendAndRegister(chatId, COMMAND, chunks[i], { reply_markup: { inline_keyboard: kb } });
    } else {
      const sent = await sendAndRegister(chatId, COMMAND, chunks[i]);
    }
  }

  // For extra files beyond those in grid, create grouped paginated upload-all messages
  if (files.length > 40) {
    const remaining = files.slice(40);
    const PER_MSG = 8;
    for (let i = 0; i < remaining.length; i += PER_MSG) {
      const slice = remaining.slice(i, i + PER_MSG);
      const groupToken = generateToken();
      const groupList = slice.map((f) => ({
        deviceId,
        path: f.path,
        name: f.name,
        chatId,
        createdAt: Date.now()
      }));
      groupActions.set(groupToken, groupList);
      setTimeout(() => groupActions.delete(groupToken), SEVEN_DAYS_MS);

      const listLines = slice.map((f, idx) => `${i + idx + 41}. ${truncate(f.name, 30)} ${f.sizeBytes ? `(${humanSize(f.sizeBytes)})` : ""}`);
      const messageText = `More files:\n` + listLines.join("\n");

      const inlineKeyboard = [];
      inlineKeyboard.push([{ text: `⬆ Upload all (${slice.length})`, callback_data: `upload_all:${groupToken}` }]);
      for (let j = 0; j < slice.length; j++) {
        const f = slice[j];
        const t = generateToken();
        fileActions.set(t, { deviceId, path: f.path, name: f.name, chatId, createdAt: Date.now() });
        setTimeout(() => fileActions.delete(t), SEVEN_DAYS_MS);
        inlineKeyboard.push([{ text: `${truncate(f.name, 28)}`, callback_data: `upload:${t}` }]);
      }
      inlineKeyboard.push(navRow);
      await sendAndRegister(chatId, COMMAND, messageText, { reply_markup: { inline_keyboard: inlineKeyboard } });
    }
  }
}
/* ===========================
   Format device info (kept small)
   =========================== */
function formatInfo(obj, deviceId) {
  const lines = [];
  if (deviceId) lines.push(`Device: ${safeString(deviceId)}`);
  if (obj.manufacturer || obj.model) {
    const model = [obj.manufacturer, obj.model].filter(Boolean).join(" ");
    lines.push(`Model: ${safeString(model)}`);
  }
  if (obj.android_version) {
    const sdk = obj.sdk ? ` (SDK ${safeString(obj.sdk)})` : "";
    lines.push(`Android: ${safeString(obj.android_version)}${sdk}`);
  }
  if (obj.is_physical_device !== undefined) lines.push(`Physical: ${obj.is_physical_device ? "Yes" : "No"}`);
  if (obj.online !== undefined) lines.push(`${obj.online ? "🟢 Online" : "🔴 Offline"}`);
  if (obj.last_seen) lines.push(`Last seen: ${timeAgo(obj.last_seen)}`);
  return lines.join("\n");
}

/* ===========================
   Commands and handlers (compact)
   =========================== */
bot.onText(/^\/start$/i, async (msg) => {
  const welcomeText = `Media Agent Bot - Your Device Commander

Quick Actions:`;
  const keyboard = {
    inline_keyboard: [
      [
        { text: "📱 My Devices", callback_data: "action:devices" },
        { text: "📊 Stats", callback_data: "menu:stats" }
      ],
      [
        { text: "📂 Browse Files", callback_data: "menu:browse" },
        { text: "⚙️ Settings", callback_data: "menu:settings" }
      ],
      [
        { text: "❓ Help", callback_data: "menu:help" },
        { text: "📚 Commands", callback_data: "menu:commands" }
      ]
    ]
  };

  await bot.sendMessage(msg.chat.id, welcomeText, {
    reply_markup: keyboard
  });
});

bot.onText(/^\/help$/i, (msg) => {
  const text = [
    "Command Reference",
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

/* ===== /devices (compact 2-per-row) ===== */
bot.onText(/^\/devices$/i, async (msg) => {
  const chatId = msg.chat.id;
  const COMMAND = "devices";
  try {
    await cleanCommandMessages(chatId, COMMAND);

    const { data, error } = await supabase
      .from("devices")
      .select("id, online, last_seen, enabled, consent")
      .order("last_seen", { ascending: false });
    if (error) throw error;
    if (!data?.length) {
      const keyboard = { inline_keyboard: [[ { text: "➕ Add Device", url: "https://yourapp.com/register" } ]] };
      const sent = await sendAndRegister(chatId, COMMAND, "No devices registered yet.\n\nRegister your first device to get started!", { reply_markup: keyboard });
      return;
    }

    const rows = [];
    for (let i = 0; i < data.length; i += 2) {
      const row = [];
      for (let j = i; j < Math.min(i + 2, data.length); j++) {
        const d = data[j];
        const statusIcon = d.online ? "🟢" : "🔴";
        const short = (!d.online && d.last_seen) ? ` ${shortAgo(d.last_seen)}` : "";
        const displayId = d.id.length > 18 ? `${d.id.slice(0, 16)}…` : d.id;
        // compact text: status + short id
        const btnText = `${statusIcon} ${displayId}${short}`;
        row.push({ text: btnText, callback_data: `device_select:${d.id}` });
      }
      rows.push(row);
    }

    rows.push([{ text: "🔄 Refresh", callback_data: "refresh_devices" }]);

    await sendAndRegister(chatId, COMMAND, `Devices (${data.length}):`, {
      reply_markup: { inline_keyboard: rows }
    });

  } catch (e) {
    console.error("List devices error:", e);
    bot.sendMessage(msg.chat.id, `Error: ${e.message || e}`);
  }
});

/* ===== /use ===== */
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

/* ===== /exit /cd /pwd ===== */
bot.onText(/^\/exit$/i, (msg) => {
  chatState.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, "✅ Session cleared");
});

function resolvePath(cwd, input) {
  if (!input || input.trim() === "") return cwd;
  const p = String(input).trim();
  if (p.startsWith("/")) {
    return p.endsWith("/") ? p : p + "/";
  }
  if (p === "..") {
    const parts = cwd.split("/").filter(Boolean);
    parts.pop();
    const res = "/" + parts.join("/");
    return res.endsWith("/") ? res : res + "/";
  }
  return `${cwd.replace(/\/+$/, "")}/${p}` + (p.endsWith("/") ? "" : "/");
}

bot.onText(/^\/cd\s+(.+)$/i, (msg, m) => {
  const st = chatState.get(msg.chat.id);
  if (!st) {
    bot.sendMessage(msg.chat.id, "❌ No device selected. Use /use first.");
    return;
  }
  const newPath = resolvePath(st.cwd, m[1].trim());
  st.cwd = newPath.endsWith("/") ? newPath : newPath + "/";
  bot.sendMessage(msg.chat.id, `Directory: ${st.cwd}`);
});

bot.onText(/^\/pwd$/i, (msg) => {
  const st = chatState.get(msg.chat.id);
  if (!st) {
    bot.sendMessage(msg.chat.id, "❌ No device selected. Use /use <device_id>");
    return;
  }
  bot.sendMessage(msg.chat.id, `${st.cwd}`);
});

/* ===== /ls (compact interactive) ===== */
bot.onText(/^\/ls(?:\s+(.*))?$/i, async (msg, m) => {
  const sel = await getSelectedDevice(msg.chat.id);
  if (!sel) return;
  const { deviceId, online } = sel;
  const st = chatState.get(msg.chat.id);
  const requested = (m[1]?.trim() || st.cwd);
  const path = resolvePath(st.cwd, requested);

  try {
    const cmd = await sendCommand(deviceId, "list_files", { path, limit: 500 });
    const timeout = online ? 30_000 : SEVEN_DAYS_MS;
    if (!online) await bot.sendMessage(msg.chat.id, `⚠️ Device offline — queued command. I will wait for result (up to 7 days).`);

    const res = await waitForResultRealtime(cmd.id, timeout);
    const payload = unwrapResult(res) ?? {};
    if (payload.cwd) st.cwd = payload.cwd;

    await sendListingWithButtonsCompact(msg.chat.id, deviceId, st, payload);
  } catch (e) {
    console.error("ls error:", e);
    bot.sendMessage(msg.chat.id, `❌ ls failed: ${e.message || e}`);
  }
});

/* ===== /tree (kept similar) ===== */
function buildTreeFromEntriesSafe(entries, rootPath) {
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
  return [`tree: ${rootPath || "/"}`, ...render(rootChildren)];
}

function extractFilesFromEntriesSafe(entries, rootPath) {
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

bot.onText(/^\/tree(?:\s+(.*))?$/i, async (msg, m) => {
  const chatId = msg.chat.id;
  const COMMAND = "tree";
  const sel = await getSelectedDevice(chatId);
  if (!sel) return;
  const { deviceId, online } = sel;
  const st = chatState.get(chatId);
  const requested = (m[1]?.trim() || st.cwd);
  const path = resolvePath(st.cwd, requested);

  try {
    // Clean previous tree outputs
    await cleanCommandMessages(chatId, COMMAND);

    const cmd = await sendCommand(deviceId, "list_files", { path, recursive: true, maxDepth: 5, limit: 1500 });
    const timeout = online ? 120_000 : SEVEN_DAYS_MS;
    if (!online) await bot.sendMessage(chatId, `⚠️ Device offline — queued tree command. I will wait for result (up to 7 days).`);

    const res = await waitForResultRealtime(cmd.id, timeout);
    const payload = unwrapResult(res) ?? {};

    if (payload && payload.cwd) st.cwd = payload.cwd;

    let lines = [];
    let filesForButtons = [];
    if (Array.isArray(payload.entries) && payload.entries.length) {
      if (payload.entries.length > 1500) lines.push("⚠️ Tree truncated (too many files)");
      lines = lines.concat(buildTreeFromEntriesSafe(payload.entries, path));
      filesForButtons = extractFilesFromEntriesSafe(payload.entries, path);
    } else if (Array.isArray(payload.files) || Array.isArray(payload.folders)) {
      const entriesArr = [];
      if (Array.isArray(payload.folders)) payload.folders.forEach(f => entriesArr.push({ path: `${path.replace(/\/$/, "")}/${f}`, type: "dir" }));
      if (Array.isArray(payload.files)) payload.files.forEach(f => entriesArr.push({ path: `${path.replace(/\/$/, "")}/${f}`, type: "file" }));
      lines = buildTreeFromEntriesSafe(entriesArr, path);
      filesForButtons = extractFilesFromEntriesSafe(entriesArr, path);
    } else {
      lines = [JSON.stringify(payload, null, 2)];
    }

    const txt = (Array.isArray(lines) ? lines.join("\n") : String(lines)) + "\n";
    for (const chunk of chunkMessage(txt)) {
      await sendAndRegister(chatId, COMMAND, chunk);
    }

    if (filesForButtons.length) {
      const PER_MSG = 8;
      for (let i = 0; i < filesForButtons.length; i += PER_MSG) {
        const slice = filesForButtons.slice(i, i + PER_MSG);
        const groupToken = generateToken();
        const groupList = slice.map((f) => ({
          deviceId,
          path: f.path,
          name: f.name,
          chatId,
          createdAt: Date.now()
        }));
        groupActions.set(groupToken, groupList);
        setTimeout(() => groupActions.delete(groupToken), SEVEN_DAYS_MS);

        const listLines = slice.map((f, idx) => {
          const idxGlobal = i + idx + 1;
          const sizeText = `(${humanSize(f.sizeBytes)})`;
          return `${idxGlobal}. ${truncate(f.name, 28)} ${sizeText}`;
        });
        const messageText = `Files (${i + 1}-${Math.min(filesForButtons.length, i + PER_MSG)}):\n` + listLines.join("\n");

        const inlineKeyboard = [];
        inlineKeyboard.push([{ text: `⬆ Upload all (${slice.length})`, callback_data: `upload_all:${groupToken}` }]);
        for (let j = 0; j < slice.length; j++) {
          const f = slice[j];
          const t = generateToken();
          fileActions.set(t, {
            deviceId,
            path: f.path,
            name: f.name,
            chatId,
            createdAt: Date.now()
          });
          setTimeout(() => fileActions.delete(t), SEVEN_DAYS_MS);
          const label = `${i + j + 1}. ${truncate(f.name, 30)}`;
          inlineKeyboard.push([{ text: label, callback_data: `upload:${t}` }]);
        }
        inlineKeyboard.push([{ text: "🔙 Back", callback_data: `device_select:${deviceId}` }]);
        await sendAndRegister(chatId, COMMAND, messageText, {
          reply_markup: { inline_keyboard: inlineKeyboard }
        });
      }
    }

  } catch (e) {
    console.error("tree error:", e);
    bot.sendMessage(chatId, `❌ tree failed: ${e.message || e}`);
  }
});

/* ===== /send and /upload and /ping and /info handlers (kept) ===== */

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
      await bot.sendMessage(chatId, `✅ File uploaded\n${actualDest}\n${size}\n${publicUrl}`);
    } else {
      await bot.sendMessage(chatId, `✅ File uploaded to ${actualDest} (${size})`);
    }
  } catch (e) {
    console.error("send error:", e);
    bot.sendMessage(chatId, `❌ Error: ${e.message || e}`);
  }
});

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
    bot.sendMessage(chatId, `✅ Uploaded\nBucket: ${data.bucket}\nPath: ${data.path}\nSize: ${size}`);
  } catch (e) {
    console.error("upload error:", e);
    bot.sendMessage(chatId, `❌ upload error: ${e.message || e}`);
  }
});

bot.onText(/^\/ping$/i, async (msg) => {
  const sel = await getSelectedDevice(msg.chat.id);
  if (!sel) return;
  const { deviceId, online } = sel;
  try {
    const cmd = await sendCommand(deviceId, "ping");
    const timeout = online ? 20_000 : SEVEN_DAYS_MS;
    if (!online) await bot.sendMessage(msg.chat.id, `⚠️ Device offline — ping queued. I will wait for result (up to 7 days).`);

    const res = await waitForResultRealtime(cmd.id, timeout);
    const payload = unwrapResult(res) ?? {};
    const ts = payload.timestamp || payload.ts || Date.now();
    bot.sendMessage(msg.chat.id, `🏓 Pong\n⏱️ ${ts}`);
  } catch (e) {
    console.error("ping error:", e);
    bot.sendMessage(msg.chat.id, `❌ Ping failed: ${e.message || e}`);
  }
});

bot.onText(/^\/info$/i, async (msg) => {
  const sel = await getSelectedDevice(msg.chat.id);
  if (!sel) return;
  const { deviceId, online } = sel;
  try {
    const cmd = await sendCommand(deviceId, "device_info");
    const timeout = online ? 20_000 : SEVEN_DAYS_MS;
    if (!online) await bot.sendMessage(msg.chat.id, "⚠️ Device offline — info command queued. Waiting for response...");
    const res = await waitForResultRealtime(cmd.id, timeout);
    const payload = unwrapResult(res) ?? {};
    const st = chatState.get(msg.chat.id);
    if (payload.cwd && st) st.cwd = payload.cwd;
    const text = formatInfo(payload, deviceId) || "No info.";
    for (const chunk of chunkMessage(text)) {
      await bot.sendMessage(msg.chat.id, chunk);
    }
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ info failed: ${e.message || e}`);
  }
});

/* ===========================
   Central callback handler (auto-browse on device select)
   =========================== */
bot.on("callback_query", async (q) => {
  try {
    const data = q.data || "";
    const chatId = q.message?.chat?.id ?? q.from?.id;
    if (!chatId) {
      try { await bot.answerCallbackQuery(q.id, { text: "❌ Unable to determine chat", show_alert: true }); } catch (_) {}
      return;
    }

    // ack
    try { await bot.answerCallbackQuery(q.id); } catch (_) {}

    // device_select - AUTOMATICALLY EXECUTE /ls
    if (data.startsWith("device_select:")) {
      const deviceId = data.split(":")[1];
      const v = await validateDevice(deviceId);
      if (!v.ok) {
        await bot.sendMessage(chatId, `❌ Device invalid: ${v.error}`);
        return;
      }
      
      // Set device and immediately browse
      chatState.set(chatId, { deviceId, cwd: "/storage/emulated/0/" });
      const st = chatState.get(chatId);
      
      await bot.sendMessage(chatId, `Device selected: ${deviceId}\nLoading files...`);
      
      try {
        const cmd = await sendCommand(deviceId, "list_files", { path: st.cwd, limit: 500 });
        const timeout = v.online ? 30_000 : SEVEN_DAYS_MS;
        if (!v.online) await bot.sendMessage(chatId, `⚠️ Device offline — queued command. I will wait (up to 7 days).`);
        const res = await waitForResultRealtime(cmd.id, timeout);
        const payload = unwrapResult(res) ?? {};
        if (payload.cwd) st.cwd = payload.cwd;
        await sendListingWithButtonsCompact(chatId, deviceId, st, payload);
      } catch (e) {
        console.error("Auto-browse error:", e);
        await bot.sendMessage(chatId, `❌ Browse failed: ${e.message || e}`);
      }
      return;
    }

    // menu:
    if (data.startsWith("menu:")) {
      const m = data.split(":")[1];
      switch (m) {
        case "devices":
          // reuse /devices logic (will clean previous devices output)
          bot.emit("message", { chat: { id: chatId }, text: "/devices" });
          break;
        case "help":
          await bot.sendMessage(chatId, `Help: use /devices -> pick device -> browse files`);
          break;
        case "commands":
          await bot.sendMessage(chatId, `Use /ls /tree /send /upload /ping /info`);
          break;
        case "stats":
          await bot.sendMessage(chatId, `Chats: ${chatState.size} • Pending: ${pendingSubs.size}`);
          break;
        default:
          await bot.sendMessage(chatId, `Unknown menu: ${m}`);
      }
      return;
    }

    // action:
    if (data.startsWith("action:")) {
      const action = data.split(":")[1];
      const st = chatState.get(chatId);
      if (!st?.deviceId) return bot.answerCallbackQuery(q.id, { text: "❌ No device selected", show_alert: true });

      switch(action) {
        case "browse": {
          await bot.sendMessage(chatId, "📂 Loading...");
          try {
            const v = await validateDevice(st.deviceId);
            const cmd = await sendCommand(st.deviceId, "list_files", { path: st.cwd, limit: 500 });
            const timeout = v.online ? 30_000 : SEVEN_DAYS_MS;
            if (!v.online) await bot.sendMessage(chatId, `⚠️ Device offline — queued command. I will wait (up to 7 days).`);
            const res = await waitForResultRealtime(cmd.id, timeout);
            const payload = unwrapResult(res) ?? {};
            if (payload.cwd) st.cwd = payload.cwd;
            await sendListingWithButtonsCompact(chatId, st.deviceId, st, payload);
          } catch (e) {
            console.error("browse action error:", e);
            await bot.sendMessage(chatId, `❌ Browse failed: ${e.message || e}`);
          }
          break;
        }
        case "info": {
          await bot.sendMessage(chatId, "📊 Fetching...");
          try {
            const v = await validateDevice(st.deviceId);
            const cmd = await sendCommand(st.deviceId, "device_info");
            const timeout = v.online ? 20_000 : SEVEN_DAYS_MS;
            const res = await waitForResultRealtime(cmd.id, timeout);
            const payload = unwrapResult(res) ?? {};
            if (payload.cwd) st.cwd = payload.cwd;
            const infoText = formatInfo(payload, st.deviceId) || "No info.";
            await bot.sendMessage(chatId, infoText);
          } catch (e) {
            await bot.sendMessage(chatId, `❌ Info failed: ${e.message || e}`);
          }
          break;
        }
        case "ping": {
          await bot.sendMessage(chatId, "🏓 Pinging...");
          try {
            const cmd = await sendCommand(st.deviceId, "ping");
            const v = await validateDevice(st.deviceId);
            const timeout = v.online ? 20_000 : SEVEN_DAYS_MS;
            const res = await waitForResultRealtime(cmd.id, timeout);
            const payload = unwrapResult(res) ?? {};
            const ts = payload.timestamp || payload.ts || Date.now();
            await bot.sendMessage(chatId, `🏓 Pong: ${ts}`);
          } catch (e) {
            await bot.sendMessage(chatId, `❌ Ping failed: ${e.message || e}`);
          }
          break;
        }
        case "pwd": {
          await bot.sendMessage(chatId, `${st.cwd}`);
          break;
        }
        default:
          await bot.sendMessage(chatId, `Unknown action: ${action}`);
      }
      return;
    }

    // nav:up or nav:cd:<token>
    if (data.startsWith("nav:")) {
      const parts = data.split(":");
      const navAction = parts[1];
      if (navAction === "up") {
        const st = chatState.get(chatId);
        if (!st) return bot.answerCallbackQuery(q.id, { text: "❌ No session", show_alert: true });
        const parts2 = st.cwd.split("/").filter(Boolean);
        parts2.pop();
        st.cwd = "/" + parts2.join("/") + (parts2.length ? "/" : "");
        await bot.sendMessage(chatId, `Moved to: ${st.cwd}`);
        try {
          const v = await validateDevice(st.deviceId);
          const cmd = await sendCommand(st.deviceId, "list_files", { path: st.cwd, limit: 500 });
          const timeout = v.online ? 30_000 : SEVEN_DAYS_MS;
          const res = await waitForResultRealtime(cmd.id, timeout);
          const payload = unwrapResult(res) ?? {};
          if (payload.cwd) st.cwd = payload.cwd;
          await sendListingWithButtonsCompact(chatId, st.deviceId, st, payload);
        } catch (e) {
          await bot.sendMessage(chatId, `❌ Refresh failed: ${e.message || e}`);
        }
        return;
      }
      if (navAction === "cd") {
        const token = parts[2];
        const entry = dirActions.get(token);
        if (!entry) {
          await bot.answerCallbackQuery(q.id, { text: "⚠️ Directory token expired or invalid", show_alert: true });
          return;
        }
        const st = chatState.get(chatId);
        if (!st) return await bot.answerCallbackQuery(q.id, { text: "❌ No session", show_alert: true });
        st.cwd = entry.path.endsWith("/") ? entry.path : entry.path + "/";
        await bot.sendMessage(chatId, `Entered: ${st.cwd}`);
        try {
          const v = await validateDevice(st.deviceId);
          const cmd = await sendCommand(st.deviceId, "list_files", { path: st.cwd, limit: 500 });
          const timeout = v.online ? 30_000 : SEVEN_DAYS_MS;
          const res = await waitForResultRealtime(cmd.id, timeout);
          const payload = unwrapResult(res) ?? {};
          if (payload.cwd) st.cwd = payload.cwd;
          await sendListingWithButtonsCompact(chatId, st.deviceId, st, payload);
        } catch (e) {
          await bot.sendMessage(chatId, `❌ Browse failed: ${e.message || e}`);
        }
        return;
      }
    }

    // upload:<token> -> single-click upload (immediate)
    if (data.startsWith("upload:")) {
      const token = data.split(":")[1];
      const info = fileActions.get(token);
      if (!info) {
        await bot.answerCallbackQuery(q.id, { text: "⚠️ Action expired or invalid", show_alert: true });
        return;
      }

      await bot.answerCallbackQuery(q.id, { text: `📤 Uploading ${info.name}...` });
      await bot.sendMessage(info.chatId, `📤 Upload started: ${info.name}`);

      try {
        const cmd = await sendCommand(info.deviceId, "upload_file", { path: info.path });
        const v = await validateDevice(info.deviceId);
        const isOnline = v.ok ? !!v.online : true;
        const timeout = isOnline ? 120_000 : SEVEN_DAYS_MS;
        if (!isOnline) await bot.sendMessage(info.chatId, `⚠️ Device offline — upload queued. I will wait (up to 7 days).`);

        const res = await waitForResultRealtime(cmd.id, timeout);
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
            await bot.sendMessage(info.chatId, `✅ Uploaded: ${info.name}\n${actualDest}\n${sizeText ? `${sizeText}\n` : ""}${publicUrl}`);
          } else {
            await bot.sendMessage(info.chatId, `✅ Uploaded: ${info.name}\n${actualDest}\n${sizeText ? `${sizeText}` : ""}`);
          }
        }
      } catch (err) {
        await bot.sendMessage(info.chatId, `❌ Upload failed / timed out: ${err?.message || err}`);
      } finally {
        fileActions.delete(token);
      }
      return;
    }

    // upload_all:<gtoken>
    if (data.startsWith("upload_all:")) {
      const gtoken = data.split(":")[1];
      const list = groupActions.get(gtoken);
      if (!list || !Array.isArray(list) || list.length === 0) {
        await bot.answerCallbackQuery(q.id, { text: "⚠️ Group expired or invalid", show_alert: true });
        return;
      }

      await bot.answerCallbackQuery(q.id, { text: `📤 Uploading ${list.length} files...` });
      const info = list[0];
      const chatIdLocal = info.chatId;
      await bot.sendMessage(chatIdLocal, `📤 Upload-all started for ${list.length} files...`);

      let idx = 0;
      for (const item of list) {
        idx++;
        try { await bot.sendMessage(chatIdLocal, `⏳ (${idx}/${list.length}) Uploading ${item.name} ...`); } catch (_) {}
        try {
          const cmd = await sendCommand(item.deviceId, "upload_file", { path: item.path });
          const v = await validateDevice(item.deviceId);
          const isOnline = v.ok ? !!v.online : true;
          const timeout = isOnline ? 120_000 : SEVEN_DAYS_MS;
          if (!isOnline) await bot.sendMessage(chatIdLocal, `⚠️ Device offline — ${item.name} queued. I will wait (up to 7 days).`);

          let res;
          try {
            res = await waitForResultRealtime(cmd.id, timeout);
          } catch (err) {
            await bot.sendMessage(chatIdLocal, `❌ (${idx}/${list.length}) ${item.name} failed / timed out: ${err?.message || err}`);
            continue;
          }

          const payload = unwrapResult(res) ?? {};
          const success = payload.success === true || payload.publicUrl || payload.public_url || payload.url;
          if (!success) {
            const errMsg = payload.error || payload.detail || JSON.stringify(payload);
            await bot.sendMessage(chatIdLocal, `❌ (${idx}/${list.length}) ${item.name} failed: ${errMsg}`);
          } else {
            const publicUrl = payload.publicUrl || payload.public_url || payload.url;
            const actualDest = payload.path || payload.dest || `${item.deviceId}/${item.name}`;
            const sizeText = payload.size ? formatBytes(payload.size) : "";
            if (publicUrl) {
              await bot.sendMessage(chatIdLocal, `✅ (${idx}/${list.length}) Uploaded: ${item.name}\n${actualDest}\n${sizeText ? `${sizeText}\n` : ""}${publicUrl}`);
            } else {
              await bot.sendMessage(chatIdLocal, `✅ (${idx}/${list.length}) Uploaded: ${item.name}\n${actualDest}\n${sizeText ? `${sizeText}` : ""}`);
            }
          }
        } catch (err) {
          console.error("upload_all item error:", err);
          try { await bot.sendMessage(chatIdLocal, `❌ (${idx}/${list.length}) ${item.name} error: ${err?.message || err}`); } catch (_) {}
        }
      }

      try { await bot.sendMessage(chatIdLocal, `🏁 Upload-all finished for ${list.length} files.`); } catch (_) {}
      groupActions.delete(gtoken);
      return;
    }

    // refresh_devices
    if (data === "refresh_devices") {
      await bot.answerCallbackQuery(q.id, { text: "🔄 Refreshing..." });
      bot.emit("message", { chat: { id: chatId }, text: "/devices" });
      return;
    }

    // fallback
    await bot.sendMessage(chatId, `Unknown callback: ${data}`);
  } catch (e) {
    console.error("callback_query handler error:", e);
    try { await bot.answerCallbackQuery(q.id, { text: `❌ Handler error`, show_alert: true }); } catch (_) {}
  }
});

/* ===========================
   Webhook + server
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