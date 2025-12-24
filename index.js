// index.js
import http from "http";
import TelegramBot from "node-telegram-bot-api";
import { createClient } from "@supabase/supabase-js";

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const PORT = parseInt(process.env.PORT || "3000", 10);

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN env var");
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_KEY env vars");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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
    await bot.sendMessage(chatId, `Unexpected error: ${e.message || e}`);
  }
});

// Simple HTTP server so Render detects a port (health check + simple root)
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

// graceful shutdown
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
