// index.js - Production-Ready Telegram Bot
// Fully integrated with Flutter app + Supabase edge functions

import http from "http";
import { createClient } from "@supabase/supabase-js";
import TelegramBot from "node-telegram-bot-api";

// ===========================
// ENVIRONMENT CONFIGURATION
// ===========================

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // e.g. https://your-app.onrender.com
const PORT = parseInt(process.env.PORT || "3000", 10);

// Validation
if (!BOT_TOKEN) throw new Error("❌ Missing BOT_TOKEN");
if (!SUPABASE_URL) throw new Error("❌ Missing SUPABASE_URL");
if (!SUPABASE_SERVICE_KEY) throw new Error("❌ Missing SUPABASE_SERVICE_KEY");
if (!WEBHOOK_URL) throw new Error("❌ Missing WEBHOOK_URL (must be HTTPS)");

console.log("✅ Environment configured");
console.log(`📍 Supabase: ${SUPABASE_URL}`);
console.log(`📍 Webhook: ${WEBHOOK_URL}`);

// ===========================
// SUPABASE + BOT INITIALIZATION
// ===========================

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
  realtime: { params: { eventsPerSecond: 50 } },
});

// Webhook mode (no polling to avoid conflicts)
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// ===========================
// IN-MEMORY STATE MANAGEMENT
// ===========================

// chatId -> { deviceId, cwd }
const chatState = new Map();

// cmdId -> { resolve, reject, timeout, sub, promise }
const pendingSubs = new Map();

// ===========================
// HELPER FUNCTIONS
// ===========================

/**
 * Resolve relative path against current working directory
 */
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

/**
 * Chunk long messages for Telegram (4096 char limit)
 */
function chunkMessage(text, max = 3800) {
  const parts = [];
  for (let i = 0; i < text.length; i += max) {
    parts.push(text.slice(i, i + max));
  }
  return parts;
}

/**
 * Safe string conversion
 */
function safeString(s) {
  if (s === null || s === undefined) return "";
  return String(s);
}

/**
 * Format device info for friendly display
 */
function formatInfo(obj) {
  const lines = [];
  if (obj.brand) lines.push(`📱 Brand: ${safeString(obj.brand)}`);
  if (obj.model) lines.push(`📱 Model: ${safeString(obj.model)}`);
  if (obj.device) lines.push(`📱 Device: ${safeString(obj.device)}`);
  if (obj.manufacturer) lines.push(`🏭 Manufacturer: ${safeString(obj.manufacturer)}`);
  if (obj.android_version) {
    lines.push(`🤖 Android: ${safeString(obj.android_version)}${obj.sdk ? ` (SDK ${safeString(obj.sdk)})` : ""}`);
  }
  if (obj.is_physical_device !== undefined) {
    lines.push(`📍 Physical: ${safeString(obj.is_physical_device)}`);
  }
  if (obj.cwd) lines.push(`📂 CWD: ${safeString(obj.cwd)}`);
  if (obj.platform) lines.push(`💻 Platform: ${safeString(obj.platform)}`);
  return lines.join("\n") || "No device info available.";
}

/**
 * Format file listing (folders first, then files, both sorted)
 */
function formatListingPlain(result, requestedPath = "") {
  const lines = [];
  lines.push(`📂 Listing: ${requestedPath || "/"}`);
  
  if (!result) {
    lines.push("(empty)");
    return lines;
  }

  // Modern format: result.entries = [{name, path, type, size}, ...]
  if (Array.isArray(result.entries)) {
    const folders = [];
    const files = [];
    
    for (const e of result.entries) {
      const type = (e.type || "").toString().toLowerCase();
      const name = safeString(e.name || e.path || "");
      if (!name) continue;
      
      const isDir = type === "dir" || type === "directory" || e.is_dir === true;
      const size = e.size ? ` (${formatBytes(e.size)})` : "";
      
      if (isDir) {
        folders.push(`📁 ${name}/`);
      } else {
        files.push(`📄 ${name}${size}`);
      }
    }
    
    folders.sort((a, b) => a.localeCompare(b));
    files.sort((a, b) => a.localeCompare(b));
    
    lines.push(...folders, ...files);
    lines.push(`\n📊 ${folders.length} folders, ${files.length} files`);
    return lines;
  }

  // Legacy format: result.folders && result.files
  if (Array.isArray(result.folders) || Array.isArray(result.files)) {
    const folders = (result.folders || []).map(s => `📁 ${safeString(s)}/`).sort();
    const files = (result.files || []).map(s => `📄 ${safeString(s)}`).sort();
    lines.push(...folders, ...files);
    lines.push(`\n📊 ${folders.length} folders, ${files.length} files`);
    return lines;
  }

  // Fallback: stringify
  try {
    lines.push(JSON.stringify(result, null, 2));
  } catch (e) {
    lines.push(String(result));
  }
  
  return lines;
}

/**
 * Format bytes to human-readable size
 */
function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + " " + sizes[i];
}

// ===========================
// DATABASE HELPERS
// ===========================

/**
 * Validate device exists, is online, and has consent
 */
async function validateDevice(deviceId) {
  try {
    const { data, error } = await supabase
      .from("devices")
      .select("id, online, consent, enabled, last_seen")
      .eq("id", deviceId)
      .maybeSingle();

    if (error) {
      console.error(`Validate device error:`, error);
      return { ok: false, error: error.message };
    }
    if (!data) return { ok: false, error: "device_not_found" };
    if (!data.consent) return { ok: false, error: "device_no_consent" };
    if (!data.enabled) return { ok: false, error: "device_disabled" };
    if (!data.online) return { ok: false, error: "device_offline" };
    
    return { ok: true };
  } catch (e) {
    console.error("Validate device exception:", e);
    return { ok: false, error: String(e) };
  }
}

/**
 * Get selected device for chat, with validation
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
  
  return st.deviceId;
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

// ===========================
// REALTIME RESULT WAITER
// ===========================

/**
 * Wait for command result using realtime subscription + polling fallback
 */
function waitForResultRealtime(cmdId, timeoutMs = 90_000) {
  if (!cmdId) return Promise.reject(new Error("missing_cmd_id"));
  
  // Return existing promise if already waiting
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
    timeout: null, 
    promise,
    startTime: Date.now()
  };
  pendingSubs.set(cmdId, rec);

  // ✅ Realtime subscription
  try {
    const channel = supabase
      .channel(`cmd-${cmdId}`)
      .on(
        "postgres_changes",
        { 
          event: "*", 
          schema: "public", 
          table: "device_commands", 
          filter: `id=eq.${cmdId}` 
        },
        (payload) => {
          try {
            const newRow = payload.new ?? payload.record ?? payload;
            const status = (newRow?.status || "").toString();
            
            if (status === "done" || status === "failed") {
              console.log(`✅ Realtime update: ${cmdId} -> ${status}`);
              cleanup(true, newRow);
            }
          } catch (e) {
            console.error("Realtime handler error:", e);
          }
        }
      )
      .subscribe((status) => {
        console.log(`Realtime subscription status for ${cmdId}: ${status}`);
      });
    
    rec.sub = channel;
  } catch (e) {
    console.warn("Realtime subscribe failed:", e);
  }

  // ✅ Polling fallback (in case realtime doesn't trigger)
  const pollInterval = 1500;
  const poller = setInterval(async () => {
    try {
      const { data } = await supabase
        .from("device_commands")
        .select("status, result")
        .eq("id", cmdId)
        .maybeSingle();
      
      if (data && (data.status === "done" || data.status === "failed")) {
        console.log(`✅ Poll found result: ${cmdId} -> ${data.status}`);
        cleanup(true, data);
      }
    } catch (e) {
      console.error("Polling error:", e);
    }
  }, pollInterval);

  rec.poller = poller;

  // ✅ Cleanup function
  function cleanup(success, data) {
    if (!pendingSubs.has(cmdId)) return;
    
    const r = pendingSubs.get(cmdId);
    const elapsed = Date.now() - r.startTime;
    
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
      console.log(`✅ Command ${cmdId} completed in ${elapsed}ms`);
      r.resolve(data);
    } else {
      console.log(`❌ Command ${cmdId} failed/timeout after ${elapsed}ms`);
      r.reject(data);
    }
  }

  // ✅ Timeout handler
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

/**
 * Unwrap nested result structures from waitForResultRealtime
 */
function unwrapResult(res) {
  if (!res) return null;
  
  // Handle: { result: {...}, status: 'done' }
  let payload = res.result ?? res;
  
  // Handle double-wrapped: { result: { result: {...} } }
  if (payload && payload.result && typeof payload.result === 'object') {
    payload = payload.result;
  }
  
  return payload;
}

// ===========================
// BOT COMMAND HANDLERS
// ===========================

// ✅ /start
bot.onText(/^\/start$/i, async (msg) => {
  const text = [
    "🤖 *Media Agent Bot* - Online",
    "",
    "*Quick Start:*",
    "1️⃣ /use `device_01` — Select device",
    "2️⃣ /ls — List files",
    "3️⃣ /send `<path>` — Upload & get link",
    "",
    "*All Commands:*",
    "/help — View full command list",
    "/devices — Show available devices",
  ].join("\n");
  
  await bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

// ✅ /help
bot.onText(/^\/help$/i, async (msg) => {
  const text = [
    "📋 *Command Reference*",
    "",
    "*Device Management:*",
    "/use `<device_id>` — Select device",
    "/devices — List all devices",
    "/exit — Clear selected device",
    "",
    "*File Operations:*",
    "/ls `[path]` — List files (default: cwd)",
    "/tree `[path]` — Recursive tree view",
    "/cd `<path>` — Change directory",
    "/pwd — Show current directory",
    "",
    "*File Transfer:*",
    "/send `<path>` — Upload file & get public URL",
    "/upload `<path>` — Upload to storage",
    "",
    "*File Management:*",
    "/rm `<path>` — Delete file",
    "/rd `<path>` — Delete directory (recursive)",
    "",
    "*Device Info:*",
    "/ping — Test connection",
    "/info — Show device details",
  ].join("\n");
  
  await bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

// ✅ /devices - Show online/offline status with last seen
bot.onText(/^\/devices$/i, async (msg) => {
  try {
    const { data, error } = await supabase
      .from("devices")
      .select("id, online, last_seen, enabled, consent")
      .order("last_seen", { ascending: false });

    if (error) throw error;

    if (!data?.length) {
      await bot.sendMessage(msg.chat.id, "📱 No devices registered yet.");
      return;
    }

    const now = Date.now();
    const lines = data.map(d => {
      let status = "❌ offline";
      let lastSeen = "";
      
      if (d.online) {
        status = "✅ online";
      } else if (d.last_seen) {
        try {
          const diff = now - new Date(d.last_seen).getTime();
          const sec = Math.floor(diff / 1000);
          
          if (sec < 60) lastSeen = ` (${sec}s ago)`;
          else if (sec < 3600) lastSeen = ` (${Math.floor(sec / 60)}m ago)`;
          else if (sec < 86400) lastSeen = ` (${Math.floor(sec / 3600)}h ago)`;
          else lastSeen = ` (${Math.floor(sec / 86400)}d ago)`;
        } catch (e) {
          console.error("Last seen parse error:", e);
        }
      }
      
      const enabled = d.enabled ? "" : " 🔒";
      const consent = d.consent ? "" : " ⚠️";
      
      return `• \`${d.id}\` — ${status}${lastSeen}${enabled}${consent}`;
    });

    const header = `📱 *Devices (${data.length})*\n`;
    await bot.sendMessage(msg.chat.id, header + lines.join("\n"), { parse_mode: "Markdown" });
  } catch (e) {
    console.error("List devices error:", e);
    await bot.sendMessage(msg.chat.id, `❌ Error: ${e.message || e}`);
  }
});

// ✅ /use <device_id>
bot.onText(/^\/use\s+(.+)$/i, async (msg, m) => {
  const deviceId = m[1].trim();
  const v = await validateDevice(deviceId);
  
  if (!v.ok) {
    await bot.sendMessage(msg.chat.id, `❌ Cannot use device: ${v.error}`);
    return;
  }
  
  chatState.set(msg.chat.id, { 
    deviceId, 
    cwd: "/storage/emulated/0/" 
  });
  
  await bot.sendMessage(msg.chat.id, `✅ Using device: \`${deviceId}\``, { parse_mode: "Markdown" });
});

// ✅ /exit
bot.onText(/^\/exit$/i, async (msg) => {
  chatState.delete(msg.chat.id);
  await bot.sendMessage(msg.chat.id, "✅ Session cleared");
});

// ✅ /cd <path>
bot.onText(/^\/cd\s+(.+)$/i, async (msg, m) => {
  const st = chatState.get(msg.chat.id);
  if (!st) {
    await bot.sendMessage(msg.chat.id, "❌ No device selected. Use /use first.");
    return;
  }
  
  const newPath = resolvePath(st.cwd, m[1].trim());
  st.cwd = newPath;
  
  await bot.sendMessage(msg.chat.id, `📂 CWD: \`${st.cwd}\``, { parse_mode: "Markdown" });
});

// ✅ /pwd
bot.onText(/^\/pwd$/i, async (msg) => {
  const st = chatState.get(msg.chat.id);
  if (!st) {
    await bot.sendMessage(msg.chat.id, "❌ No device selected.");
    return;
  }
  
  await bot.sendMessage(msg.chat.id, `📁 \`${st.cwd}\``, { parse_mode: "Markdown" });
});

// ✅ /ls [path]
bot.onText(/^\/ls(?:\s+(.*))?$/i, async (msg, m) => {
  const deviceId = await getSelectedDevice(msg.chat.id);
  if (!deviceId) return;
  
  const st = chatState.get(msg.chat.id);
  const requested = (m[1]?.trim() || st.cwd);
  const path = resolvePath(st.cwd, requested);
  
  try {
    const cmd = await sendCommand(deviceId, "list_files", { 
      path, 
      limit: 500 
    });
    
    const res = await waitForResultRealtime(cmd.id, 30_000);
    const payload = unwrapResult(res) ?? {};

    // Update cwd if returned
    if (payload.cwd) st.cwd = payload.cwd;

    const lines = formatListingPlain(payload, path);
    
    for (const chunk of chunkMessage(lines.join("\n"))) {
      await bot.sendMessage(msg.chat.id, chunk);
    }
  } catch (e) {
    console.error("ls error:", e);
    await bot.sendMessage(msg.chat.id, `❌ ls failed: ${e.message || e}`);
  }
});

// ✅ /tree [path] - Recursive listing
bot.onText(/^\/tree(?:\s+(.*))?$/i, async (msg, m) => {
  const deviceId = await getSelectedDevice(msg.chat.id);
  if (!deviceId) return;
  
  const st = chatState.get(msg.chat.id);
  const requested = (m[1]?.trim() || st.cwd);
  const path = resolvePath(st.cwd, requested);
  
  await bot.sendMessage(msg.chat.id, "🌳 Building tree...");
  
  try {
    const cmd = await sendCommand(deviceId, "list_files", { 
      path, 
      recursive: true, 
      limit: 1000 
    });
    
    const res = await waitForResultRealtime(cmd.id, 120_000);
    const payload = unwrapResult(res) ?? {};

    if (payload.cwd) st.cwd = payload.cwd;

    // Simple tree formatting
    const lines = [`🌳 Tree: ${path}`];
    
    if (Array.isArray(payload.entries) && payload.entries.length) {
      payload.entries.slice(0, 1000).forEach(e => {
        const name = e.name || e.path || "";
        const type = (e.type || "").toLowerCase();
        const icon = type === "dir" || type === "directory" ? "📁" : "📄";
        lines.push(`${icon} ${name}`);
      });
      
      if (payload.entries.length > 1000) {
        lines.push(`\n⚠️ Showing first 1000 of ${payload.entries.length} items`);
      }
    } else {
      lines.push("(empty)");
    }

    for (const chunk of chunkMessage(lines.join("\n"))) {
      await bot.sendMessage(msg.chat.id, chunk);
    }
  } catch (e) {
    console.error("tree error:", e);
    await bot.sendMessage(msg.chat.id, `❌ tree failed: ${e.message || e}`);
  }
});

// ✅ /send <path> - Upload file and get public URL
bot.onText(/^\/send\s+(.+)$/i, async (msg, m) => {
  const chatId = msg.chat.id;
  const deviceId = await getSelectedDevice(chatId);
  if (!deviceId) return;

  const st = chatState.get(chatId);
  const requested = m[1].trim();
  const path = resolvePath(st.cwd, requested);

  await bot.sendMessage(chatId, "📤 Sending file...");

  try {
    const destName = (path.split("/").pop() || "file").replace(/\s+/g, "_");
    const dest = `${deviceId}/${Date.now()}_${destName}`;
    const bucket = "device-uploads";

    const cmd = await sendCommand(deviceId, "upload_file", {
      path,
      bucket,
      dest,
    });

    const res = await waitForResultRealtime(cmd.id, 120_000);
    const payload = unwrapResult(res) ?? {};

    // Check success
    const success = payload.success === true || payload.publicUrl;

    if (!success) {
      const errorMsg = payload.error || payload.detail || "Unknown error";
      await bot.sendMessage(chatId, `❌ Upload failed: ${errorMsg}`);
      return;
    }

    // Get public URL
    const publicUrl = payload.publicUrl || payload.public_url || payload.url;
    const actualDest = payload.path || payload.dest || dest;
    const size = payload.size ? formatBytes(payload.size) : "unknown size";

    if (publicUrl) {
      await bot.sendMessage(
        chatId,
        `✅ *File uploaded*\n📁 ${actualDest}\n📊 ${size}\n🔗 ${publicUrl}`,
        { parse_mode: "Markdown" }
      );
    } else {
      await bot.sendMessage(chatId, `✅ File uploaded to ${actualDest} (${size})`);
    }
  } catch (e) {
    console.error("send error:", e);
    await bot.sendMessage(chatId, `❌ Error: ${e.message || e}`);
  }
});

// ✅ /upload <path> - Upload via edge function
bot.onText(/^\/upload\s+(.+)$/i, async (msg, m) => {
  const chatId = msg.chat.id;
  const deviceId = await getSelectedDevice(chatId);
  if (!deviceId) return;
  
  const st = chatState.get(chatId);
  const requested = m[1].trim();
  const path = resolvePath(st.cwd, requested);

  await bot.sendMessage(chatId, "📦 Preparing upload...");
  
  try {
    // Step 1: Prepare upload (get file metadata)
    const prepCmd = await sendCommand(deviceId, "prepare_upload", { 
      path 
    });
    
    const prepRes = await waitForResultRealtime(prepCmd.id, 90_000);
    const prepPayload = unwrapResult(prepRes);
    
    if (!prepPayload || !prepPayload.success) {
      await bot.sendMessage(chatId, `❌ Prepare failed: ${JSON.stringify(prepPayload)}`);
      return;
    }

    // Step 2: Build payload for edge function
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

    // Step 3: Call edge function
    const { data, error } = await supabase.functions.invoke("upload-file", { 
      body: payload 
    });

    if (error) {
      await bot.sendMessage(chatId, `❌ Upload failed: ${error.message || JSON.stringify(error)}`);
      return;
    }

    if (data && data.error) {
      await bot.sendMessage(chatId, `❌ Upload failed: ${data.error} - ${data.detail || ""}`);
      return;
    }

    const size = data.size ? formatBytes(data.size) : "unknown";
    await bot.sendMessage(
      chatId, 
      `✅ Uploaded\n📁 Bucket: ${data.bucket}\n📄 Path: ${data.path}\n📊 Size: ${size}`
    );
  } catch (e) {
    console.error("upload error:", e);
    await bot.sendMessage(chatId, `❌ Error: ${e.message || e}`);
  }
});

// ✅ /rm <path> - Delete file
bot.onText(/^\/rm\s+(.+)$/i, async (msg, m) => {
  const chatId = msg.chat.id;
  const deviceId = await getSelectedDevice(chatId);
  if (!deviceId) return;
  
  const st = chatState.get(chatId);
  const requested = m[1].trim();
  const path = resolvePath(st.cwd, requested);

  await bot.sendMessage(chatId, `🗑️ Deleting: \`${path}\``, { parse_mode: "Markdown" });
  
  try {
    const cmd = await sendCommand(deviceId, "delete_file", { path });
    const res = await waitForResultRealtime(cmd.id, 30_000);
    const payload = unwrapResult(res);
    
    if (payload && payload.success) {
      await bot.sendMessage(chatId, `✅ Deleted: ${path}`);
    } else {
      const error = payload?.error || payload?.detail || "Unknown error";
      await bot.sendMessage(chatId, `❌ Delete failed: ${error}`);
    }
  } catch (e) {
    console.error("rm error:", e);
    await bot.sendMessage(chatId, `❌ Error: ${e.message || e}`);
  }
});

// ✅ /rd <path> - Delete directory recursively
bot.onText(/^\/rd\s+(.+)$/i, async (msg, m) => {
  const chatId = msg.chat.id;
  const deviceId = await getSelectedDevice(chatId);
  if (!deviceId) return;
  
  const st = chatState.get(chatId);
  const requested = m[1].trim();
  const path = resolvePath(st.cwd, requested);

  await bot.sendMessage(chatId, `🗑️ Deleting directory: \`${path}\``, { parse_mode: "Markdown" });
  
  try {
    const cmd = await sendCommand(deviceId, "delete_dir", { path });
    const res = await waitForResultRealtime(cmd.id, 60_000);
    const payload = unwrapResult(res);
    
    if (payload && payload.success) {
      await bot.sendMessage(chatId, `✅ Deleted directory: ${path}`);
    } else {
      const error = payload?.error || payload?.detail || "Unknown error";
      await bot.sendMessage(chatId, `❌ Delete failed: ${error}`);
    }
  } catch (e) {
    console.error("rd error:", e);
    await bot.sendMessage(chatId, `❌ Error: ${e.message || e}`);
  }
});

// ✅ /ping
bot.onText(/^\/ping$/i, async (msg) => {
  const deviceId = await getSelectedDevice(msg.chat.id);
  if (!deviceId) return;
  
  try {
    const cmd = await sendCommand(deviceId, "ping");
    const res = await waitForResultRealtime(cmd.id, 20_000);
    const payload = unwrapResult(res) ?? {};
    
    const ts = payload.timestamp || payload.ts || Date.now();
    await bot.sendMessage(msg.chat.id, `🏓 Pong\n⏱️ ${ts}`);
  } catch (e) {
    console.error("ping error:", e);
    await bot.sendMessage(msg.chat.id, `❌ Ping failed: ${e.message || e}`);
  }
});

// ✅ /info - Device information
bot.onText(/^\/info$/i, async (msg) => {
  const deviceId = await getSelectedDevice(msg.chat.id);
  if (!deviceId) return;
  
  try {
    const cmd = await sendCommand(deviceId, "device_info");
    const res = await waitForResultRealtime(cmd.id, 20_000);
    const payload = unwrapResult(res) ?? {};

    // Update cwd if provided
    const st = chatState.get(msg.chat.id);
    if (payload && payload.cwd && st) {
      st.cwd = payload.cwd;
    }

    const text = formatInfo(payload);
    
    for (const chunk of chunkMessage(text)) {
      await bot.sendMessage(msg.chat.id, chunk);
    }
  } catch (e) {
    console.error("info error:", e);
    await bot.sendMessage(msg.chat.id, `❌ Info failed: ${e.message || e}`);
  }
});

// ===========================
// WEBHOOK SERVER
// ===========================

/**
 * Set webhook on Telegram
 */
async function ensureWebhook() {
  try {
    const hook = `${WEBHOOK_URL.replace(/\/$/, "")}/bot${BOT_TOKEN}`;
    await bot.setWebHook(hook);
    console.log("✅ Webhook set:", hook);
  } catch (err) {
    console.error("❌ Failed to set webhook:", err?.response?.body || err?.message || err);
    
    if (err?.response?.statusCode === 409) {
      console.error("⚠️ Conflict (409) - another bot instance may be running");
    }
  }
}

// Set webhook
await ensureWebhook();

/**
 * HTTP server for webhook + health check
 */
const server = http.createServer(async (req, res) => {
  try {
    // ✅ Webhook receiver
    if (req.method === "POST" && req.url === `/bot${BOT_TOKEN}`) {
      let body = "";
      
      req.on("data", chunk => (body += chunk));
      req.on("end", async () => {
        try {
          if (!body) {
            res.writeHead(400);
            res.end("no body");
            return;
          }
          
          const json = JSON.parse(body);
          await bot.processUpdate(json);
          
          res.writeHead(200);
          res.end("ok");
        } catch (e) {
          console.error("❌ processUpdate error:", e);
          res.writeHead(500);
          res.end("error");
        }
      });
      
      return;
    }

    // ✅ Health check
    if (req.method === "GET" && req.url === "/") {
      const connectedChats = chatState.size;
      const activeSubs = pendingSubs.size;
      
      const health = {
        ok: true,
        uptime: process.uptime(),
        connectedChats,
        activePendingCommands: activeSubs,
        timestamp: new Date().toISOString(),
      };
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(health, null, 2));
      return;
    }

    // ✅ 404
    res.writeHead(404);
    res.end("not found");
  } catch (e) {
    console.error("❌ Server error:", e);
    res.writeHead(500);
    res.end("fatal");
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Webhook server listening on port ${PORT}`);
  console.log(`📍 Webhook endpoint: POST ${WEBHOOK_URL.replace(/\/$/, "")}/bot${BOT_TOKEN}`);
  console.log(`📍 Health check: GET ${WEBHOOK_URL.replace(/\/$/, "")}/`);
  console.log("✅ Bot is ready!");
});

// ===========================
// ERROR HANDLERS
// ===========================

bot.on("polling_error", (err) => {
  console.warn("⚠️ Polling error (should not occur in webhook mode):", err?.message || err);
});

bot.on("webhook_error", (err) => {
  console.error("❌ Webhook error:", err?.message || err);
});

process.on("unhandledRejection", (e) => {
  console.error("❌ Unhandled promise rejection:", e);
});

process.on("uncaughtException", (e) => {
  console.error("❌ Uncaught exception:", e);
  process.exit(1);
});

// ===========================
// GRACEFUL SHUTDOWN
// ===========================

process.on("SIGTERM", async () => {
  console.log("⚠️ SIGTERM received, shutting down gracefully...");
  
  // Close all pending subscriptions
  for (const [cmdId, rec] of pendingSubs.entries()) {
    try {
      if (rec.sub) supabase.removeChannel(rec.sub);
      if (rec.timeout) clearTimeout(rec.timeout);
      if (rec.poller) clearInterval(rec.poller);
    } catch (e) {
      console.error(`Error cleaning up ${cmdId}:`, e);
    }
  }
  pendingSubs.clear();
  
  server.close(() => {
    console.log("✅ Server closed");
    process.exit(0);
  });
});

console.log("✅ Telegram bot initialized successfully");
