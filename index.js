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
if (!SUPABASE_SERVICE_KEY) throw new Error("BOT MUST USE SERVICE ROLE KEY");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

/* ---------------------------
   In-memory chat state
   chatId -> { deviceId, cwd }
--------------------------- */
const chatState = new Map();

/* ---------------------------
   Helpers
--------------------------- */
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

async function waitForResult(cmdId, timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { data } = await supabase
      .from("device_commands")
      .select("status, result")
      .eq("id", cmdId)
      .maybeSingle();

    if (data?.status === "done" || data?.status === "failed") {
      return data;
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error("timeout_waiting_result");
}

/* ---------------------------
   BOT COMMANDS
--------------------------- */

bot.onText(/^\/start$/, msg => {
  bot.sendMessage(
    msg.chat.id,
    "✅ Bot online\n/use <device_id>\n/devices\n/help"
  );
});

bot.onText(/^\/devices$/, async msg => {
  const { data } = await supabase
    .from("devices")
    .select("id, online")
    .order("last_seen", { ascending: false });

  if (!data?.length) {
    bot.sendMessage(msg.chat.id, "No devices.");
    return;
  }

  const text = data
    .map(d => `• ${d.id} — ${d.online ? "online ✅" : "offline ❌"}`)
    .join("\n");

  bot.sendMessage(msg.chat.id, text);
});

bot.onText(/^\/use\s+(.+)$/i, async (msg, m) => {
  const deviceId = m[1].trim();
  const v = await validateDevice(deviceId);
  if (!v.ok) {
    bot.sendMessage(msg.chat.id, `❌ ${v.error}`);
    return;
  }
  chatState.set(msg.chat.id, {
    deviceId,
    cwd: "/storage/emulated/0/",
  });
  bot.sendMessage(msg.chat.id, `✅ Using device ${deviceId}`);
});

bot.onText(/^\/cd\s+(.+)$/i, (msg, m) => {
  const st = chatState.get(msg.chat.id);
  if (!st) {
    bot.sendMessage(msg.chat.id, "❌ Select device first");
    return;
  }
  st.cwd = m[1].trim();
  bot.sendMessage(msg.chat.id, `📂 cwd = ${st.cwd}`);
});

bot.onText(/^\/ls(?:\s+(.*))?$/i, async (msg, m) => {
  const deviceId = await getSelectedDevice(msg.chat.id);
  if (!deviceId) return;

  const st = chatState.get(msg.chat.id);
  const path = m[1]?.trim() || st.cwd;

  const cmd = await sendCommand(deviceId, "list_files", { path });
  const res = await waitForResult(cmd.id);

  bot.sendMessage(msg.chat.id, "```json\n" + JSON.stringify(res.result, null, 2) + "\n```", {
    parse_mode: "Markdown",
  });
});

/* ---------------------------
   ✅ UPLOAD (REAL FILE)
--------------------------- */
bot.onText(/^\/upload\s+(.+)$/i, async (msg, m) => {
  const chatId = msg.chat.id;
  const deviceId = await getSelectedDevice(chatId);
  if (!deviceId) return;

  const target = m[1].trim();
  bot.sendMessage(chatId, "📦 Preparing upload…");

  // STEP 1: prepare upload on device
  const prepCmd = await sendCommand(deviceId, "prepare_upload", {
    filename: target,
  });

  const prepRes = await waitForResult(prepCmd.id);
  if (prepRes.status !== "done") {
    bot.sendMessage(chatId, "❌ prepare_upload failed");
    return;
  }

  // STEP 2: call edge function (ACTUAL UPLOAD)
  const payload = {
    device_id: deviceId,
    source: prepRes.result,
    bucket: "agent-uploads",
    dest: `${deviceId}/${Date.now()}_${prepRes.result?.name || "file"}`,
  };

  bot.sendMessage(chatId, "☁️ Uploading to Supabase Storage…");

  const { data, error } = await supabase.functions.invoke("upload-file", {
    body: payload,
  });

  if (error) {
    bot.sendMessage(chatId, `❌ Upload failed: ${error.message}`);
    return;
  }

  bot.sendMessage(
    chatId,
    `✅ Upload complete\nBucket: ${data.bucket}\nPath: ${data.path}`
  );
});

/* ---------------------------
   BASIC COMMANDS
--------------------------- */
bot.onText(/^\/ping$/, async msg => {
  const deviceId = await getSelectedDevice(msg.chat.id);
  if (!deviceId) return;

  const cmd = await sendCommand(deviceId, "ping");
  const res = await waitForResult(cmd.id);
  bot.sendMessage(msg.chat.id, JSON.stringify(res.result, null, 2));
});

bot.onText(/^\/info$/, async msg => {
  const deviceId = await getSelectedDevice(msg.chat.id);
  if (!deviceId) return;

  const cmd = await sendCommand(deviceId, "device_info");
  const res = await waitForResult(cmd.id);
  bot.sendMessage(msg.chat.id, JSON.stringify(res.result, null, 2));
});

/* ---------------------------
   HTTP HEALTH
--------------------------- */
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("ok");
}).listen(PORT);

console.log("🚀 Telegram bot running");
