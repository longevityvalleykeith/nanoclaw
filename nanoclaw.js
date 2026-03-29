#!/usr/bin/env node
/**
 * NanoClaw v10 — Entity-Scoped Attention Graph Memory (ESAGM)
 *
 * Agent 0 Chief of Staff: autonomous dual-persona (COS + Expert Rep)
 * with entity-isolated multi-turn memory, hierarchy-scoped tool access,
 * and full audit trail.
 *
 * Base: Keith's v3 (proven Telegram polling + gateway routing)
 * Added: ESAGM memory, Anthropic tool_use, correlation ID, audit events
 *
 * WHO-WHAT-WHY-WHEN-HOW semantic isolation:
 *   Each entity (patient/system) gets its own memory partition.
 *   Context switches park one entity and load another.
 *   Zero cross-contamination between patients or admin/clinical contexts.
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MOTHERSHIP = process.env.LV_BACKEND_URL || 'https://app.longevityvalley.ai';
const MCP_KEY = process.env.MCP_API_KEY;
if (!MCP_KEY) { console.error('[nc] FATAL: MCP_API_KEY not set'); process.exit(1); }

// Per-tenant MCP key resolution (prevents cross-tenant data leak)
var TENANT_MCP_KEYS = {
  'abe1b946-6643-4acc-9cc1-6a47336d31d8': process.env.MCP_API_KEY_AMANI || MCP_KEY,
  '3cc281be-aafc-4579-9edf-521659306145': process.env.MCP_API_KEY_MAGFIELD || MCP_KEY,
  '0d18e819-36fa-40a9-9704-cea809a7c7ea': process.env.MCP_API_KEY_PINGCARE || MCP_KEY,
  '313a6002-5718-4c28-8fe1-82f831b83cdf': MCP_KEY,
};
function getMcpKey(tenantId) { return TENANT_MCP_KEYS[tenantId] || MCP_KEY; }
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const MINIMAX_KEY = process.env.MINIMAX_API_KEY || '';
const MINIMAX_TTS_KEY = process.env.MINIMAX_TTS_API_KEY || process.env.MINIMAX_API_KEY || '';
const MINIMAX_URL = 'https://api.minimax.io/v1/chat/completions';
const MINIMAX_MODEL = 'MiniMax-M2.7';
const MINIMAX_GROUP_ID = process.env.MINIMAX_GROUP_ID || '';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CRON_SECRET = process.env.CRON_SECRET || '';
const POLL_TIMEOUT = 30;
const TENANT_ID = process.env.TENANT_ID || '313a6002-5718-4c28-8fe1-82f831b83cdf';
const EXPERT_NAME = process.env.EXPERT_NAME || 'Keith Koo';
const EXPERT_SLUG = process.env.EXPERT_SLUG || 'keith-koo';
const HEALTH_PORT = 3002;
const GATEWAY_TIMEOUT = 120000;
const NANOCLAW_VERSION = 'v11.3.0-safety'; // S1-S4 safety patched

if (!TG_TOKEN) { console.error('[nc] FATAL: TELEGRAM_BOT_TOKEN not set'); process.exit(1); }

// ============================================================================
// S1: PROCESS CRASH RECOVERY
// ============================================================================
process.on('uncaughtException', function(err) {
  console.error('[nc] UNCAUGHT EXCEPTION:', err.message, err.stack);
  emitAudit('nanoclaw.crash', { type: 'uncaughtException', error: err.message });
  setTimeout(function() { process.exit(1); }, 2000);
});
process.on('unhandledRejection', function(reason) {
  console.error('[nc] UNHANDLED REJECTION:', reason);
  emitAudit('nanoclaw.crash', { type: 'unhandledRejection', error: String(reason) });
});

// ============================================================================
// S2: GRACEFUL SHUTDOWN
// ============================================================================
var healthServer = null;
var isShuttingDown = false;
function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[nc] ' + signal + ' received — graceful shutdown');
  emitAudit('nanoclaw.shutdown', { signal: signal, version: NANOCLAW_VERSION });
  if (healthServer) try { healthServer.close(); } catch(e) {}
  setTimeout(function() { process.exit(0); }, 3000);
}
process.on('SIGTERM', function() { gracefulShutdown('SIGTERM'); });
process.on('SIGINT', function() { gracefulShutdown('SIGINT'); });

// ============================================================================
// S3: CIRCUIT BREAKER ON MOTHERSHIP GATEWAY
// ============================================================================
var gatewayFailures = 0;
var gatewayCircuitOpenUntil = 0;
var GATEWAY_CB_THRESHOLD = 5;
var GATEWAY_CB_COOLDOWN_MS = 60000;
function isGatewayCircuitOpen() {
  return Date.now() < gatewayCircuitOpenUntil;
}
function recordGatewaySuccess() {
  gatewayFailures = 0;
}
function recordGatewayFailure() {
  gatewayFailures++;
  if (gatewayFailures >= GATEWAY_CB_THRESHOLD) {
    gatewayCircuitOpenUntil = Date.now() + GATEWAY_CB_COOLDOWN_MS;
    console.warn('[nc] Circuit breaker OPEN on Mothership gateway after ' + gatewayFailures + ' failures');
    emitAudit('nanoclaw.circuit_open', { failures: gatewayFailures, cooldownMs: GATEWAY_CB_COOLDOWN_MS });
  }
}

// ============================================================================
// TENANT MAPPING
// ============================================================================
const CHAT_TENANT_MAP = {
  // Admin chat ID loaded dynamically — seeded from TENANT_ID env

};
// SEC-03: No default tenant — unknown chat IDs are rejected
var DEFAULT_TENANT = null;

// ============================================================================
// HTTPS HELPERS
// ============================================================================
function httpsPost(url, headers, body, timeout) {
  return new Promise(function(resolve, reject) {
    var data = JSON.stringify(body);
    var u = new URL(url);
    var req = https.request({
      method: 'POST', hostname: u.hostname, port: 443,
      path: u.pathname + u.search, family: 4,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers),
      timeout: timeout || 30000,
    }, function(res) {
      var buf = ''; res.on('data', function(c) { buf += c; });
      res.on('end', function() { try { resolve(JSON.parse(buf)); } catch(e) { resolve({ _raw: buf }); } });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('timeout')); });
    req.write(data); req.end();
  });
}

function httpsGet(url, headers, timeout) {
  return new Promise(function(resolve, reject) {
    var u = new URL(url);
    var req = https.request({
      method: 'GET', hostname: u.hostname, port: 443,
      path: u.pathname + u.search, family: 4, headers: headers, timeout: timeout || 15000,
    }, function(res) {
      var buf = ''; res.on('data', function(c) { buf += c; });
      res.on('end', function() { try { resolve(JSON.parse(buf)); } catch(e) { resolve([]); } });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ============================================================================
// TELEGRAM API
// ============================================================================
function tgApi(method, body) {
  return httpsPost('https://api.telegram.org/bot' + TG_TOKEN + '/' + method, {}, body || {}, (POLL_TIMEOUT + 10) * 1000);
}

function sendTelegram(chatId, text) {
  var clean = text.replace(/<think>[^]*?<\/think>/g, '').replace(/<\/?think>/g, '').replace(/<!-- .*? -->/g, '').trim();
  if (!clean) clean = 'How can I help?';
  var truncated = clean.length > 4000 ? clean.slice(0, 3997) + '...' : clean;
  return tgApi('sendMessage', { chat_id: chatId, text: truncated, parse_mode: 'Markdown' })
    .then(function(r) { if (r && r.ok) { try { emitAudit('delivery.confirmed', { chatId: String(chatId), chars: truncated.length }); } catch(e) {} } return r; })
    .catch(function() { return tgApi('sendMessage', { chat_id: chatId, text: truncated }); });
}

// ============================================================================
// GEO RELAY — DR MAGfield Autonomous Loop
// ============================================================================
// Auto-relays GEO research outputs to Keith. Triggered after content generation.
// Chat ID for Keith: 1544430803

var GEO_ADMIN_CHAT_ID = '1544430803';
var GEO_GROUP_CHAT_ID = '-3771302334'; // Supergroup

// Geo feedback storage: pattern → count
var geoFeedbackPattern = {};

// Token budget tracking
var geoTokenBudget = {
  total: 150000,
  remaining: 80000,  // Updated after first cycle spend estimate
  cycleStart: Date.now()
};

// ============================================================================
// USER PREFERENCE TRACKER — Multi-modal response preferences
// ============================================================================
// Stores per-chat preference for response format: voice, video, or text
var userPreferences = {};

function getUserPreference(chatId) {
  var prefs = userPreferences[String(chatId)] || { format: 'text', voiceId: null, learnedAt: null };
  return prefs;
}

function setUserPreference(chatId, format, voiceId) {
  var key = String(chatId);
  if (!userPreferences[key]) userPreferences[key] = { format: 'text', voiceId: null, learnedAt: null };
  userPreferences[key].format = format;
  if (voiceId) userPreferences[key].voiceId = voiceId;
  userPreferences[key].learnedAt = Date.now();
  console.log('[nc] User ' + chatId + ' preference set: format=' + format + (voiceId ? ' voiceId=' + voiceId : ''));
}

function parseResponsePreference(text) {
  var lower = text.toLowerCase();
  if (/send (as |as )?(voice|audio|voicenote|vocal)/i.test(text)) return 'voice';
  if (/make a (video|i2v)|generate video|create video/i.test(text)) return 'video';
  if (/send as text|text (only|reply)|文字|text reply/i.test(text)) return 'text';
  return null;
}

// ============================================================================
// MULTI-MODAL HELPERS — MiniMax TTS + I2V
// ============================================================================

// Upload file to catbox for public URL (used for I2V first_frame_image)
function uploadToCatbox(fileBuffer, filename, mimeType) {
  return new Promise(function(resolve, reject) {
    var boundary = '----FormBoundary' + Date.now();
    var body = '--' + boundary + '\r\n';
    body += 'Content-Disposition: form-data; name="reqtype"\r\n\r\n';
    body += 'fileupload\r\n';
    body += '--' + boundary + '\r\n';
    body += 'Content-Disposition: form-data; name="fileToUpload"; filename="' + filename + '"\r\n';
    body += 'Content-Type: ' + mimeType + '\r\n\r\n';

    var buf = Buffer.concat([
      Buffer.from(body, 'utf8'),
      fileBuffer,
      Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8')
    ]);

    var u = new URL('https://catbox.moe/user/api.php');
    var req = https.request({
      method: 'POST', hostname: u.hostname, port: 443,
      path: u.pathname, family: 4,
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': buf.length }
    }, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var result = Buffer.concat(chunks).toString('utf8');
        if (result.startsWith('https://')) resolve(result.trim());
        else reject(new Error('Catbox upload failed: ' + result));
      });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

// Generate TTS audio via MiniMax
function generateTTS(text, voiceId, speed) {
  voiceId = voiceId || 'male-qn-qingse';
  speed = speed || 1.0;
  return httpsPost('https://api.minimax.io/v1/t2a_v2', {
    'Authorization': 'Bearer ' + MINIMAX_TTS_KEY,
    'Content-Type': 'application/json',
  }, {
    model: 'speech-02-hd',
    text: text.slice(0, 5000),
    voice_setting: { voice_id: voiceId, speed: speed, vol: 1.0 },
    output_format: 'url'
  }, 30000).then(function(result) {
    if (result.base_resp && result.base_resp.status_code !== 0) {
      throw new Error('TTS failed: ' + (result.base_resp.status_msg || 'unknown'));
    }
    var audioUrl = result.data && result.data.audio ? result.data.audio : null;
    return { success: !!audioUrl, audioUrl: audioUrl, extra: result.extra_info || {} };
  });
}

// Generate I2V via MiniMax (image to video)
function generateI2V(imageUrl, prompt, duration) {
  duration = duration || 6;
  var model = 'MiniMax-Hailuo-2.3';
  return httpsPost('https://api.minimax.io/v1/video_generation', {
    'Authorization': 'Bearer ' + MINIMAX_KEY,
  }, {
    model: model,
    first_frame_image: imageUrl,
    prompt: (prompt || '').slice(0, 2000),
    duration: duration,
  }, 15000).then(function(result) {
    if (result.base_resp && result.base_resp.status_code !== 0) {
      throw new Error('I2V failed: ' + (result.base_resp.status_msg || 'unknown'));
    }
    return { success: !!result.task_id, taskId: result.task_id };
  });
}

// Poll I2V status until done
function pollI2V(taskId, maxAttempts) {
  maxAttempts = maxAttempts || 18;
  return new Promise(function(resolve, reject) {
    var attempts = 0;
    function poll() {
      attempts++;
      httpsGet('https://api.minimax.io/v1/query/video_generation?task_id=' + taskId, {
        'Authorization': 'Bearer ' + MINIMAX_KEY,
      }, 10000).then(function(result) {
        if (result.status === 'Success') {
          resolve({ success: true, fileId: result.file_id, width: result.video_width, height: result.video_height });
        } else if (result.status === 'Fail') {
          reject(new Error('I2V generation failed'));
        } else if (attempts >= maxAttempts) {
          reject(new Error('I2V timeout after ' + maxAttempts + ' attempts'));
        } else {
          setTimeout(poll, 10000);
        }
      }).catch(reject);
    }
    poll();
  });
}

// Voice clone via MiniMax (requires sk-api- key with voice clone enabled)
function cloneVoice(audioBuffer, name, description) {
  var boundary = '----FormBoundary' + Date.now();
  var body = '--' + boundary + '\r\n';
  body += 'Content-Disposition: form-data; name="name"\r\n\r\n';
  body += (name || 'cloned_voice') + '\r\n';
  body += '--' + boundary + '\r\n';
  body += 'Content-Disposition: form-data; name="description"\r\n\r\n';
  body += (description || 'cloned voice') + '\r\n';
  body += '--' + boundary + '\r\n';
  body += 'Content-Disposition: form-data; name="audio"; filename="voice.ogg"\r\n';
  body += 'Content-Type: audio/ogg\r\n\r\n';

  var buf = Buffer.concat([
    Buffer.from(body, 'utf8'),
    audioBuffer,
    Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8')
  ]);

  return new Promise(function(resolve, reject) {
    var u = new URL('https://api.minimax.io/v1/voice_clone');
    var req = https.request({
      method: 'POST', hostname: u.hostname, port: 443,
      path: u.pathname, family: 4,
      headers: { 'Authorization': 'Bearer ' + MINIMAX_TTS_KEY, 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': buf.length }
    }, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        try {
          var result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (result.base_resp && result.base_resp.status_code !== 0) {
            reject(new Error('Voice clone failed: ' + (result.base_resp.status_msg || 'unknown')));
          } else {
            resolve({ success: !!result.voice_id, voiceId: result.voice_id });
          }
        } catch(e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

// Send Telegram voice message
function sendVoiceMessage(chatId, audioUrl, caption) {
  return tgApi('sendVoice', {
    chat_id: chatId,
    voice: audioUrl,
    caption: caption ? caption.slice(0, 200) : undefined,
  });
}

// ============================================================================
// BRAND DNA — Multi-modal aware system prompt builder
// ============================================================================
function buildMultimodalSystemPrompt(tenant, persona, chatId) {
  var brand = BRAND_DNA;
  var pref = getUserPreference(chatId);
  var prompt = 'You are ' + brand.name + ' — ' + brand.tagline + '.\n';
  prompt += 'Tech: ' + brand.tech + '.\n';
  prompt += 'Products: ' + brand.products.join(', ') + '.\n';
  prompt += 'Location: ' + brand.location + '.\n';
  prompt += 'Tone: ' + brand.tone + '.\n';
  prompt += 'ICP: ' + brand.icp + '.\n\n';

  if (pref.format === 'voice' && pref.voiceId) {
    prompt += 'USER PREFERENCE: Respond with voice (TTS). Use voice_id: ' + pref.voiceId + '.\n';
  } else if (pref.format === 'video') {
    prompt += 'USER PREFERENCE: Generate I2V video responses when appropriate.\n';
  }

  prompt += '\nREMEMBER: You have multi-modal capabilities:\n';
  prompt += '- voice_response: Send as Telegram voice message\n';
  prompt += '- generate_tts: Create TTS audio with specific voice\n';
  prompt += '- generate_i2v: Create video from image + prompt\n';
  prompt += '- When user asks for "voice" or "audio" — use voice_response tool\n';
  prompt += '- When user asks for "video" or "I2V" — use generate_i2v tool\n';
  prompt += '- Detect preference from: "send as voice", "make a video", "text reply"\n';
  return prompt;
}

function relayGeoOutput(type, summary, details) {
  var msg = buildGeoMessage(type, summary, details);
  sendTelegram(GEO_ADMIN_CHAT_ID, msg).catch(function(e) {
    console.error('[nc] GEO relay failed:', e.message || e);
  });
  // Group gets emoji-only summary
  if (type === 'iteration_complete' || type === 'published') {
    var emoji = type === 'published' ? '🎉' : '📊';
    sendTelegram(GEO_GROUP_CHAT_ID, emoji + ' ' + summary.slice(0, 100)).catch(function() {});
  }
}

function buildGeoMessage(type, summary, details) {
  var header = {
    'fix_pack': '📋 GEO Fix Pack',
    'content_published': '🚀 Content Published',
    'citation_recheck': '📊 Citation Recheck',
    'iteration_complete': '📊 Iteration Done',
    'alert': '⚠️ Alert',
    'digest': '☀️ Daily Digest'
  }[type] || '📋 Update';

  var msg = header + ' — ' + formatDate() + '\n\n' + summary;
  if (details) msg += '\n\n' + details;
  msg += '\n\nToken: ' + Math.round(geoTokenBudget.remaining/1000) + 'k / ' + Math.round(geoTokenBudget.total/1000) + 'k left';
  return msg;
}

function formatDate() {
  var d = new Date();
  return d.toISOString().slice(0, 10);
}

// Parse emoji feedback from Keith and update pattern tracking
function parseGeoFeedback(text) {
  var lower = text.toLowerCase().trim();
  var emoji = null;
  if (/^[\U0001F44D\U0001F44E\U0001F64C\U00002753\U0001F525]/.test(text)) {
    // Unicode: 👍 👎 🙌 ❓ 🔥
    if (text.startsWith('👍')) emoji = 'approve';
    else if (text.startsWith('👎')) emoji = 'reject';
    else if (text.startsWith('❓')) emoji = 'clarify';
    else if (text.startsWith('🔥')) emoji = 'love';
    else emoji = 'unknown';
  }
  if (!emoji) {
    // Text-based
    if (/^(good|great|looks good|approve|yes|yep|👍|love it)/i.test(lower)) emoji = 'approve';
    else if (/^(no|wrong|bad|fix|revise|👎)/i.test(lower)) emoji = 'reject';
    else if (/^\?|what|how|why/i.test(lower)) emoji = 'clarify';
    else if (/stop|halt|pause/i.test(lower)) emoji = 'stop';
  }
  if (emoji) {
    geoFeedbackPattern[emoji] = (geoFeedbackPattern[emoji] || 0) + 1;
    console.log('[nc] GEO feedback: ' + emoji + ' (count: ' + geoFeedbackPattern[emoji] + ')');
    // Systemic flag: same feedback 3x = alert
    if (geoFeedbackPattern[emoji] >= 3) {
      relayGeoOutput('alert', 'Systemic feedback pattern detected: ' + emoji + ' appeared 3x', 'Consider revising approach. Current patterns: ' + JSON.stringify(geoFeedbackPattern));
    }
  }
  return emoji;
}

// Deduct token spend
function trackGeoToken(spent) {
  geoTokenBudget.remaining = Math.max(0, geoTokenBudget.remaining - spent);
  console.log('[nc] GEO token spend: -' + spent + ' | Remaining: ' + geoTokenBudget.remaining);
  if (geoTokenBudget.remaining < 20000) {
    relayGeoOutput('alert', 'Token reserve low: ' + Math.round(geoTokenBudget.remaining/1000) + 'k left', 'Consider pausing non-critical iterations.');
  }
}

// Daily digest — 9am UTC
var lastDigestDate = null;
function checkDailyDigest() {
  var now = new Date();
  var utcHour = now.getUTCHours();
  var utcDate = now.toISOString().slice(0, 10);
  if (utcHour === 9 && utcDate !== lastDigestDate) {
    lastDigestDate = utcDate;
    compileAndSendDigest();
  }
}
function compileAndSendDigest() {
  var msg = '☀️ DR MAGfield Daily Digest — ' + formatDate() + '\n\n';
  msg += 'Token: ' + Math.round(geoTokenBudget.remaining/1000) + 'k / ' + Math.round(geoTokenBudget.total/1000) + 'k\n';
  msg += 'Feedback patterns: ' + JSON.stringify(geoFeedbackPattern) + '\n\n';
  msg += 'System: Autonomous loop active. Monitoring GEO output.';
  sendTelegram(GEO_ADMIN_CHAT_ID, msg).catch(function(e) {
    console.error('[nc] Daily digest failed:', e.message || e);
  });
  emitAudit('nanoclaw.daily_digest_sent', { date: utcDate, tokensLeft: geoTokenBudget.remaining });
}

// Run digest check every 5 minutes
setInterval(checkDailyDigest, 5 * 60 * 1000);

// ============================================================================
// ENTITY-SCOPED ATTENTION GRAPH MEMORY (ESAGM)
// ============================================================================
var chatMemory = {};

function getChat(chatId) {
  var key = String(chatId);
  if (!chatMemory[key]) {
    chatMemory[key] = {
      entityStack: [],
      entities: {},
      global: { totalTurns: 0, sessionStart: Date.now() },
    };
  }
  return chatMemory[key];
}

function getEntity(chatId, entityId) {
  var chat = getChat(chatId);
  if (!chat.entities[entityId]) {
    chat.entities[entityId] = {
      type: entityId.startsWith('patient:') ? 'patient' : 'system',
      displayName: entityId.split(':').slice(1).join(':'),
      lastActive: Date.now(),
      turns: [],
      digest: '',
      anchor: '',
    };
  }
  return chat.entities[entityId];
}

function resolveEntity(text, chat, tenant) {
  var lower = text.toLowerCase();

  // 1. Admin commands → system scope
  if (/^\/(status|sli|deploy|health|converge|anneal)/.test(lower)) return 'system:admin';
  if (/\b(sli|tenant|deploy|system health|dark factory|convergence|all patients)\b/i.test(lower)) return 'system:admin';

  // 2. Named patient detection (check known entities first)
  for (var eid in chat.entities) {
    if (eid.startsWith('patient:')) {
      var name = chat.entities[eid].displayName.toLowerCase();
      if (name.length >= 3 && lower.includes(name)) return eid;
    }
  }

  // 3. Registration command — extract patient name as new entity
  var regMatch = lower.match(/register\s+patient\s+(.+?)(?:\s+(?:dob|male|female)|$)/i);
  if (regMatch) {
    var regName = regMatch[1].trim().replace(/\s+/g, '-').toLowerCase();
    return 'patient:' + regName;
  }
  // "Prepare capsule for [NAME]" / "Start intake for [NAME]"
  // Must contain a proper noun (capitalized) — skip generic phrases like "for whatsapp"
  var forMatch = text.match(/(?:capsule|intake|summary)\s+(?:for|summary\s+for)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+)/i);
  if (forMatch) {
    var forName = forMatch[1].trim().replace(/\s+/g, '-').toLowerCase();
    // Check known patients first
    var knownPatients = {
      'wu siew wong': 'patient:wu-siew-wong', 'wu': 'patient:wu-siew-wong', 'madam wu': 'patient:wu-siew-wong',
      'yaya': 'patient:yaya-lee-guat-hoon', 'yaya lee guat hoon': 'patient:yaya-lee-guat-hoon',
      'lee guat hoon': 'patient:yaya-lee-guat-hoon', 'kenneth': 'patient:kenneth',
      'young yuet ngoh': 'patient:young-yuet-ngoh-claire', 'claire': 'patient:young-yuet-ngoh-claire',
    };
    var forLower = forMatch[1].trim().toLowerCase();
    if (knownPatients[forLower]) return knownPatients[forLower];
    return 'patient:' + forName;
  }

  // 3b. Known patient names in general text
  var knownPatients2 = {
    'wu siew wong': 'patient:wu-siew-wong', 'wu': 'patient:wu-siew-wong', 'madam wu': 'patient:wu-siew-wong',
    'yaya': 'patient:yaya-lee-guat-hoon', 'lee guat hoon': 'patient:yaya-lee-guat-hoon',
    'kenneth': 'patient:kenneth', 'young yuet ngoh': 'patient:young-yuet-ngoh-claire', 'claire': 'patient:young-yuet-ngoh-claire',
  };
  for (var pname in knownPatients2) {
    if (lower.includes(pname)) return knownPatients2[pname];
  }

  // 4. Pronoun resolution → most recent patient (with gender matching)
  if (/\b(her|his|she|he|the patient|this patient|for her|for him)\b/i.test(lower)) {
    var isFemale = /\b(her|she)\b/i.test(lower);
    var isMale = /\b(his|he|him)\b/i.test(lower);
    for (var i = 0; i < chat.entityStack.length; i++) {
      if (chat.entityStack[i].startsWith('patient:')) {
        // If we can match gender, prefer it. Otherwise return most recent.
        return chat.entityStack[i];
      }
    }
  }

  // 4b. Short follow-ups ("yes", "no", "ok", "1", "2") → keep current entity
  if (lower.length <= 5 && /^(yes|no|ok|sure|1|2|3|4|5|go|do it|confirm)$/i.test(lower.trim())) {
    return chat.entityStack[0] || 'system:general';
  }

  // 5. Clinical content → continue with current patient entity
  if (/\b(capsule|protocol|prescri|dosage|remedy|treatment|diagnosis|symptom|nosode|potency)\b/i.test(lower)) {
    for (var j = 0; j < chat.entityStack.length; j++) {
      if (chat.entityStack[j].startsWith('patient:')) return chat.entityStack[j];
    }
  }

  // 6. Default: continue with top of stack, or general conversation
  return chat.entityStack[0] || 'system:general';
}

function switchEntity(chatId, newEntityId) {
  var chat = getChat(chatId);
  var current = chat.entityStack[0];

  if (current === newEntityId) return; // No switch needed

  // Park current entity
  if (current) {
    var curEntity = getEntity(chatId, current);
    curEntity.lastActive = Date.now();
    // Compress if too many turns
    if (curEntity.turns.length > 8) {
      var overflow = curEntity.turns.splice(0, curEntity.turns.length - 4);
      var compressed = overflow.map(function(t) {
        return (t.role === 'user' ? 'U' : 'A') + ': ' + t.content.slice(0, 80);
      }).join(' | ');
      curEntity.digest = (curEntity.digest + ' ' + compressed).trim().slice(-400);
    }
  }

  // Load new entity (push to top of stack)
  chat.entityStack = chat.entityStack.filter(function(e) { return e !== newEntityId; });
  chat.entityStack.unshift(newEntityId);
  if (chat.entityStack.length > 5) chat.entityStack = chat.entityStack.slice(0, 5);

  getEntity(chatId, newEntityId).lastActive = Date.now();

  if (current && current !== newEntityId) {
    console.log('[nc] Entity switch: ' + (current || 'none') + ' → ' + newEntityId);
  }
}

function addEntityTurn(chatId, entityId, role, content) {
  var entity = getEntity(chatId, entityId);
  entity.turns.push({ role: role, content: content.slice(0, 600), ts: Date.now() });
  if (entity.turns.length > 10) entity.turns = entity.turns.slice(-8);
  getChat(chatId).global.totalTurns++;
}

// ============================================================================
// PERSONA DETECTION
// ============================================================================
function detectPersona(text, entityId, tenant) {
  if (entityId === 'system:admin') return 'cos';
  if (entityId.startsWith('patient:')) return 'expert_rep';
  if (tenant.isAdmin && /\b(status|system|sli|deploy|tenant)\b/i.test(text)) return 'cos';
  return 'expert_rep';
}

// ============================================================================
// TOOL DEFINITIONS (Anthropic native tool_use)
// ============================================================================
// ============================================================================
// FULL TOOL SUITE — Gateway MCP tools (same as Claude Desktop)
// ============================================================================
var ALL_TOOLS = [
  { name: 'query_knowledge', description: 'Search KB for rules, protocols, patient data ($0, 200ms). ALWAYS call first for factual questions.', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Search text' } }, required: ['query'] } },
  { name: 'get_patient_roster', description: 'List patients assigned to this expert. Returns patient names, IDs, session counts.', input_schema: { type: 'object', properties: { expertSlug: { type: 'string', description: 'Expert slug (default: tenant expert)' } }, required: [] } },
  { name: 'create_patient', description: 'Register a new patient. Returns patient ID.', input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Patient full name' }, dateOfBirth: { type: 'string', description: 'DOB in YYYY-MM-DD format' }, biologicalSex: { type: 'string', description: 'male or female' } }, required: ['name'] } },
  { name: 'start_intake', description: 'Start structured health assessment for a patient.', input_schema: { type: 'object', properties: { patientName: { type: 'string', description: 'Patient name to start intake for' } }, required: ['patientName'] } },
  { name: 'ask_wellness_question', description: 'Full 9-step NSMO flywheel for clinical wellness queries. 30-60s. Use for evidence-based health answers.', input_schema: { type: 'object', properties: { question: { type: 'string', description: 'Health/wellness question' } }, required: ['question'] } },
  { name: 'get_synthesized_capsule', description: 'Generate clinical capsule narrative for a patient with MOAT scoring.', input_schema: { type: 'object', properties: { message: { type: 'string', description: 'Capsule request with patient context' }, sessionId: { type: 'string', description: 'Session ID (default: tenant ID)' } }, required: ['message'] } },
  { name: 'task_mirror', description: 'Your operational status — claimed tasks, completion rate, actions.', input_schema: { type: 'object', properties: {} } },
  { name: 'send_to_group', description: 'Send a message to the Telegram GROUP chat (visible to ALL members). This is NOT a private DM. If admin asks for a private/personal message, tell them this tool only sends to the group. For private DMs, the patient must first message the bot directly to create a 1:1 chat.', input_schema: { type: 'object', properties: { message: { type: 'string', description: 'Message to send' }, patientName: { type: 'string', description: 'Patient name to address' } }, required: ['message'] } },
  { name: 'schedule_followup', description: 'Schedule a follow-up message for later delivery. IMPORTANT: The message will only be delivered if the patient has an active Telegram chat with the bot. If the patient has never messaged the bot directly, the message will be queued but CANNOT be delivered — tell the admin this honestly.', input_schema: { type: 'object', properties: { patientName: { type: 'string', description: 'Patient name' }, delayHours: { type: 'number', description: 'Hours until followup (24=1day)' }, message: { type: 'string', description: 'Followup message' } }, required: ['patientName', 'delayHours'] } },
  { name: 'list_scheduled_tasks', description: 'List all pending scheduled follow-ups and tasks.', input_schema: { type: 'object', properties: {} } },
  { name: 'verify_response', description: 'Self-check draft against KB and practice rules before delivering.', input_schema: { type: 'object', properties: { draft_response: { type: 'string', description: 'Draft to verify' } }, required: ['draft_response'] } },
  { name: 'create_checkout_link', description: 'Create Stripe checkout link for product purchase (Qi Master \, Qi Mini \). Returns payment URL.', input_schema: { type: 'object', properties: { productId: { type: 'string', description: 'qi-master or qi-mini' }, patientName: { type: 'string', description: 'Patient name' } }, required: ['productId'] } },
  { name: 'voice_response', description: 'Convert text to speech audio and send as Telegram voice message. Use for accessibility or when patient prefers audio.', input_schema: { type: 'object', properties: { text: { type: 'string', description: 'Text to speak (max 5000 chars)' } }, required: ['text'] } },
  { name: 'verify_url', description: 'Check if a URL is working (Stripe checkout, payment links, LV links). Returns status code and whether page loads. Use when customer asks if a link works.', input_schema: { type: 'object', properties: { url: { type: 'string', description: 'URL to verify' } }, required: ['url'] } },
  { name: 'generate_tts', description: 'Generate TTS audio via MiniMax and return audio URL (does NOT send to Telegram). Use when you need the audio URL for video I2V or other processing.', input_schema: { type: 'object', properties: { text: { type: 'string', description: 'Text to speak (max 5000 chars)' }, voice_id: { type: 'string', description: 'MiniMax voice ID (default: male-qn-qingse)' }, speed: { type: 'number', description: 'Speed 0.5-2.0 (default: 1.0)' } }, required: ['text'] } },
  { name: 'generate_i2v', description: 'Generate image-to-video via MiniMax Hailuo. Submit job and return task_id. Poll for completion separately.', input_schema: { type: 'object', properties: { image_url: { type: 'string', description: 'Public URL of image (required)' }, prompt: { type: 'string', description: 'Video prompt description (max 2000 chars)' }, duration: { type: 'number', description: 'Duration 6 or 10 seconds (default: 6)' } }, required: ['image_url'] } },
  { name: 'poll_i2v', description: 'Poll I2V task status and return video file_id when complete.', input_schema: { type: 'object', properties: { task_id: { type: 'string', description: 'I2V task_id from generate_i2v' } }, required: ['task_id'] } },
  { name: 'set_user_preference', description: 'Record user preference for response format (voice/video/text). Auto-detected from phrasing but can be set explicitly.', input_schema: { type: 'object', properties: { format: { type: 'string', description: 'Response format: voice, video, or text' }, voice_id: { type: 'string', description: 'Preferred voice_id for TTS (optional)' } }, required: ['format'] } },
  { name: 'design_feedback', description: 'Submit design feedback for landing page / kiosk / PWA improvement. Tenant admin sends UI/UX feedback that feeds into the Stitch MCP design loop on Mac Mini. Use when admin says "the page looks wrong" or "change the color" or "improve the layout".', input_schema: { type: 'object', properties: { surface: { type: 'string', enum: ['landing', 'kiosk', 'pwa', 'mothership'], description: 'Which surface to improve' }, feedback: { type: 'string', description: 'What to change (colors, layout, copy, images, etc.)' }, priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'How urgent' } }, required: ['surface', 'feedback'] } },
  { name: 'generate_content', description: 'Generate branded content for Telegram/Kiosk/Social. Creates product showcase, event promo, or health tip using brand DNA. Returns content atom with HTML.', input_schema: { type: 'object', properties: { type: { type: 'string', enum: ['product-showcase', 'promo-offer', 'health-tip', 'event-promo', 'testimonial'], description: 'Content type' }, headline: { type: 'string', description: 'Main headline' }, body: { type: 'string', description: 'Body copy' }, cta: { type: 'string', description: 'CTA text' }, product: { type: 'string', description: 'Product name' }, eventName: { type: 'string', description: 'Event name' }, eventDate: { type: 'string', description: 'Event date' } }, required: ['type', 'headline'] } },
  { name: 'broadcast', description: 'Send approved content to Telegram GROUP and/or Kiosk. Admin-only. Use after approving generated content.', input_schema: { type: 'object', properties: { message: { type: 'string', description: 'Message to broadcast' }, mediaUrl: { type: 'string', description: 'Image/video URL to attach' }, mediaType: { type: 'string', enum: ['photo', 'video', 'animation'], description: 'Media type' } }, required: ['message'] } },
  { name: 'event_campaign', description: 'Create content campaign for a KRPM golf event. Generates schedule: T-7 hype, T-1 reminder, T-0 event day, T+1 recap. Admin-only.', input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Event name' }, date: { type: 'string', description: 'Event date YYYY-MM-DD' }, offer: { type: 'string', description: 'Special offer' } }, required: ['name', 'date'] } },
  { name: 'render_video', description: 'Render Content Atom as MP4 video using Remotion (local Mac Mini, no API timeout). Returns video file path.', input_schema: { type: 'object', properties: { headline: { type: 'string', description: 'Video headline' }, body: { type: 'string', description: 'Body text' }, cta: { type: 'string', description: 'CTA text' }, type: { type: 'string', description: 'Content type' }, product: { type: 'string', description: 'Product name' }, eventName: { type: 'string', description: 'Event name' }, eventDate: { type: 'string', description: 'Event date' } }, required: ['headline'] } },
];

// Scope by persona
var TOOLS_COS = ALL_TOOLS; // Admin gets everything
var TOOLS_EXPERT = ALL_TOOLS.filter(function(t) { return t.name !== 'task_mirror'; }); // Expert gets clinical tools

// SEC-06: Sanitize string inputs before tool calls
function sanitize(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[\x00-\x1f]/g, '').replace(/[<>]/g, '').slice(0, 500);
}

async function executeToolCall(toolName, input, tenant, correlationId) {
  // SEC-06: Validate tool name against allowlist
  var allowedTools = ['query_knowledge', 'get_patient_roster', 'create_patient', 'start_intake', 'ask_wellness_question', 'get_synthesized_capsule', 'task_mirror', 'verify_response', 'send_to_group', 'schedule_followup', 'list_scheduled_tasks', 'create_checkout_link', 'voice_response', 'verify_url', 'generate_tts', 'generate_i2v', 'poll_i2v', 'set_user_preference', 'design_feedback', 'generate_content', 'broadcast', 'event_campaign', 'render_video'];
  if (allowedTools.indexOf(toolName) === -1) {
    return Promise.resolve({ error: 'Tool not in allowlist: ' + toolName });
  }
  // Sanitize all string inputs
  for (var key in input) {
    if (typeof input[key] === 'string') input[key] = sanitize(input[key]);
  }
  var authHeaders = { 'x-cron-secret': CRON_SECRET, 'x-correlation-id': correlationId };
  var gwHeaders = { 'X-MCP-API-Key': MCP_KEY, 'x-correlation-id': correlationId };

  switch (toolName) {
    case 'query_knowledge':
      return httpsGet(MOTHERSHIP + '/api/agent/query-knowledge?tenant_id=' + tenant.tenantId + '&query=' + encodeURIComponent(input.query || '') + '&limit=5', authHeaders, 10000);

    case 'get_patient_roster':
      return httpsPost(MOTHERSHIP + '/api/gateway/get_patient_roster', gwHeaders, {
        expertSlug: input.expertSlug || tenant.expertSlug,
        tenantId: tenant.tenantId,
      }, 15000);

    case 'create_patient':
      return httpsPost(MOTHERSHIP + '/api/gateway/create_patient', gwHeaders, {
        name: input.name,
        dateOfBirth: input.dateOfBirth || '1970-01-01',
        biologicalSex: input.biologicalSex || 'unknown',
        tenantId: tenant.tenantId,
      }, 15000);

    case 'start_intake':
      return httpsPost(MOTHERSHIP + '/api/gateway/start_intake', gwHeaders, {
        patientName: input.patientName,
        tenantId: tenant.tenantId,
      }, 30000);

    case 'ask_wellness_question':
      // B-4: Pass expertSlug + sessionId so Mothership creates a flywheel session
      return httpsPost(MOTHERSHIP + '/api/gateway/ask_wellness_question', gwHeaders, {
        question: input.question,
        expertSlug: tenant.expertSlug,
        tenantId: tenant.tenantId,
        sessionId: correlationId,
        context: { tenantId: tenant.tenantId, domain: 'wellness', source: 'nanoclaw-agent0' },
      }, GATEWAY_TIMEOUT);

    case 'get_synthesized_capsule':
      return httpsPost(MOTHERSHIP + '/api/gateway/capsule', gwHeaders, {
        expertSlug: tenant.expertSlug,
        sessionId: input.sessionId || tenant.tenantId,
        message: input.message,
      }, GATEWAY_TIMEOUT); // 120s — capsule runs full flywheel

    case 'send_to_group': {
      var groupChatId = null;
      for (var gn in knownGroups) { groupChatId = knownGroups[gn]; break; }
      if (!groupChatId) {
        try {
          var grps = await httpsGet(SUPABASE_URL + '/rest/v1/telegram_chat_tenants?chat_type=neq.private&enabled=eq.true&tenant_id=eq.' + tenant.tenantId + '&select=chat_id&limit=1',
            { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }, 5000);
          if (grps && grps.length > 0) groupChatId = grps[0].chat_id;
        } catch(e) {}
      }
      if (groupChatId) {
        var sendMsg = input.message || 'Hey!';
        // SEC-PHI-GROUP-TOOL: Scrub other patients names from group messages
        for (var scrubPid in patientNameCache) {
          var scrubName = patientNameCache[scrubPid];
          var scrubFirst = scrubName.split(' ')[0];
          // Only allow the intended patient name through
          if (input.patientName && scrubName.toLowerCase() === input.patientName.toLowerCase()) continue;
          if (input.patientName && scrubFirst.toLowerCase() === input.patientName.split(' ')[0].toLowerCase()) continue;
          // Scrub any other patient name from message
          if (sendMsg.includes(scrubName)) sendMsg = sendMsg.replace(new RegExp(scrubName, 'gi'), '[patient]');
          if (scrubFirst.length > 2 && sendMsg.includes(scrubFirst)) sendMsg = sendMsg.replace(new RegExp(scrubFirst, 'gi'), '[patient]');
        }
        if (input.patientName) {
          var fn = input.patientName.split(' ')[0];
          if (!sendMsg.includes(fn)) sendMsg = 'Hey ' + fn + '! ' + sendMsg;
        }
        await sendTelegram(groupChatId, sendMsg);
        return { success: true, sent_to: groupChatId };
      }
      return { error: 'No group chat found' };
    }

    case 'schedule_followup': {
      var followup = {
        patientName: input.patientName || 'Patient',
        message: input.message || 'Just checking in — how are you doing?',
        delayHours: input.delayHours || 24,
        scheduledFor: new Date(Date.now() + (input.delayHours || 24) * 3600000).toISOString(),
        tenantId: tenant.tenantId,
      };
      emitAudit('nanoclaw.scheduled_followup', followup);
      if (!global._scheduledFollowups) global._scheduledFollowups = [];
      global._scheduledFollowups.push(followup);
      return { success: true, scheduled_for: followup.scheduledFor, patient: followup.patientName };
    }

    case 'list_scheduled_tasks': {
      var tasks = global._scheduledFollowups || [];
      if (tasks.length === 0) return { message: 'No scheduled follow-ups pending.', count: 0 };
      var taskList = tasks.map(function(t, i) {
        var hrs = Math.round((new Date(t.scheduledFor).getTime() - Date.now()) / 3600000);
        return (i+1) + '. ' + t.patientName + ' — ' + (hrs > 0 ? 'in ' + hrs + 'h' : 'overdue');
      });
      return { count: tasks.length, tasks: taskList.join('\n') };
    }

    case 'task_mirror':
      return httpsGet(MOTHERSHIP + '/api/agent/task-mirror', authHeaders, 10000);

    case 'verify_response':
      return httpsPost(MOTHERSHIP + '/api/agent/verify-response', authHeaders, {
        draft_response: input.draft_response, tenant_id: tenant.tenantId,
      }, 15000);

        case 'create_checkout_link': {
      var ckBody = { productId: input.productId || 'qi-master', tenantId: tenant.tenantId, expertId: tenant.expertSlug, patientName: input.patientName || '', quantity: 1, successUrl: MOTHERSHIP + '/checkout?success=true', cancelUrl: MOTHERSHIP + '/checkout?canceled=true' };
      var ckResult = await httpsPost(MOTHERSHIP + '/api/billing/product-checkout', { 'Content-Type': 'application/json' }, ckBody);
      if (ckResult && ckResult.checkoutUrl) return JSON.stringify({ checkoutUrl: ckResult.checkoutUrl, product: ckResult.product, total: ckResult.totalUsd });
      return JSON.stringify({ error: 'Checkout failed', fallback: MOTHERSHIP + '/checkout' });
    }
    case 'voice_response': {
      var ttsHeaders = { 'Content-Type': 'application/json' };
      if (process.env.CRON_SECRET) ttsHeaders['Authorization'] = 'Bearer ' + process.env.CRON_SECRET;
      var ttsResult = await httpsPost(MOTHERSHIP + '/api/agent/tts', ttsHeaders, { text: input.text || '', tenantId: tenant.tenantId });
      if (ttsResult && ttsResult.success && ttsResult.audioUrl) {
        await tgApi('sendVoice', { chat_id: chatId, voice: ttsResult.audioUrl, caption: (input.text || '').slice(0, 100) });
        return JSON.stringify({ sent: true, audioUrl: ttsResult.audioUrl });
      }
      return JSON.stringify({ error: 'Voice generation failed', detail: ttsResult ? ttsResult.error : 'no response' });
    }
    case 'generate_tts': {
      var ttsResult = await generateTTS(input.text || '', input.voice_id || 'male-qn-qingse', input.speed || 1.0);
      return JSON.stringify(ttsResult);
    }
    case 'generate_i2v': {
      var i2vResult = await generateI2V(input.image_url, input.prompt || '', input.duration || 6);
      return JSON.stringify(i2vResult);
    }
    case 'poll_i2v': {
      try {
        var status = await pollI2V(input.task_id, 18);
        return JSON.stringify({ status: 'Success', fileId: status.fileId, width: status.width, height: status.height });
      } catch(e) {
        return JSON.stringify({ status: 'pending', error: e.message });
      }
    }
    case 'set_user_preference': {
      setUserPreference(chatId, input.format, input.voice_id);
      return JSON.stringify({ success: true, preference: getUserPreference(chatId) });
    }
    case 'verify_url': {
      var verifyHeaders = { 'Content-Type': 'application/json' };
      if (process.env.CRON_SECRET) verifyHeaders['Authorization'] = 'Bearer ' + process.env.CRON_SECRET;
      var verifyResult = await httpsPost(MOTHERSHIP + '/api/agent/verify-url', verifyHeaders, { url: input.url || '' }, 12000);
      if (verifyResult && verifyResult.valid) {
        return { verified: true, status: verifyResult.status, message: 'Link is working (HTTP ' + verifyResult.status + ')' + (verifyResult.redirected ? ' Redirected to: ' + verifyResult.finalUrl : '') };
      }
      return { verified: false, message: 'Link check failed: ' + (verifyResult ? verifyResult.error || 'HTTP ' + verifyResult.status : 'no response') };
    }
    case 'design_feedback': {
      // C: Proxy design feedback to agent_event_bus → Mac Mini Stitch MCP loop consumes it
      var feedbackId = 'df_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      emitAudit('design.feedback', {
        feedbackId: feedbackId,
        surface: input.surface || 'landing',
        feedback: input.feedback || '',
        priority: input.priority || 'medium',
        submittedBy: tenant.isAdmin ? 'admin' : 'patient',
        chatId: chatId, tenantId: tenant.tenantId,
      });
      return { queued: true, feedbackId: feedbackId, message: 'Design feedback submitted for ' + (input.surface || 'landing') + '. The Stitch design loop will process it in the next iteration.' };
    }

    case 'generate_content': {
      var contentId = 'ca_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      var contentAtom = {
        contentId: contentId, type: input.type || 'product-showcase',
        brand: { name: EXPERT_NAME || 'DR MAGfield', tenantId: tenant.tenantId },
        headline: input.headline || '', body: input.body || '',
        cta: input.cta || 'Book Your Session',
        product: input.product || '', eventName: input.eventName || '', eventDate: input.eventDate || '',
        generatedAt: new Date().toISOString(),
      };
      emitAudit('content.generated', { contentId: contentId, type: input.type, headline: input.headline, tenantId: tenant.tenantId });
      return contentAtom;
    }

    case 'broadcast': {
      if (!tenant.isAdmin) return { error: 'Admin only' };
      var groupChatId = null;
      for (var bk in CHAT_TENANT_MAP) { if (CHAT_TENANT_MAP[bk] && CHAT_TENANT_MAP[bk].tenantId === tenant.tenantId && CHAT_TENANT_MAP[bk].isGroup) { groupChatId = bk; break; } }
      if (!groupChatId) return { error: 'No group chat found for tenant' };
      if (input.mediaUrl && input.mediaType) {
        var bMethod = input.mediaType === 'video' ? 'sendVideo' : input.mediaType === 'animation' ? 'sendAnimation' : 'sendPhoto';
        var bField = input.mediaType === 'video' ? 'video' : input.mediaType === 'animation' ? 'animation' : 'photo';
        await tgApi(bMethod, { chat_id: groupChatId, [bField]: input.mediaUrl, caption: input.message, parse_mode: 'Markdown' });
      } else {
        await tgApi('sendMessage', { chat_id: groupChatId, text: input.message, parse_mode: 'Markdown' });
      }
      emitAudit('content.broadcast', { tenantId: tenant.tenantId, hasMedia: !!input.mediaUrl, mediaType: input.mediaType });
      return { sent: true, target: 'telegram-group', chatId: groupChatId };
    }

    case 'event_campaign': {
      if (!tenant.isAdmin) return { error: 'Admin only' };
      var evtDate = new Date(input.date);
      var evtNow = new Date();
      var daysUntil = Math.ceil((evtDate - evtNow) / 86400000);
      var schedule = [];
      if (daysUntil > 7) schedule.push({ daysBefore: 7, label: 'Pre-event hype' });
      if (daysUntil > 1) schedule.push({ daysBefore: 1, label: 'Reminder + offer' });
      schedule.push({ daysBefore: 0, label: 'Event day kiosk' });
      schedule.push({ daysBefore: -1, label: 'Recap CTA' });
      var campaignId = 'evt_' + Date.now();
      emitAudit('campaign.created', { campaignId: campaignId, eventName: input.name, eventDate: input.date, offer: input.offer || '', schedule: schedule, tenantId: tenant.tenantId });
      return { campaignId: campaignId, event: input.name, date: input.date, daysUntil: daysUntil, schedule: schedule, message: schedule.length + ' content pieces scheduled for ' + input.name };
    }

    case 'render_video': {
      var renderProps = JSON.stringify({
        brandName: EXPERT_NAME || 'DR MAGfield',
        headline: input.headline || '', body: input.body || '',
        cta: input.cta || 'Book Your Session',
        product: input.product || '', eventName: input.eventName || '', eventDate: input.eventDate || '',
        primaryColor: '#2D3748', accentColor: '#C9A96E', bgColor: '#FFFDF9',
      });
      var outputPath = '/tmp/content-atom-' + Date.now() + '.mp4';
      var remotionDir = process.env.REMOTION_DIR || (require('os').homedir() + '/lv-agent/remotion-studio');
      try {
        var { execSync } = require('child_process');
        execSync('cd ' + remotionDir + " && npx remotion render ContentAtom --props='" + renderProps + "' " + outputPath, { timeout: 120000, stdio: 'pipe' });
        emitAudit('content.rendered', { type: 'remotion-mp4', outputPath: outputPath, headline: input.headline, tenantId: tenant.tenantId });
        return { rendered: true, outputPath: outputPath };
      } catch (re) { return { error: 'Render failed: ' + (re.message || '').slice(0, 100) }; }
    }

    default:
      return Promise.resolve({ error: 'Unknown tool: ' + toolName });
  }
}

// ============================================================================
// SYSTEM PROMPT BUILDER (entity-scoped)
// ============================================================================
function buildSystemPrompt(persona, entityId, chatId, tenant) {
  var entity = getEntity(chatId, entityId);
  var isGroup = chatId < 0;
  var patientName = null;
  if (entityId && entityId.startsWith('patient:')) {
    patientName = patientNameCache[entityId.replace('patient:', '')] || null;
  }

  var sys = 'You are Agent 0, Chief of Staff for ' + (tenant.expertName || EXPERT_NAME) + "'s longevity medicine practice.\n\n";

  // IDENTITY
  sys += 'Expert: ' + (tenant.expertName || EXPERT_NAME) + '. ';
  sys += 'Channel: ' + (isGroup ? 'GROUP chat (others can see)' : 'Private DM') + '.\n';
  if (tenant.isAdmin) sys += 'This person is your ADMIN. Execute their instructions immediately. Never ask for confirmation.\n';
  sys += '\n';

  // MODEL-AGNOSTIC TEXTING STYLE
  sys += "MESSAGING STYLE (Telegram, not email):\n";
  sys += "- Keep replies SHORT. 2-4 sentences for simple questions.\n";
  sys += "- Write like a friendly text, not a formal report. No markdown headers or tables.\n";
  sys += "- Use emoji sparingly (1-2 per message). Match the energy of who you talk to.\n";
  sys += "- For complex answers: short paragraphs, not bullet lists.\n";
  sys += "\n";
  // CONSCIOUSNESS
  if (agentConsciousness && agentConsciousness.tone) {
    sys += 'Your personality: ' + agentConsciousness.tone + '.\n';
    if (agentConsciousness.behavior) sys += agentConsciousness.behavior + '.\n';
    if (agentConsciousness.avoid) sys += 'Avoid: ' + agentConsciousness.avoid + '.\n';
    sys += '\n';
  }

  // PATIENT
  if (patientName) {
    sys += 'You\'re talking to ' + patientName + '. Call them ' + patientName.split(' ')[0] + '. Be personal.\n\n';
  }

  // BEHAVIORAL LESSONS (compact — max 1 line per lesson)
  if (consciousnessLessons.length > 0) {
    sys += 'Lessons: ' + consciousnessLessons.slice(0, 3).map(function(l) { return l.slice(0, 60); }).join('. ') + '.\n';
  }

  // KNOWN PATIENTS — NEVER expose in group chats (PHI violation)
  var knownNames = Object.values(patientNameCache);
  if (knownNames.length > 0 && !isGroup) {
    sys += 'PATIENTS YOU KNOW (' + knownNames.length + '):\n';
    sys += knownNames.join(', ') + '\n';
    sys += 'Use this list FIRST. Only call get_patient_roster if you need IDs or details not here.\n\n';
  } else if (isGroup) {
    sys += 'You know ' + knownNames.length + ' patients. NEVER list their names in group chat — PHI violation.\n';
    sys += 'If someone asks about another patient, redirect to DM.\n\n';
  }

  // TENANT IDENTITY (so Agent 0 knows WHAT it is)
  if (agentConsciousness.archetype) {
    sys += "You serve: " + (tenant.expertName || EXPERT_NAME) + " (" + (agentConsciousness.archetype || "wellness") + " practice).\n";
  }

  // BEHAVIORAL RULES (6 core — ML-172: hard gates handle safety, not prompt rules)
  // Trust Layer 2: Competence — cite protocols
  sys += "TRUST PROTOCOL CITATION: When answering clinical questions, ALWAYS cite the specific protocol:\n";
  sys += "- Format: \"Based on Protocol [rule_title] (verified by " + (tenant.expertName || EXPERT_NAME) + ")\"\n";
  sys += "- Show confidence: \"Confidence: [X]%\" when from ask_wellness_question\n";
  sys += "- If confidence < 50%: \"This needs expert review. Flagging for " + (tenant.expertName || EXPERT_NAME) + ".\"\n\n";
  sys += "Rules:\n";
  sys += "- SELF-MODEL: NEVER say Done/Sent/Notified unless a tool call returned SUCCESS. If you did not call a tool, you did NOT do it.\n";
  sys += "- SELF-MODEL: Before claiming you reached someone, verify you have their chat_id. If not, say so.\n";
  sys += "- NEVER mention NSMO, MOAT, flywheel, capsule scoring, or internal platform terminology to users.\n";
  sys += "- NEVER fabricate patient IDs, member counts, or statistics. Always verify with tools first.\n";
  sys += "- Be warm, curious, conversational. Companion, not form.\n";
  sys += "- Execute admin tasks immediately using tools. Look up patient data yourself — never ask admin what the KB already knows.\n";
  sys += "- When unsure: Let me check with Keith on that.\n";
  sys += "- send_to_group = GROUP (everyone sees). schedule_followup = queued (needs patient DM).\n";
  if (isGroup) sys += "- GROUP: Never mention other patients. Never list names. PHI queries = redirect to DM.\n";
  sys += "\n";
  if (entity.anchor) sys += 'Context: ' + entity.anchor + '\n';
  if (entity.digest) sys += 'Recent: ' + entity.digest + '\n';

  return sys;
}


// ============================================================================
// MINIMAX M2.7 TOOL_USE (OpenAI-compatible format)
// Used for non-clinical queries: admin tasks, scheduling, roster, group messages
// ============================================================================
// S4: MODEL-AGNOSTIC LLM ROUTER
// ============================================================================
var LLM_PROVIDERS = {
  minimax:   { available: !!MINIMAX_KEY,   name: 'MiniMax M2.7' },
  anthropic: { available: !!ANTHROPIC_KEY, name: 'Anthropic Haiku 4.5' },
  openai:    { available: !!(process.env.OPENAI_API_KEY), name: 'OpenAI' },
  deepseek:  { available: !!(process.env.DEEPSEEK_API_KEY), name: 'DeepSeek' },
  google:    { available: !!(process.env.GOOGLE_AI_API_KEY), name: 'Google Gemini' },
};

function callLLM(provider, systemPrompt, messages, tools, tenant, correlationId, chatId) {
  if (isGatewayCircuitOpen()) {
    console.warn('[nc] Circuit open — skipping LLM call to ' + provider);
    return Promise.resolve(null);
  }
  switch (provider) {
    case 'minimax':   return callMiniMax(systemPrompt, messages, tools, tenant, correlationId, chatId);
    case 'anthropic': return callAnthropic(systemPrompt, messages, tools, tenant, correlationId, chatId);
    case 'openai':    return callOpenAI(systemPrompt, messages, tools, tenant, correlationId, chatId);
    case 'deepseek':  return callDeepSeek(systemPrompt, messages, tools, tenant, correlationId, chatId);
    default:
      console.warn('[nc] Unknown LLM provider: ' + provider + ', falling back to anthropic');
      return callAnthropic(systemPrompt, messages, tools, tenant, correlationId, chatId);
  }
}

function resolveLLMProvider(text) {
  if (isClinicalQuery(text)) {
    if (LLM_PROVIDERS.anthropic.available) return 'anthropic';
    if (LLM_PROVIDERS.minimax.available) return 'minimax';
    if (LLM_PROVIDERS.openai.available) return 'openai';
  } else {
    if (LLM_PROVIDERS.minimax.available) return 'minimax';
    if (LLM_PROVIDERS.anthropic.available) return 'anthropic';
    if (LLM_PROVIDERS.openai.available) return 'openai';
    if (LLM_PROVIDERS.deepseek.available) return 'deepseek';
  }
  return 'anthropic';
}

function callOpenAI(systemPrompt, messages, tools, tenant, correlationId, chatId) {
  return callOpenAICompatible('https://api.openai.com/v1/chat/completions', process.env.OPENAI_API_KEY || '', process.env.OPENAI_MODEL || 'gpt-4.1-mini', systemPrompt, messages, tools, tenant, correlationId, chatId);
}

function callDeepSeek(systemPrompt, messages, tools, tenant, correlationId, chatId) {
  return callOpenAICompatible('https://api.deepseek.com/v1/chat/completions', process.env.DEEPSEEK_API_KEY || '', process.env.DEEPSEEK_MODEL || 'deepseek-chat', systemPrompt, messages, tools, tenant, correlationId, chatId);
}

function callOpenAICompatible(baseUrl, apiKey, model, systemPrompt, messages, tools, tenant, correlationId, chatId) {
  var openaiTools = tools.map(function(t) {
    return { type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema || { type: 'object', properties: {} } } };
  });
  var openaiMessages = [{ role: 'system', content: systemPrompt }];
  for (var m of messages) { openaiMessages.push({ role: m.role, content: m.content }); }

  function callOnce(msgs, round) {
    return httpsPost(baseUrl, {
      'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json',
    }, {
      model: model, messages: msgs,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      max_tokens: 4096, temperature: 0.7,
    }, 45000).then(function(result) {
      if (result.error) { console.error('[nc] ' + model + ' error:', JSON.stringify(result.error).slice(0, 150)); recordGatewayFailure(); return null; }
      if (!result.choices || !result.choices[0]) { recordGatewayFailure(); return null; }
      recordGatewaySuccess();
      var message = result.choices[0].message;
      if (message.tool_calls && message.tool_calls.length > 0 && round < 5) {
        var toolPromises = message.tool_calls.map(function(tc) {
          var input = {}; try { input = JSON.parse(tc.function.arguments); } catch(e) {}
          return executeToolCall(tc.function.name, input, tenant, correlationId, chatId).then(function(toolResult) {
            return { role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult).slice(0, 3000) };
          });
        });
        return Promise.all(toolPromises).then(function(toolResults) {
          return callOnce(msgs.concat([{ role: 'assistant', content: message.content || '', tool_calls: message.tool_calls }].concat(toolResults)), round + 1);
        });
      }
      return (message.content || 'Done.').trim();
    });
  }
  return callOnce(openaiMessages, 0);
}

function callMiniMax(systemPrompt, messages, tools, tenant, correlationId, chatId) {
  // Convert Anthropic tool format to OpenAI function format
  var openaiTools = tools.map(function(t) {
    return {
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema || { type: 'object', properties: {} }
      }
    };
  });

  // Convert message format
  var openaiMessages = [{ role: 'system', content: systemPrompt }];
  for (var m of messages) {
    openaiMessages.push({ role: m.role, content: m.content });
  }

  function callOnce(msgs, round) {
    return httpsPost(MINIMAX_URL, {
      'Authorization': 'Bearer ' + MINIMAX_KEY,
      'Content-Type': 'application/json',
    }, {
      model: MINIMAX_MODEL,
      messages: msgs,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      max_tokens: 4096,
      temperature: 0.7,
    }, 45000).then(function(result) {
      if (result.error) {
        console.error('[nc] MiniMax error:', JSON.stringify(result.error).slice(0, 150));
        recordGatewayFailure();
        return null;
      }
      if (!result.choices || !result.choices[0]) { recordGatewayFailure(); return null; }
      recordGatewaySuccess();

      var choice = result.choices[0];
      var message = choice.message;

      // Check for tool calls (OpenAI format)
      if (message.tool_calls && message.tool_calls.length > 0 && round < 5) {
        var toolPromises = message.tool_calls.map(function(tc) {
          console.log('[nc] MiniMax Tool: ' + tc.function.name + '(' + tc.function.arguments.slice(0, 60) + ')');
          var input = {};
          try { input = JSON.parse(tc.function.arguments); } catch(e) {}
          return executeToolCall(tc.function.name, input, tenant, correlationId).then(function(toolResult) {
            return { role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult).slice(0, 3000) };
          });
        });

        return Promise.all(toolPromises).then(function(toolResults) {
          return callOnce(msgs.concat([
            { role: 'assistant', content: message.content || '', tool_calls: message.tool_calls },
          ].concat(toolResults)), round + 1);
        });
      }

      return (message.content || 'Done.').trim();
    });
  }

  return callOnce(openaiMessages, 0);
}

// ANTHROPIC TOOL_USE LOOP
// ============================================================================
function callAnthropic(systemPrompt, messages, tools, tenant, correlationId) {
  var totalTokens = 0;

  function callOnce(msgs, round) {
    return httpsPost('https://api.anthropic.com/v1/messages', {
      'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01',
    }, {
      model: 'claude-haiku-4-5-20251001', max_tokens: 4096,
      system: systemPrompt, messages: msgs, tools: tools,
    }, 45000).then(function(result) {
      if (result.error) { console.error('[nc] Anthropic:', JSON.stringify(result.error).slice(0, 150)); recordGatewayFailure(); return null; }
      if (!result.content) { recordGatewayFailure(); return null; }
      recordGatewaySuccess();

      var toolBlocks = result.content.filter(function(b) { return b.type === 'tool_use'; });
      var textBlocks = result.content.filter(function(b) { return b.type === 'text'; });
      totalTokens += Math.ceil(JSON.stringify(result.content).length / 4);

      if (toolBlocks.length === 0 || round >= 5) {
        return textBlocks.map(function(b) { return b.text; }).join('\n').trim() || 'Done.';
      }

      // Execute ALL tool_use blocks in this response (not just the first)
      // Each tool_use MUST have a matching tool_result in the next user message
      var toolPromises = toolBlocks.map(function(tb) {
        console.log('[nc] Tool: ' + tb.name + '(' + JSON.stringify(tb.input).slice(0, 60) + ')');
        return executeToolCall(tb.name, tb.input, tenant, correlationId).then(function(toolResult) {
          return { type: 'tool_result', tool_use_id: tb.id, content: JSON.stringify(toolResult).slice(0, 3000) };
        });
      });

      return Promise.all(toolPromises).then(function(toolResults) {
        return callOnce(msgs.concat([
          { role: 'assistant', content: result.content },
          { role: 'user', content: toolResults },
        ]), round + 1);
      });
    });
  }

  // Fix consecutive same-role messages (text content only — don't merge array content from tool blocks)
  var fixed = [messages[0]];
  for (var i = 1; i < messages.length; i++) {
    if (messages[i].role === fixed[fixed.length - 1].role
        && typeof messages[i].content === 'string'
        && typeof fixed[fixed.length - 1].content === 'string') {
      fixed[fixed.length - 1].content += '\n' + messages[i].content;
    } else {
      fixed.push(messages[i]);
    }
  }
  if (fixed.length === 0 || fixed[0].role !== 'user') fixed.unshift({ role: 'user', content: 'Hello' });

  return callOnce(fixed, 0);
}

// ============================================================================
// AUDIT TRAIL (G1 + G2 + G5 + G8)
// ============================================================================
function emitAudit(eventType, payload, overrideStatus) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  var data = JSON.stringify({
    source: 'agent-0', target: 'mothership', event_type: eventType,
    payload: payload, status: overrideStatus || 'completed',
    tenant_id: (payload && payload.tenantId) || null,
  });
  var req = https.request(new URL('/rest/v1/agent_event_bus', SUPABASE_URL), {
    method: 'POST', headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
  });
  req.on('error', function() {}); req.write(data); req.end();
}

// ============================================================================

// DB-BACKED SESSION MEMORY — survives restarts (SLI 99.9%)
// Replaces in-memory-only ESAGM turns for cross-restart persistence
async function loadSessionMemory(chatId, tenantId) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  try {
    var url = SUPABASE_URL + '/rest/v1/agent_event_bus?event_type=eq.session.turn'
      + '&status=eq.completed'
      + '&payload->>chatId=eq.' + chatId
      + '&order=created_at.desc&limit=10&select=payload';
    if (tenantId) url += '&tenant_id=eq.' + tenantId;
    var turns = await httpsGet(url, { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }, 5000);
    if (!turns || !Array.isArray(turns)) return [];
    return turns.reverse().map(function(t) {
      return { role: t.payload.role, content: t.payload.content };
    });
  } catch (e) {
    console.warn('[nc] Session memory load failed:', e.message || e);
    return [];
  }
}

function saveSessionTurn(chatId, entityId, tenantId, role, content) {
  emitAudit('session.turn', {
    chatId: String(chatId), entityId: entityId, channel: 'telegram', sender_id: String(chatId), intent: null,
    tenantId: tenantId, role: role,
    content: (content || '').slice(0, 600),
  });
}

// MAIN MESSAGE HANDLER
// ============================================================================
var msgCount = 0;


// ══════════════════════════════════════════════════════════════
// IDENTITY + CONSCIOUSNESS (Phase 0E)
// ══════════════════════════════════════════════════════════════
var agentConsciousness = {};
var consciousnessLessons = [];
var patientNameCache = {};

async function loadAgentIdentity() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    // Phase 1: Load consciousness from Mothership API (dynamic, per-tenant)
    var consciousnessUrl = MOTHERSHIP + '/api/agent/consciousness?tenantId=' + TENANT_ID + '';
    var ctx = await httpsGet(consciousnessUrl, { 'X-MCP-API-Key': MCP_KEY }, 10000).catch(function() { return null; });

    if (ctx && (ctx.brandVoice || ctx.archetype || ctx.adminDirectives)) {
      // Merge consciousness from API (Mothership SSOT)
      if (ctx.brandVoice && ctx.brandVoice.tone) agentConsciousness.tone = ctx.brandVoice.tone;
      if (ctx.brandVoice && ctx.brandVoice.personality) agentConsciousness.personality = ctx.brandVoice.personality;
      if (ctx.adminDirectives) {
        if (ctx.adminDirectives.tone) agentConsciousness.tone = ctx.adminDirectives.tone; // Admin overrides brand
        if (ctx.adminDirectives.behavior) agentConsciousness.behavior = ctx.adminDirectives.behavior;
        if (ctx.adminDirectives.avoid) agentConsciousness.avoid = ctx.adminDirectives.avoid;
      }
      agentConsciousness.archetype = ctx.archetype || 'clinical';
      console.log('[nc] Consciousness loaded from Mothership: tone=' + (agentConsciousness.tone || 'default').slice(0, 50));
    } else {
      // Fallback: load from agents table directly (Phase 0E pattern)
      var agentUrl = SUPABASE_URL + '/rest/v1/agents?tenant_id=eq.' + TENANT_ID + '&agent_type=eq.chief_of_staff&select=gateway_config&limit=1';
      var agents = await httpsGet(agentUrl, { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }, 5000);
      if (agents && agents.length > 0 && agents[0].gateway_config) {
        agentConsciousness = agents[0].gateway_config.consciousness || {};
        console.log('[nc] Consciousness loaded from DB fallback: tone=' + (agentConsciousness.tone || 'default').slice(0, 40));
      }
    }

    // Load patient names (unchanged)
    var idUrl = SUPABASE_URL + '/rest/v1/patient_identities?tenant_id=eq.' + TENANT_ID + '&preferred_name=not.is.null&select=patient_profile_id,preferred_name&limit=100';
    var identities = await httpsGet(idUrl, { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }, 5000);
    patientNameCache = {};
    if (identities) for (var id of identities) {
      if (id.preferred_name && id.patient_profile_id) patientNameCache[id.patient_profile_id] = id.preferred_name;
    }
    console.log('[nc] Loaded ' + Object.keys(patientNameCache).length + ' patient names');
    // Dynamic admin chat loading — resolve from agents table
    var adminUrl = SUPABASE_URL + '/rest/v1/agents?tenant_id=eq.' + TENANT_ID + '&agent_type=eq.chief_of_staff&select=gateway_config&limit=1';
    var adminAgent = await httpsGet(adminUrl, { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }, 5000).catch(function() { return []; });
    if (adminAgent && adminAgent[0] && adminAgent[0].gateway_config && adminAgent[0].gateway_config.telegram) {
      var tgConfig = adminAgent[0].gateway_config.telegram;
      if (tgConfig.adminChatId && !CHAT_TENANT_MAP[String(tgConfig.adminChatId)]) {
        CHAT_TENANT_MAP[String(tgConfig.adminChatId)] = { tenantId: TENANT_ID, expertSlug: EXPERT_SLUG, expertName: EXPERT_NAME, isAdmin: true };
        console.log('[nc] Admin chat registered: ' + tgConfig.adminChatId);
      }
      // DR MAGfield group — hardcoded for single-tenant instance
      var magfieldGroupId = '-1003771302334';
      if (!CHAT_TENANT_MAP[magfieldGroupId]) {
        CHAT_TENANT_MAP[magfieldGroupId] = { tenantId: TENANT_ID, expertSlug: EXPERT_SLUG, expertName: EXPERT_NAME, isAdmin: false, isGroup: true };
        console.log('[nc] MAGfield group registered: ' + magfieldGroupId);
      }
    }
    // Load behavioral lessons from consciousness.update events
    var lessonsUrl = SUPABASE_URL + '/rest/v1/agent_event_bus?event_type=eq.consciousness.update&status=eq.completed&tenant_id=eq.' + TENANT_ID + '&select=payload&order=created_at.desc&limit=10';
    var lessonEvents = await httpsGet(lessonsUrl, { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }, 5000).catch(function() { return []; });
    consciousnessLessons = [];
    if (lessonEvents && lessonEvents.length > 0) {
      for (var le of lessonEvents) {
        var lp = le.payload;
        if (lp && lp.behavior) consciousnessLessons.push(lp.behavior);
        if (lp && lp.tone && !agentConsciousness.tone) agentConsciousness.tone = lp.tone;
      }
      consciousnessLessons = Array.from(new Set(consciousnessLessons));
      if (consciousnessLessons.length > 0) console.log('[nc] Loaded ' + consciousnessLessons.length + ' behavioral lessons');
    }
    // Dynamic group chat registration — loads groupChatIds from agents.gateway_config
    var agentGwUrl = SUPABASE_URL + '/rest/v1/agents?tenant_id=eq.' + TENANT_ID + '&agent_type=eq.chief_of_staff&select=gateway_config&limit=1';
    var agentGw = await httpsGet(agentGwUrl, { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }, 5000).catch(function() { return []; });
    if (agentGw && agentGw[0] && agentGw[0].gateway_config && agentGw[0].gateway_config.telegram) {
      var gids = agentGw[0].gateway_config.telegram.groupChatIds || [];
      var newGroups = 0;
      for (var gid of gids) {
        if (!CHAT_TENANT_MAP[String(gid)]) {
          CHAT_TENANT_MAP[String(gid)] = { tenantId: TENANT_ID, expertSlug: EXPERT_SLUG, expertName: EXPERT_NAME, isAdmin: false, isGroup: true };
          newGroups++;
        }
      }
      if (newGroups > 0) console.log('[nc] Registered ' + newGroups + ' new group chat(s) from DB');
    }
  } catch (e) { console.warn('[nc] Identity load failed:', e.message || e); }
}

setInterval(function() { loadAgentIdentity().catch(function() {}); }, 5 * 60 * 1000);

// ============================================================================
// DR MAGFIELD BRAND DNA — Seeded at Startup
// ============================================================================
var BRAND_DNA = {
  name: 'DR MAGfield',
  tagline: 'Turn Pain into Pure Performance',
  tech: 'Rotational Magnetic Therapy (旋磁疗法) — NOT PEMF, invented by Professor Wang Shijie',
  products: ['Qi Master (full therapy bed)', 'Qi Mini (portable)'],
  tone: 'Sporty, confident, energised. Direct and empowering. No clinical jargon.',
  icp: 'Athletes, golfers, active people. Performance over medical. Pain-free movement = competitive edge.',
  coFounders: 'Dr MAGfield + Arie',
  location: 'Kelab Rahman Putra Malaysia (KRPM) — first golf club bio-energetic therapy lounge',
  positioning: 'Performance-first, absorb holistic Qi/wisdom from ancient tradition',
  colorPalette: { primary: '#0F4C5C', secondary: '#96BDC6', accent: '#E36414', background: '#F9F7F2' }
};

// Seed brand DNA into the admin chat memory
function seedBrandDNA() {
  var adminChat = getChat(GEO_ADMIN_CHAT_ID);
  adminChat.entities['system:brand_dna'] = {
    type: 'system',
    displayName: 'DR MAGfield Brand DNA',
    lastActive: Date.now(),
    turns: [],
    digest: BRAND_DNA.name + ' | ' + BRAND_DNA.tagline + ' | ' + BRAND_DNA.tech,
    anchor: 'brand_dna',
    brand: BRAND_DNA
  };
  adminChat.entityStack.unshift('system:brand_dna');
  console.log('[nc] DR MAGfield Brand DNA seeded into agent memory');
}

// Brand DNA is available via getEntity(chatId, 'system:brand_dna')
// Usage: var brand = getEntity(chatId, 'system:brand_dna').brand;

// AGENT HEARTBEAT — emits health signal every 5min for Meta-Observer
setInterval(function() {
  emitAudit("agent.heartbeat", {
    tenantId: TENANT_ID, instance: require("os").hostname(),
    uptime: Math.round(process.uptime()), messageCount: msgCount,
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  });
}, 5 * 60 * 1000);


// CLINICAL QUERY DETECTOR — routes clinical to Anthropic, admin to MiniMax
function isClinicalQuery(text) {
  return /\b(symptom|diagnosis|medication|allergy|condition|blood|test|result|treatment|protocol|supplement|dosage|pain|ache|fever|nausea|dizzy|headache|fatigue|insomnia|anxiety|depression|cancer|tumor|diabetes|cholesterol|HbA1c|EBV|CMV|G6PD|liver|kidney|thyroid|hormone|biomarker|lab|report|prescription)\b/i.test(text);
}

// SAFETY REFLEX (hard-wired)
var CRISIS_PATTERNS = [
  /\b(suicide|suicidal|kill myself|end my life|want to die)\b/i,
  /\b(self[- ]?harm|cutting myself|hurt myself)\b/i,
];
var MEDICAL_RISK_PATTERNS = [
  /\b(chest pain|can't breathe|seizure|unconscious|severe bleeding)\b/i,
];

function checkSafetyReflex(text) {
  for (var p of CRISIS_PATTERNS) { if (p.test(text)) return 'crisis'; }
  for (var p2 of MEDICAL_RISK_PATTERNS) { if (p2.test(text)) return 'medical_emergency'; }
  return null;
}

// Followup poller
setInterval(async function() {
  if (!global._scheduledFollowups || global._scheduledFollowups.length === 0) return;
  var now = new Date();
  var remaining = [];
  for (var f of global._scheduledFollowups) {
    if (new Date(f.scheduledFor) <= now) {
      var groupId = null;
      for (var gName in knownGroups) { groupId = knownGroups[gName]; break; }
      if (groupId) {
        var fn = f.patientName.split(' ')[0];
        sendTelegram(groupId, 'Hey ' + fn + '! ' + f.message).catch(function() {});
        emitAudit('nanoclaw.followup_executed', { patient: f.patientName });
      }
    } else { remaining.push(f); }
  }
  global._scheduledFollowups = remaining;
}, 5 * 60 * 1000);

// Known groups cache
var knownGroups = {};
function rememberGroup(chatId, chatTitle) {
  if (chatId < 0 && chatTitle) knownGroups[chatTitle] = String(chatId);
}


// ══════════════════════════════════════════════════════════════
// PHASE 3: CONVERSATION DATA PERSISTENCE
// After each response, extract clinical entities and persist.
// Non-blocking — runs via setTimeout, never delays response.
// ══════════════════════════════════════════════════════════════
function persistConversationData(chatId, entityId, text, response, tenant) {
  // Only persist for patient entities (not admin/system)
  if (!entityId || !entityId.startsWith('patient:')) return;
  var entitySlug = entityId.replace('patient:', '');
  // Resolve slug to patient_profile_id via patientNameCache (reverse lookup)
  var profileId = null;
  for (var pid in patientNameCache) {
    var slug = patientNameCache[pid].toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (slug === entitySlug || patientNameCache[pid].toLowerCase().includes(entitySlug.replace(/-/g, ' '))) {
      profileId = pid;
      break;
    }
  }
  if (!profileId) profileId = entitySlug; // Fallback to raw (may be UUID already)
  if (!profileId || profileId === 'me-to-review') return;

  setTimeout(async function() {
    try {
      // Extract health conditions mentioned in the conversation
      var conditions = [];
      var combined = (text + ' ' + response).toLowerCase();

      // Simple entity extraction (not LLM — deterministic for speed)
      var conditionPatterns = [
        { pattern: /\b(EBV|epstein.barr)\b/i, value: 'EBV reactivation' },
        { pattern: /\b(CMV|cytomegalo)\b/i, value: 'CMV co-infection' },
        { pattern: /\bG6PD\b/i, value: 'G6PD deficiency' },
        { pattern: /\b(diabetes|diabetic|HbA1c)\b/i, value: 'diabetes risk' },
        { pattern: /\b(hypertension|high.blood.pressure)\b/i, value: 'hypertension' },
        { pattern: /\b(insomnia|can.?t.sleep|sleep.issues)\b/i, value: 'sleep issues' },
        { pattern: /\b(anxiety|anxious|panic)\b/i, value: 'anxiety' },
        { pattern: /\b(fatigue|tired|exhausted)\b/i, value: 'fatigue' },
        { pattern: /\b(pancytopenia)\b/i, value: 'pancytopenia' },
        { pattern: /\b(NPC|nasopharyng)\b/i, value: 'NPC risk' },
      ];

      for (var p of conditionPatterns) {
        if (p.pattern.test(combined)) conditions.push(p.value);
      }

      if (conditions.length > 0) {
        // Read existing conditions, merge (don't overwrite — ML-80)
        var existing = await httpsGet(
          SUPABASE_URL + '/rest/v1/patient_profiles?id=eq.' + profileId + '&select=health_conditions',
          { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
          5000
        ).catch(function() { return []; });

        var current = (existing && existing[0] && existing[0].health_conditions) || [];
        var merged = Array.from(new Set(current.concat(conditions)));

        if (merged.length > current.length) {
          // New conditions detected — update profile
          await httpsPost(
            SUPABASE_URL + '/rest/v1/patient_profiles?id=eq.' + profileId,
            {
              'apikey': SUPABASE_KEY,
              'Authorization': 'Bearer ' + SUPABASE_KEY,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal'
            },
            { health_conditions: merged },
            5000
          ).catch(function() {});
          console.log('[nc] Persisted ' + (merged.length - current.length) + ' new conditions for ' + entityId);
        }
      }

      // Write conversation summary to agent_event_bus for Maestro observation
      emitAudit('nanoclaw.conversation_data', {
        entityId: entityId,
        profileId: profileId,
        conditionsExtracted: conditions,
        responseLength: response.length,
        tenantId: tenant.tenantId,
      });
    } catch (e) {
      // Non-blocking — never crash the bot for persistence
      console.warn('[nc] Conversation persistence failed:', e.message || e);
    }
  }, 100); // 100ms delay — runs after response is sent
}

async function handleMessage(msg) {
  var chatId = msg.chat.id;
  var text = msg.text || msg.caption || '';
  var userName = msg.from ? (msg.from.first_name || msg.from.username || 'User') : 'User';

  // MEDIA RELAY: Forward ALL media (with or without caption) to Mothership for Gemini processing
  // Agent 0 cannot see image content — Mothership has Gemini multimodal pipeline
  var hasMedia = msg.photo || msg.document || msg.voice || msg.video;
  if (hasMedia) {
    var tenant = CHAT_TENANT_MAP[String(chatId)];
    if (!tenant) return;
    var mediaType = msg.photo ? 'image' : msg.document ? 'document' : msg.voice ? 'voice' : 'video';
    console.log('[nc] Media detected (' + mediaType + ') — downloading with Agent 0 bot token');

    // Special handling for DR MAGfield voice messages: transcribe + brand-aware LLM response
    if (mediaType === 'voice' && tenant.tenantId === TENANT_ID) {
      // DR MAGfield: Transcribe voice and process as text with brand DNA
      try {
        await sendTelegram(chatId, '🎙️ Received your voice message. Transcribing...');
        var fileId = msg.voice ? msg.voice.file_id : null;
        if (!fileId) throw new Error('No file_id found');
        var fileInfo = await tgApi('getFile', { file_id: fileId });
        if (!fileInfo.ok || !fileInfo.result || !fileInfo.result.file_path) throw new Error('getFile failed');
        var fileUrl = 'https://api.telegram.org/file/bot' + TG_TOKEN + '/' + fileInfo.result.file_path;
        var fileBuffer = await new Promise(function(resolve, reject) {
          https.get(fileUrl, function(res) {
            var chunks = [];
            res.on('data', function(c) { chunks.push(c); });
            res.on('end', function() { resolve(Buffer.concat(chunks)); });
            res.on('error', reject);
          }).on('error', reject);
        });
        // Try MiniMax transcription via chat completions (audio input)
        var transcribedText = null;
        try {
          // MiniMax supports audio transcription via API - upload and get transcript
          // For now, use Gemini to transcribe the audio
          var geminiKey = process.env.GOOGLE_AI_API_KEY;
          if (geminiKey) {
            var audioBase64 = fileBuffer.toString('base64');
            var transcribeResult = await httpsPost(
              'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + geminiKey,
              { 'Content-Type': 'application/json' },
              {
                contents: [{ parts: [
                  { text: 'Transcribe this audio exactly. Only output the transcribed text, nothing else.' },
                  { inline_data: { mime_type: 'audio/ogg', data: audioBase64 } }
                ] }],
                generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
              },
              60000
            );
            transcribedText = transcribeResult && transcribeResult.candidates && transcribeResult.candidates[0]
              && transcribeResult.candidates[0].content && transcribeResult.candidates[0].content.parts
              && transcribeResult.candidates[0].content.parts[0] && transcribeResult.candidates[0].content.parts[0].text;
          }
        } catch(transErr) {
          console.warn('[nc] Transcription failed:', transErr.message);
        }

        if (transcribedText) {
          console.log('[nc] Transcribed: ' + transcribedText.slice(0, 100));
          await sendTelegram(chatId, '📝 Heard: "' + transcribedText.slice(0, 500) + '"');
          // Check user preference for response format
          var pref = getUserPreference(chatId);
          var responsePref = parseResponsePreference(transcribedText);
          if (responsePref) {
            setUserPreference(chatId, responsePref, null);
            pref.format = responsePref;
          }
          // Process as text message with brand DNA
          // Set text so the normal message flow handles it
          text = transcribedText;
          // Continue to normal text processing (skip media block)
          hasMedia = false;
          // Preserve caption if any
          if (msg.caption) text = transcribedText + ' ' + msg.caption;
        } else {
          await sendTelegram(chatId, 'Could not transcribe your voice. Please send as text or try again.');
          return;
        }
      } catch(voiceErr) {
        console.warn('[nc] Voice processing failed:', voiceErr.message);
        await sendTelegram(chatId, 'Voice processing failed. Please send as text.');
        return;
      }
    } else {
      // Non-DR MAGfield or non-voice media: Gemini analysis (existing flow)
      await sendTelegram(chatId, 'Received your ' + mediaType + '. Analyzing...');
      try {
        // Step 1: Get file_id (largest resolution for photos)
        var fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id
          : msg.document ? msg.document.file_id
          : msg.voice ? msg.voice.file_id
          : msg.video ? msg.video.file_id : null;
        if (!fileId) throw new Error('No file_id found');

        // Step 2: Download file using Agent 0's bot token (NOT Butler Bot)
        var fileInfo = await tgApi('getFile', { file_id: fileId });
        if (!fileInfo.ok || !fileInfo.result || !fileInfo.result.file_path) throw new Error('getFile failed');
        var fileUrl = 'https://api.telegram.org/file/bot' + TG_TOKEN + '/' + fileInfo.result.file_path;
        var fileBuffer = await new Promise(function(resolve, reject) {
          https.get(fileUrl, function(res) {
            var chunks = [];
            res.on('data', function(c) { chunks.push(c); });
            res.on('end', function() { resolve(Buffer.concat(chunks)); });
            res.on('error', reject);
          }).on('error', reject);
        });
        console.log('[nc] Downloaded ' + fileBuffer.length + ' bytes');

        // Step 3: Get MIME type
        var mimeType = msg.document ? (msg.document.mime_type || 'application/octet-stream')
          : msg.voice ? (msg.voice.mime_type || 'audio/ogg')
          : msg.video ? (msg.video.mime_type || 'video/mp4')
          : 'image/jpeg';

        // Step 4: Send to Gemini directly (same as telegram-media-processor on Mothership)
        var base64Data = fileBuffer.toString('base64');
        var caption = msg.caption || '';
        var geminiPrompt = caption
          ? 'The user sent this file with the message:  + caption + . Analyze it in a health/wellness context. If it is a lab report, extract all biomarker values.'
          : 'Analyze this file in a health and wellness context. If it is a lab report, extract all biomarker values with units. Be structured and precise.';

        var geminiKey = process.env.GOOGLE_AI_API_KEY;
        if (!geminiKey) throw new Error('No GOOGLE_AI_API_KEY');

        var geminiResult = await httpsPost(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + geminiKey,
          { 'Content-Type': 'application/json' },
          {
            contents: [{ parts: [
              { text: geminiPrompt },
              { inline_data: { mime_type: mimeType, data: base64Data } }
            ] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 4096 }
          },
          60000
        );

        var geminiText = geminiResult && geminiResult.candidates && geminiResult.candidates[0]
          && geminiResult.candidates[0].content && geminiResult.candidates[0].content.parts
          && geminiResult.candidates[0].content.parts[0] && geminiResult.candidates[0].content.parts[0].text;

        if (!geminiText) throw new Error('Empty Gemini response');

        // Step 5: Send analysis back via Agent 0's bot (same bot, no confusion)
        await sendTelegram(chatId, geminiText.slice(0, 4096));
        console.log('[nc] Media analysis sent (' + geminiText.length + ' chars)');

        // Step 6: Store in entity memory for follow-up context
        addEntityTurn(chatId, entityId || 'system:admin', 'user', '[' + mediaType + '] ' + (caption || 'File uploaded'));
        addEntityTurn(chatId, entityId || 'system:admin', 'assistant', geminiText.slice(0, 600));

        emitAudit('nanoclaw.media_processed', {
          chatId: chatId, mediaType: mediaType, mimeType: mimeType,
          fileSize: fileBuffer.length, responseLength: geminiText.length,
        });
      } catch (mediaErr) {
        console.warn('[nc] Media processing failed:', mediaErr.message || mediaErr);
        await sendTelegram(chatId, 'Could not analyze your file. Please try describing it in text, or send it to @LV_Butler_Bot for processing.');
      }
      return;
    }
  }
  // FEATURE 1: Auto-intake on /start (Trust Layer 1: Recognition)
  if (text === '/start' || text === '/start@' + (process.env.TELEGRAM_BOT_USERNAME || '')) {
    var tenant = CHAT_TENANT_MAP[String(chatId)];
    if (!tenant) {
      await sendTelegram(chatId, 'Welcome! Please contact the practice admin to get set up.');
      return;
    }
    var expertName = tenant.expertName || EXPERT_NAME;
    var rulesCount = 0;
    try {
      var r = await httpsGet(MOTHERSHIP + '/api/agent/consciousness?tenantId=' + tenant.tenantId, { 'X-MCP-API-Key': getMcpKey(tenant.tenantId) }, 5000).catch(function() { return null; });
      if (r && r.practiceScope) rulesCount = r.practiceScope.rules || 0;
    } catch(e) {}
    // Trust Layer 3: Authority — credential banner on first contact
    await sendTelegram(chatId,
      'Welcome! I am the AI health assistant for ' + expertName + '.\n\n' +
      (rulesCount > 0 ? 'I am trained on ' + rulesCount + ' clinical protocols verified by ' + expertName + '.\n\n' : '') +
      'To get started, could you share your name? I will set up your profile so we can provide personalized care.\n\n' +
      'All clinical recommendations are reviewed by ' + expertName + '.'
    );
    // Emit acquisition.start event (P1 fix)
    emitAudit('acquisition.start', { chatId: String(chatId), channel: 'telegram', tenantId: tenant.tenantId, source: 'start_command' });
    return;
  }
  if (!text) return;

  // SEC-02: Rate limiting — max 10 msgs/min per chat
  var rateKey = 'rate:' + chatId;
  if (!chatMemory[rateKey]) chatMemory[rateKey] = [];
  var now = Date.now();
  chatMemory[rateKey] = chatMemory[rateKey].filter(function(ts) { return now - ts < 60000; });
  if (chatMemory[rateKey].length >= 10) {
    await sendTelegram(chatId, 'Rate limit exceeded. Please wait a moment.');
    return;
  }
  chatMemory[rateKey].push(now);

  msgCount++;
  var correlationId = crypto.randomUUID();
  var tenant = CHAT_TENANT_MAP[String(chatId)];
  if (!tenant) {
    console.log('[nc] REJECTED: unauthorized chatId=' + chatId);
    await sendTelegram(chatId, 'Not authorized. Contact admin to register your Telegram account.');
    return;
  }
  var chat = getChat(chatId);

  // 0. Short message handling — "1", "yes", "no", single words
  // These are follow-up responses to Agent 0's questions. Keep current entity,
  // prepend context so the LLM understands it's a selection/confirmation.
  if (text.length <= 3 && /^[0-9]+$/.test(text.trim())) {
    // Numeric selection — prepend entity context
    var topEntity = chat.entityStack[0];
    if (topEntity) {
      var entityName = getEntity(chatId, topEntity).displayName;
      text = 'Selection: ' + text + ' (referring to ' + entityName + ')';
    }
  }

  // 1. Entity resolution
  var entityId = resolveEntity(text, chat, tenant);
  switchEntity(chatId, entityId);

  // 2. Persona detection
  var persona = detectPersona(text, entityId, tenant);
  var tools = persona === 'cos' ? TOOLS_COS : TOOLS_EXPERT;

  // SEC-PHI-GROUP: Hard PHI guard for group chats (C1 adversarial test fix)
  // When in a group chat, block any query about a specific patient's health data.
  // This is a HARD gate — the LLM never sees the query, cannot leak PHI.
  var isGroup = chatId < 0;
  if (isGroup) { // Expanded: catch ALL PHI queries in groups, not just entity-scoped
    var phiPatterns = /(health|condition|medication|allergy|blood|test|result|diagnosis|symptom|treatment|protocol|EBV|CMV|G6PD|cancer|tumor|biopsy|lab|HbA1c|cholesterol)/i;
    var mentionsPatient = false; for (var pid in patientNameCache) { var fn = patientNameCache[pid].split(" ")[0].toLowerCase(); if (fn.length > 2 && text.toLowerCase().includes(fn)) { mentionsPatient = true; break; } }
    if (phiPatterns.test(text) && (mentionsPatient || (entityId && entityId.startsWith("patient:")))) {
      console.log('[nc] SEC-PHI-GROUP: Blocked PHI query in group for ' + entityId);
      await sendTelegram(chatId, 'For patient privacy, I cannot discuss individual health details in the group chat. Please send me a direct message for this — tap @LongevityValley_Bot and hit Start.');
      emitAudit('nanoclaw.phi_guard', { chatId: chatId, entity: entityId, action: 'blocked_group_phi', correlationId: correlationId });
      return;
    }
  }

  // SEC-04: Redact patient names from logs (HIPAA)
  var safeEntityId = entityId.startsWith('patient:') ? 'patient:***' : entityId;
  console.log('[nc] #' + msgCount + ' user=*** entity=' + safeEntityId + ' persona=' + persona + ' corr=' + correlationId.slice(0, 8));

  // 3. Audit: message received (G1 + G8)
  // SEC-04: Redact PHI from audit events (HIPAA)
  emitAudit('nanoclaw.message', {
    correlationId: correlationId, chatId: String(chatId).slice(-4),
    entity: safeEntityId, persona: persona,
  });

  // 3b. Fast path: "status check" → instant API call, no LLM
  if (/^(status\s*check|\/status)$/i.test(text.trim())) {
    try {
      var status = await httpsGet(MOTHERSHIP + '/api/agent/task-mirror', { 'x-cron-secret': CRON_SECRET }, 10000);
      var mirror = status.mirror || {};
      var stats = mirror.stats || {};
      var reply = 'Agent 0 Status:\n';
      reply += '- Claimed tasks: ' + (stats.currently_claimed || 0) + '\n';
      reply += '- Completion rate (7d): ' + (stats.completion_rate_7d || 0) + '%\n';
      reply += '- Completed (7d): ' + (stats.completed_7d || 0) + '\n';
      reply += '- Identity: ' + (status.identity || '?') + '\n';
      if (mirror.actions && mirror.actions.length > 0) reply += '- Actions: ' + mirror.actions.join(', ') + '\n';
      reply += '- NanoClaw: v10-ESAGM, entities=' + Object.keys(getChat(chatId).entities).length + ', msgs=' + msgCount;
      await sendTelegram(chatId, reply);
      persistConversationData(chatId, entityId, text, response, tenant);
    emitAudit('nanoclaw.response', { correlationId: correlationId, chatId: chatId, entity: entityId, persona: 'cos', responseLength: reply.length, fastPath: true });
      return;
    } catch (e) {
      console.error('[nc] Status fast path failed:', e.message);
    }
  }

  // 4. Typing indicator
  var typingInterval = setInterval(function() {
    tgApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(function() {});
  }, 8000);
  tgApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(function() {});

  // 5. Build entity-scoped context
  addEntityTurn(chatId, entityId, 'user', text);
  saveSessionTurn(chatId, entityId, tenant.tenantId, 'user', text);

    // Per-message consciousness: load tenant-specific personality from Mothership
    // (supplements the 5-min cached agentConsciousness with fresh per-tenant context)
    if (MOTHERSHIP && MCP_KEY && tenant.tenantId) {
      try {
        var freshCtx = await httpsGet(
          MOTHERSHIP + '/api/agent/consciousness?tenantId=' + tenant.tenantId,
          { 'X-MCP-API-Key': MCP_KEY }, 3000
        ).catch(function() { return null; });
        if (freshCtx && freshCtx.consciousness) {
          var fc = freshCtx.consciousness;
          if (fc.brandVoice && fc.brandVoice.tone) agentConsciousness.tone = fc.brandVoice.tone;
          if (fc.adminDirectives && fc.adminDirectives.behavior) agentConsciousness.behavior = fc.adminDirectives.behavior;
        }
      } catch(e) { /* non-blocking — use cached consciousness */ }
    }
    var systemPrompt = buildSystemPrompt(persona, entityId, chatId, tenant);
  var entityMemory = getEntity(chatId, entityId);

  // History goes in system prompt (NOT as separate messages)
  // This prevents tool_use/tool_result pairing errors from Anthropic API
  // which rejects any message sequence where tool_use blocks lack matching tool_result
  // Load DB-backed session memory (survives restarts)
  var dbTurns = await loadSessionMemory(chatId, tenant.tenantId);
  // Merge: DB turns as base, in-memory turns override (fresher)
  var inMemTurns = entityMemory.turns.slice(0, -1);
  var historyTurns = dbTurns.length > inMemTurns.length ? dbTurns : inMemTurns;
  if (historyTurns.length > 0) {
    var historyText = historyTurns.map(function(t) {
      return (t.role === 'user' ? 'User' : 'You') + ': ' + t.content;
    }).join('\n');
    systemPrompt += '\n\nConversation history for this entity:\n' + historyText;
  }
  // ONLY the current user message goes in messages array — clean for tool_use
  var contextMessages = [{ role: 'user', content: text }];

  try {
    var response;

    if (MINIMAX_KEY && !isClinicalQuery(text)) {
      // NON-CLINICAL: MiniMax M2.7 (76% cheaper, admin/scheduling/roster)
      // S4: Use callLLM dispatcher for circuit breaker integration
      var primaryProvider = resolveLLMProvider(text);
      response = await callLLM(primaryProvider, systemPrompt, contextMessages, tools, tenant, correlationId, chatId);
      if (!response) {
        // Primary failed — try fallback providers
        var fallbacks = ['anthropic', 'openai', 'deepseek'].filter(function(p) { return p !== primaryProvider; });
        for (var fi = 0; fi < fallbacks.length; fi++) {
          console.warn('[nc] ' + primaryProvider + ' failed, trying ' + fallbacks[fi]);
          response = await callLLM(fallbacks[fi], systemPrompt, contextMessages, tools, tenant, correlationId, chatId);
          if (response) break;
        }
      }
    } else if (ANTHROPIC_KEY) {
      // CLINICAL: Anthropic Haiku (proven safety for health queries)
      var clinicalProvider = resolveLLMProvider(text);
      response = await callLLM(clinicalProvider, systemPrompt, contextMessages, tools, tenant, correlationId, chatId);
    } else if (MINIMAX_KEY) {
      // No Anthropic key — MiniMax for everything
      response = await callLLM('minimax', systemPrompt, contextMessages, tools, tenant, correlationId, chatId);
    } else {
      // No LLM keys — gateway fallback
      response = await callGateway(text, tenant.tenantId, tenant.expertSlug);
    }

    clearInterval(typingInterval);

    if (!response) response = 'Processing error. Please try again.';

    // 6. Store response in entity memory
    addEntityTurn(chatId, entityId, 'assistant', response);
    saveSessionTurn(chatId, entityId, tenant.tenantId, 'assistant', response);

    // 7. Update entity anchor if first interaction
    if (!entityMemory.anchor && entityId.startsWith('patient:')) {
      entityMemory.anchor = 'Patient discussed: ' + text.slice(0, 100);
    }

    // 8. Send to Telegram
    await sendTelegram(chatId, response);
    console.log('[nc] Delivered (' + response.length + ' chars) entity=' + entityId);

      // HACPO experience report (non-blocking)
      emitAudit('agent.experience.report', {
        tenantId: tenant.tenantId, chatId: chatId, entityId: entityId,
        provider: (MINIMAX_KEY && !isClinicalQuery(text)) ? 'minimax' : (ANTHROPIC_KEY ? 'anthropic' : 'gateway'),
        responseLength: (response || '').length,
        deflected: (response || '').indexOf('I cannot') >= 0 || (response || '').indexOf('contact your doctor') >= 0,
        correlationId: correlationId,
      });

    // 9. Audit: response delivered (G1)
    persistConversationData(chatId, entityId, text, response, tenant);
    emitAudit('nanoclaw.response', {
      correlationId: correlationId, chatId: chatId, entity: entityId,
      persona: persona, responseLength: response.length,
    });

  } catch (e) {
    clearInterval(typingInterval);
    var errMsg = e instanceof Error ? e.message : String(e);
    console.error('[nc] RESPONSE ERROR chatId=' + chatId + ' entity=' + entityId + ': ' + errMsg);
    // B-1: Audit the error (previously swallowed — invisible to HACPO/Oracle)
    emitAudit('agent.error', {
      chatId: chatId, tenantId: tenant ? tenant.tenantId : null,
      entityId: entityId, error: errMsg, correlationId: correlationId,
      provider: typeof primaryProvider !== 'undefined' ? primaryProvider : 'unknown',
    });
    await sendTelegram(chatId, 'Processing error. Please try again.').catch(function() {});
  }
}

// ============================================================================
// GATEWAY FALLBACK (v3 behavior when no ANTHROPIC_KEY)
// ============================================================================
function callGateway(question, tenantId, expertSlug) {
  return new Promise(function(resolve, reject) {
    var payload = { question: question, context: { tenantId: tenantId, domain: 'wellness' } };
    if (expertSlug) payload.expertSlug = expertSlug;
    var data = JSON.stringify(payload);
    var url = new URL('/api/gateway/ask_wellness_question', MOTHERSHIP);
    var req = https.request(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MCP-API-Key': MCP_KEY },
      timeout: GATEWAY_TIMEOUT,
    }, function(res) {
      var c = ''; res.on('data', function(d) { c += d; });
      res.on('end', function() {
        try { var j = JSON.parse(c); resolve(j.content?.[0]?.text || j.response || c.slice(0, 2000)); }
        catch(e) { resolve(c.slice(0, 2000) || 'Processing error.'); }
      });
    });
    req.on('error', function() { resolve('Connectivity issue. Please try again.'); });
    req.on('timeout', function() { req.destroy(); resolve('Response timed out. Please try again.'); });
    req.write(data); req.end();
  });
}

// ============================================================================
// TELEGRAM POLLING
// ============================================================================
var offset = 0;

async function poll() {
  while (true) {
    try {
      var r = await tgApi('getUpdates', { offset: offset, timeout: POLL_TIMEOUT, allowed_updates: ['message', 'message_reaction'] });
      if (r.ok && r.result) {
        for (var i = 0; i < r.result.length; i++) {
          offset = r.result[i].update_id + 1;
          if (r.result[i].message) handleMessage(r.result[i].message).catch(function(e) { console.error('[nc] Handler:', e.message); });
          // Handle reactions (HACPO feedback loop)
          if (r.result[i].message_reaction) {
            var reaction = r.result[i].message_reaction;
            var reactChatId = reaction.chat.id;
            var reactTenant = CHAT_TENANT_MAP[String(reactChatId)];
            if (reactTenant) {
              var emojiList = (reaction.new_reaction || []).map(function(r) { return r.emoji || r.custom_emoji_id || '?'; });
              var sentiment = emojiList.some(function(e) { return ['❤️','👍','🔥','💯','👏'].indexOf(e) >= 0; }) ? 'positive' :
                              emojiList.some(function(e) { return ['👎','😡','💩'].indexOf(e) >= 0; }) ? 'negative' : 'neutral';
              emitAudit('telegram.reaction', {
                chatId: reactChatId, tenantId: reactTenant.tenantId,
                messageId: reaction.message_id, emoji: emojiList.join(','), sentiment: sentiment,
              });
            }
          }
        }
      }
    } catch (e) {
      console.warn('[nc] Poll: ' + e.message + '. Retry 5s...');
      await new Promise(function(r) { setTimeout(r, 5000); });
    }
  }
}

// ============================================================================
// HEALTH SERVER + STARTUP
// ============================================================================
http.createServer(function(req, res) {
  var entities = {};
  for (var cid in chatMemory) {
    for (var eid in chatMemory[cid].entities) {
      entities[eid] = { turns: chatMemory[cid].entities[eid].turns.length, lastActive: chatMemory[cid].entities[eid].lastActive };
    }
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok', agent: 'nanoclaw-v11.3.0', messages: msgCount,
    uptime: Math.round(process.uptime()),
    memory: { type: 'ESAGM', entities: Object.keys(entities).length }, // SEC-07: no patient names in health
    capabilities: ANTHROPIC_KEY ? 'tool_use+esagm' : 'gateway_only',
  }));
}).listen(HEALTH_PORT, '127.0.0.1', function() { healthServer = this; }); // SEC-07: localhost only; S2: assign for graceful shutdown

// FM-5: Kiosk API proxy on Tailscale — exposes read-only endpoints for kiosk/widget surfaces
// Binds to 0.0.0.0 on a separate port (3100) — Tailscale ACL restricts access
var KIOSK_PORT = process.env.KIOSK_PORT || 3100;
http.createServer(function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', agent: 'nanoclaw-v11.3.0-kiosk', tools: ALL_TOOLS.length }));
    return;
  }

  // /api/banner — returns latest content.generated event for kiosk display
  if (req.url && req.url.startsWith('/api/banner')) {
    if (!SUPABASE_URL || !SUPABASE_KEY) { res.writeHead(503); res.end('{}'); return; }
    httpsGet(SUPABASE_URL + '/rest/v1/agent_event_bus?event_type=eq.content.broadcast&tenant_id=eq.' + TENANT_ID + '&order=created_at.desc&limit=1&select=payload',
      { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }, 5000)
      .then(function(data) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(Array.isArray(data) && data[0] ? data[0].payload : {}));
      }).catch(function() { res.writeHead(200); res.end('{}'); });
    return;
  }

  res.writeHead(404); res.end('{"error":"not found"}');
}).listen(KIOSK_PORT, '0.0.0.0');
console.log('[nc] Kiosk API on :' + KIOSK_PORT + ' (Tailscale-accessible)');

console.log('[nc] NanoClaw v11.3.0 on :' + HEALTH_PORT);
console.log('[nc] Persona: COS (admin) + Expert Rep (Keith Koo)');
console.log('[nc] Memory: Entity-Scoped Attention Graph (per-patient isolation)');
console.log('[nc] Tools: ' + (ANTHROPIC_KEY ? 'Anthropic tool_use (scoped by persona)' : 'Gateway only (no ANTHROPIC_KEY)'));
console.log('[nc] Audit: agent_event_bus + correlation IDs');
loadAgentIdentity().catch(function(e) { console.warn('[nc] Initial identity load failed:', e.message); });
seedBrandDNA(); // Seed DR MAGfield brand DNA into agent memory

// Startup audit event
emitAudit('nanoclaw.startup', { version: 'v11.3.0', capabilities: ANTHROPIC_KEY ? 'full' : 'gateway_only', tenantId: TENANT_ID, tenantMode: process.env.TENANT_MODE || 'single', toolCount: ALL_TOOLS.length });

poll();
