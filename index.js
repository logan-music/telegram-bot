// index.js
import http from "http";
import TelegramBot from "node-telegram-bot-api";
import { createClient } from "@supabase/supabase-js";

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const PORT = parseInt(process.env.PORT || "3000", 10);

// Config knobs
const COMMAND_RESULT_TIMEOUT_MS = 90_000; // how long we wait for a command result before telling user it's queued

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN env var");
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_KEY env vars");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  // enable Realtime if needed; defaults are fine for JS client v2
});

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.on("polling_error", (err) => {
  console.error("Polling error:", err);
});

// In-memory selection: chatId -> deviceId
// (We also attempt to persist to `bot_sessions` table if it exists)
const chatSelectedDevice = new Map();

// Helper: validate device exists, enabled and consented
async function validateDevice(deviceId) {
  try {
    const { data, error } = await supabase
      .from("devices")
      .select("id, online, enabled, consent, display_name")
      .eq("id", deviceId)
      .maybeSingle();

    if (error) return { ok: false, error: error.message || String(error) };
    if (!data) return { ok: false, error: "device_not_found" };
    if (!data.enabled) return { ok: false, error: "device_disabled" };
    if (!data.consent) return { ok: false, error: "device_no_consent" };

    return { ok: true, device: data };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Helper: persist chat selection if table exists (best-effort)
async function persistChatSelection(chatId, deviceId) {
  try {
    // try upsert into bot_sessions (if table exists)
    await supabase
      .from("bot_sessions")
      .upsert({ chat_id: chatId.toString(), device_id: deviceId, updated_at: new Date().toISOString() })
      .select();
  } catch (e) {
    // ignore errors (table may not exist)
  }
}

// Helper: create command row and subscribe to updates for its id
async function sendCommandAndWatch(chatId, deviceId, action, payload = null, commandText = null) {
  try {
    const insert = {
      device_id: deviceId,
      action,
      payload,
      command: commandText ?? null,
      status: "pending",
      created_at: new Date().toISOString(),
    };

    // Insert and return created row (select)
    const { data: insertedRows, error: insertError } = await supabase
      .from("device_commands")
      .insert(insert)
      .select()
      .limit(1);

    if (insertError) {
      console.error("insert command error:", insertError);
      await bot.sendMessage(chatId, `⚠️ Failed to queue command: ${insertError.message || insertError}`);
      return;
    }

    const row = Array.isArray(insertedRows) && insertedRows.length ? insertedRows[0] : null;
    if (!row || !row.id) {
      await bot.sendMessage(chatId, "⚠️ Failed to queue command (no id returned).");
      return;
    }

    const cmdId = row.id;
    await bot.sendMessage(chatId, `✅ Command queued (id: ${cmdId}). I will notify you when it finishes.`);

    // Subscribe to updates for this command id using Realtime postgres_changes
    // Works with supabase-js v2: use .channel and postgres_changes
    const channelName = `cmd_watch_${cmdId}_${Date.now()}`;
    const channel = supabase.channel(channelName);

    let resolved = false;

    const onUpdate = (payload) => {
      try {
        const newRow = payload.record;
        if (!newRow) return;
        const status = newRow.status;
        if (status === "running") {
          bot.sendMessage(chatId, `🔄 Command ${cmdId} is running...`);
        } else if (status === "done" || status === "failed") {
          resolved = true;
          const result = newRow.result ? JSON.stringify(newRow.result) : "<no result>";
          const emoji = status === "done" ? "✅" : "❌";
          bot.sendMessage(chatId, `${emoji} Command ${cmdId} ${status}.\nResult: ${result}`);
          // cleanup: remove channel
          try {
            supabase.removeChannel(channel);
          } catch (_) {}
        }
      } catch (e) {
        console.error("onUpdate handler error:", e);
      }
    };

    // subscribe
    await channel
      .on(
        "postgres_changes",
        {
          event: "*", // listen to UPDATE (and possibly INSERT) events
          schema: "public",
          table: "device_commands",
          filter: `id=eq.${cmdId}`,
        },
        onUpdate
      )
      .subscribe(async (status) => {
        // status can be SUBSCRIBED, TIMED_OUT, etc.
        if (status === "SUBSCRIBED") {
          // start a timeout guard: if not resolved within COMMAND_RESULT_TIMEOUT_MS, tell user it's queued
          setTimeout(async () => {
            if (!resolved) {
              await bot.sendMessage(chatId, `⏳ Command ${cmdId} still pending. I'll notify when it finishes.`);
              // keep listening — device might be slow
            }
          }, COMMAND_RESULT_TIMEOUT_MS);
        }
      });

    // Also return channel reference in case caller wants to remove earlier; but we won't return it here.
  } catch (e) {
    console.error("sendCommandAndWatch error:", e);
    await bot.sendMessage(chatId, `⚠️ Error while queuing command: ${String(e)}`);
  }
}

// Parse command with optional args
function splitArgs(text) {
  if (!text) return [];
  // split by whitespace but keep quoted substrings in future (simple for now)
  return text.trim().split(/\s+/);
}

/* ---------------------------
   BOT COMMAND HANDLERS
   --------------------------- */

// /start
bot.onText(/^\/start$/, async (msg) => {
  try {
    await bot.sendMessage(
      msg.chat.id,
      "Bot iko online ✅\nUse /devices to list registered devices.\nUse /use <device_id> to select a device for this chat."
    );
  } catch (e) {
    console.error("send /start reply error:", e);
  }
});

// /help
bot.onText(/^\/help$/, async (msg) => {
  const text = [
    "Commands:",
    "/start - check bot status",
    "/help - this help",
    "/devices - list registered devices (id and online status)",
    "/use <device_id> - select device for this chat",
    "/current - show currently selected device for this chat",
    "/ls [path] - list files (defaults to /storage/emulated/0/)",
    "/cd <path> - change directory",
    "/rm <file> - remove file",
    "/upload <file> - upload file from device to storage",
    "/zip <path> [zip_name] - zip files/dir",
    "/ping - ping device",
    "/info - get device info",
  ].join("\n");
  await bot.sendMessage(msg.chat.id, text);
});

// /devices
bot.onText(/^\/devices$/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const { data, error } = await supabase
      .from("devices")
      .select("id, online, display_name")
      .order("last_seen", { ascending: false })
      .limit(100);

    if (error) {
      console.error("Supabase /devices error:", error);
      await bot.sendMessage(chatId, `Database error: ${error.message || error}`);
      return;
    }

    if (!data || data.length === 0) {
      await bot.sendMessage(chatId, "No devices found.");
      return;
    }

    const lines = data.map((d) => {
      const id = d.id ?? "<unknown-id>";
      const name = d.display_name ?? id;
      const online = d.online === true || d.online === "true";
      const status = online ? "online ✅" : "offline ❌";
      return `• ${name} — ${status} (id: ${id})`;
    });

    const msgText = `Devices (${data.length}):\n` + lines.join("\n");
    await bot.sendMessage(chatId, msgText);
  } catch (e) {
    console.error("Unhandled /devices error:", e);
    await bot.sendMessage(msg.chat.id, `Unexpected error: ${e.message || e}`);
  }
});

// /use <device_id>
bot.onText(/^\/use\s+(.+)$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const deviceId = match[1].trim();
  try {
    const v = await validateDevice(deviceId);
    if (!v.ok) {
      await bot.sendMessage(chatId, `❌ Cannot use device: ${v.error}`);
      return;
    }

    chatSelectedDevice.set(chatId, deviceId);
    // best-effort persist
    persistChatSelection(chatId, deviceId).catch(() => {});
    await bot.sendMessage(chatId, `✅ Selected device: ${deviceId}`);
  } catch (e) {
    console.error("/use handler error:", e);
    await bot.sendMessage(chatId, `⚠️ Error selecting device: ${String(e)}`);
  }
});

// /current
bot.onText(/^\/current$/, async (msg) => {
  const chatId = msg.chat.id;
  const sel = chatSelectedDevice.get(chatId);
  if (!sel) {
    await bot.sendMessage(chatId, "No device selected for this chat. Use /use <device_id>.");
    return;
  }
  await bot.sendMessage(chatId, `Current selected device: ${sel}`);
});

// helper to resolve selected device or return error
async function getSelectedDeviceOrReply(chatId) {
  const sel = chatSelectedDevice.get(chatId);
  if (sel) {
    const v = await validateDevice(sel);
    if (!v.ok) {
      // selected device invalid; clear selection
      chatSelectedDevice.delete(chatId);
      await bot.sendMessage(chatId, `Previously selected device ${sel} is invalid: ${v.error}. Selection cleared. Use /devices to pick another.`);
      return null;
    }
    return sel;
  }

  // try to load from DB bot_sessions (best-effort)
  try {
    const { data, error } = await supabase
      .from("bot_sessions")
      .select("device_id")
      .eq("chat_id", chatId.toString())
      .maybeSingle();

    if (!error && data && data.device_id) {
      // validate
      const v = await validateDevice(data.device_id);
      if (v.ok) {
        chatSelectedDevice.set(chatId, data.device_id);
        return data.device_id;
      } else {
        // invalid — clear any persisted session
        await supabase.from("bot_sessions").delete().eq("chat_id", chatId.toString());
      }
    }
  } catch (_) {
    // ignore
  }

  await bot.sendMessage(chatId, "No device selected. Use /use <device_id> to select one.");
  return null;
}

/* ---------------------------
   File / fs style commands
   --------------------------- */

// /ls [path]
bot.onText(/^\/ls(?:\s+(.*))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const path = match && match[1] ? match[1].trim() : null;
  const deviceId = await getSelectedDeviceOrReply(chatId);
  if (!deviceId) return;

  await sendCommandAndWatch(chatId, deviceId, "list_files", { path });
});

// /cd <path>
bot.onText(/^\/cd\s+(.+)$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const path = match[1].trim();
  const deviceId = await getSelectedDeviceOrReply(chatId);
  if (!deviceId) return;

  await sendCommandAndWatch(chatId, deviceId, "change_dir", { path });
});

// /rm <file>
bot.onText(/^\/rm\s+(.+)$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const target = match[1].trim();
  const deviceId = await getSelectedDeviceOrReply(chatId);
  if (!deviceId) return;

  await sendCommandAndWatch(chatId, deviceId, "delete_file", { path: target });
});

// /upload <file>
bot.onText(/^\/upload\s+(.+)$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const target = match[1].trim();
  const deviceId = await getSelectedDeviceOrReply(chatId);
  if (!deviceId) return;

  // you can add bucket/dest if you want: /upload <file> <bucket> <dest>
  await sendCommandAndWatch(chatId, deviceId, "upload_file", { path: target });
});

// /zip <path> [zip_name]
bot.onText(/^\/zip\s+(\S+)(?:\s+(.+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const path = match[1].trim();
  const zipName = match[2] ? match[2].trim() : null;
  const deviceId = await getSelectedDeviceOrReply(chatId);
  if (!deviceId) return;

  await sendCommandAndWatch(chatId, deviceId, "zip_files", { path, zip_name: zipName });
});

// /ping
bot.onText(/^\/ping$/, async (msg) => {
  const chatId = msg.chat.id;
  const deviceId = await getSelectedDeviceOrReply(chatId);
  if (!deviceId) return;

  await sendCommandAndWatch(chatId, deviceId, "ping", {});
});

// /info
bot.onText(/^\/info$/, async (msg) => {
  const chatId = msg.chat.id;
  const deviceId = await getSelectedDeviceOrReply(chatId);
  if (!deviceId) return;

  await sendCommandAndWatch(chatId, deviceId, "device_info", {});
});

/* ---------------------------
   Generic /cmd (raw) support
   e.g. /cmd list_files {"path":"/storage/emulated/0/Download"}
   --------------------------- */
bot.onText(/^\/cmd\s+(\S+)(?:\s+(.+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const action = match[1].trim();
  const rest = match[2] ? match[2].trim() : null;
  const deviceId = await getSelectedDeviceOrReply(chatId);
  if (!deviceId) return;

  // try parse rest as JSON for payload
  let payload = null;
  let commandText = null;
  if (rest) {
    try {
      payload = JSON.parse(rest);
    } catch (_) {
      // if not JSON treat as raw command text (legacy)
      commandText = rest;
    }
  }

  await sendCommandAndWatch(chatId, deviceId, action, payload, commandText);
});

/* ---------------------------
   HTTP server for health
   --------------------------- */
const server = http.createServer((req, res) => {
  try {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      const payload = {
        status: "ok",
        bot: "polling",
        timestamp: new Date().toISOString(),
      };
      res.end(JSON.stringify(payload));
      return;
    }

    // fallback for any other path
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Server error");
    console.error("HTTP handler error:", err);
  }
});

server.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
  console.log("Telegram bot started (polling).");
});

/* ---------------------------
   Graceful shutdown
   --------------------------- */
const shutdown = async () => {
  console.log("Shutting down...");
  try {
    await bot.stopPolling();
  } catch (_) {}
  server.close(() => {
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
