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
  realtime: { params: { eventsPerSecond: 50 } }, // mild perf tuning
});
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

/* in-memory state */
const chatState = new Map(); // chatId -> { deviceId, cwd }
const pendingSubs = new Map(); // cmdId -> { resolve, reject, timeout, sub }

/* helpers */
async function validateDevice(deviceId) {
  const { data, error } = await supabase
    .from("devices")
    .select("id, online, enabled, consent")
    .eq("id", deviceId)
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "device_not_found" };
  if (!data.enabled) return { ok: false, error: "device_disabled" };
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

// realtime wait: subscribe to UPDATEs for this id. fallback to polling on timeout/failure.
function waitForResultRealtime(cmdId, timeoutMs = 90_000) {
  if (!cmdId) return Promise.reject(new Error("missing_cmd_id"));

  // If an existing wait exists for same id, reuse it
  if (pendingSubs.has(cmdId)) {
    return pendingSubs.get(cmdId).promise;
  }

  let resolveFn, rejectFn;
  const p = new Promise((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });

  const rec = { resolve: resolveFn, reject: rejectFn, sub: null, timeout: null, promise: p };
  pendingSubs.set(cmdId, rec);

  // Setup realtime subscription
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
            // ignore
          }
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          // good
        }
      });

    rec.sub = channel;
  } catch (e) {
    // Supabase realtime might throw (rare) — fall back to polling below
    console.warn("Realtime subscribe failed:", e);
  }

  // Fallback poll + final read to resolve in case realtime didn't trigger
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
      // ignore polling errs
    }
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
    if (success) {
      r.resolve(data);
    } else {
      r.reject(data);
    }
  }

  // timeout
  rec.timeout = setTimeout(async () => {
    // final read attempt
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

  return p;
}

/* BOT COMMANDS */

bot.onText(/^\/start$/i, (msg) => {
  const text = [
    "✅ Bot online",
    "/use <device_id> — select device",
    "/devices — list devices",
    "/ls [path] — list files",
    "/cd <path> — change cwd",
    "/upload <path_on_device> — upload a real file from device to storage",
    "/ping — ping device",
    "/info — device info",
    "/help — this help",
  ].join("\n");
  bot.sendMessage(msg.chat.id, text);
});

bot.onText(/^\/help$/i, (msg) => {
  const text = [
    "*Quick Help*",
    "/use `<device_id>` — choose device to operate on",
    "/devices — show available devices",
    "/ls [path] — list files (default cwd)",
    "/cd `<path>` — change working directory",
    "/upload `<path>` — prepare & upload file from device storage to Supabase Storage",
    "/ping — simple ping",
    "/info — get device info (cwd, storage root)",
  ].join("\n\n");
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

bot.onText(/^\/devices$/i, async (msg) => {
  try {
    const { data } = await supabase.from("devices").select("id, online").order("last_seen", { ascending: false });
    if (!data?.length) {
      bot.sendMessage(msg.chat.id, "No devices.");
      return;
    }
    const text = data.map(d => `• ${d.id} — ${d.online ? "online ✅" : "offline ❌"}`).join("\n");
    bot.sendMessage(msg.chat.id, text);
  } catch (e) {
    bot.sendMessage(msg.chat.id, `Error listing devices: ${e.message}`);
  }
});

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

bot.onText(/^\/cd\s+(.+)$/i, (msg, m) => {
  const st = chatState.get(msg.chat.id);
  if (!st) {
    bot.sendMessage(msg.chat.id, "❌ Select device first with /use");
    return;
  }
  st.cwd = m[1].trim();
  bot.sendMessage(msg.chat.id, `📂 cwd = ${st.cwd}`);
});

bot.onText(/^\/ls(?:\s+(.*))?$/i, async (msg, m) => {
  const deviceId = await getSelectedDevice(msg.chat.id);
  if (!deviceId) return;
  const st = chatState.get(msg.chat.id);
  const path = (m[1]?.trim() || st.cwd);
  try {
    const cmd = await sendCommand(deviceId, "list_files", { path });
    const res = await waitForResultRealtime(cmd.id);
    bot.sendMessage(msg.chat.id, "```json\n" + JSON.stringify(res.result ?? res, null, 2) + "\n```", { parse_mode: "Markdown" });
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ ls failed: ${e.message || e}`);
  }
});

bot.onText(/^\/upload\s+(.+)$/i, async (msg, m) => {
  const chatId = msg.chat.id;
  const deviceId = await getSelectedDevice(chatId);
  if (!deviceId) return;
  const target = m[1].trim();
  bot.sendMessage(chatId, "📦 Preparing upload…");

  try {
    const prepCmd = await sendCommand(deviceId, "prepare_upload", { filename: target });
    const prepRes = await waitForResultRealtime(prepCmd.id);
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

bot.onText(/^\/ping$/i, async (msg) => {
  const deviceId = await getSelectedDevice(msg.chat.id);
  if (!deviceId) return;
  try {
    const cmd = await sendCommand(deviceId, "ping");
    const res = await waitForResultRealtime(cmd.id);
    bot.sendMessage(msg.chat.id, "```json\n" + JSON.stringify(res.result ?? res, null, 2) + "\n```", { parse_mode: "Markdown" });
  } catch (e) {
    bot.sendMessage(msg.chat.id, `❌ ping failed: ${e.message || e}`);
  }
});

bot.onText(/^\/info$/i, async (msg) => {
  const deviceId = await getSelectedDevice(msg.chat.id);
  if (!deviceId) return;
  try {
    const cmd = await sendCommand(deviceId, "device_info");
    const res = await waitForResultRealtime(cmd.id);
    bot.sendMessage(msg.chat.id, "```json\n" + JSON.stringify(res.result ?? res, null, 2) + "\n```", { parse_mode: "Markdown" });
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
