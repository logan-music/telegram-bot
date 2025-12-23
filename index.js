// index.js
import TelegramBot from "node-telegram-bot-api";
import { createClient } from "@supabase/supabase-js";

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN env var");
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_KEY env vars");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  // optional: set fetch or global options here
});

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.on("polling_error", (err) => {
  console.error("Polling error:", err);
});

// /start
bot.onText(/^\/start$/, async (msg) => {
  try {
    await bot.sendMessage(
      msg.chat.id,
      "Bot iko online ✅\nUse /devices to list registered devices."
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
    "/devices - list registered devices (id and online status)",
  ].join("\n");
  await bot.sendMessage(msg.chat.id, text);
});

// /devices
bot.onText(/^\/devices$/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    // read devices from supabase
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

    // Format message
    const lines = data.map((d) => {
      const id = d.id ?? "<unknown-id>";
      const name = d.display_name ?? id;
      const online = d.online === true || d.online === "true";
      const status = online ? "online ✅" : "offline ❌";
      return `• ${name} — ${status} (id: ${id})`;
    });

    // If long, split into multiple messages
    const msgText = `Devices (${data.length}):\n` + lines.join("\n");
    await bot.sendMessage(chatId, msgText);
  } catch (e) {
    console.error("Unhandled /devices error:", e);
    await bot.sendMessage(chatId, `Unexpected error: ${e.message || e}`);
  }
});

// Optional: graceful shutdown hooks (Render restarts)
const shutdown = async () => {
  console.log("Shutting down bot...");
  try {
    await bot.stopPolling();
  } catch (_) {}
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("Telegram bot started (polling).");
