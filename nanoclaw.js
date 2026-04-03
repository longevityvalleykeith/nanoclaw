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
const path = require('path');
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
  'ec895dc3-c819-46ae-906a-59c49eecfb11': process.env.MCP_API_KEY_BMW || MCP_KEY,  // BMW Wellness
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
const NANOCLAW_VERSION = 'v12.3.0-social-consciousness'; // v12.3: social awareness + conservation check + L1 entity coupling + Mac Mini mutations merged

if (!TG_TOKEN) { console.error('[nc] FATAL: TELEGRAM_BOT_TOKEN not set'); process.exit(1); }

// ============================================================================
// V12.3: STARTUP CONSERVATION CHECK — refuse to run if traits are missing
// Prevents ML-266/ML-314 regressions from CC agents rewriting the file
// ============================================================================
(function startupConservationCheck() {
  var fs = require('fs');
  var src = fs.readFileSync(__filename, 'utf8');
  var checks = [
    ['S1-crash', 'uncaughtException'],
    ['S2-shutdown', 'gracefulShutdown'],
    ['S3-gateway-cb', 'gatewayCircuitOpen'],
    ['S4-llm-router', 'LLM_PROVIDERS'],
    ['V12.1-chatId', 'correlationId, chatId)'],
    ['V12.2-circuit', 'toolCircuits'],
    ['V12.2-alternatives', 'TOOL_ALTERNATIVES'],
    ['V12.3-guestgate', 'GUEST GATE'],
    ['V12.3-sender', '_currentSenderName'],
    ['V12.3-selfidentity', 'YOUR IDENTITY IN THIS SPACE'],
  ];
  var failures = [];
  for (var i = 0; i < checks.length; i++) {
    if (!src.includes(checks[i][1])) failures.push(checks[i][0] + ': missing "' + checks[i][1] + '"');
  }
  if (failures.length > 0) {
    console.error('[nc] CONSERVATION CHECK FAILED — refusing to start:');
    for (var j = 0; j < failures.length; j++) console.error('[nc]   ' + failures[j]);
    console.error('[nc] Run: git checkout origin/main -- nanoclaw.js');
    process.exit(1);
  }
  console.log('[nc] Conservation check: ' + checks.length + '/' + checks.length + ' PASS');
})();

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
// V12.2: INTRINSIC TOOL CIRCUIT BREAKER (Flight Recorder pattern)
// Prevents maze-rat retries on external failures (billing, auth, infra)
// ============================================================================
var toolCircuits = {};
var TOOL_CB_THRESHOLD = 3;
var TOOL_CB_COOLDOWN_MS = 1800000; // 30 minutes

function isToolCircuitOpen(toolName) {
  var circuit = toolCircuits[toolName];
  if (!circuit) return false;
  if (Date.now() < circuit.openUntil) return true;
  if (circuit.openUntil > 0 && Date.now() >= circuit.openUntil) {
    circuit.openUntil = 0;
    circuit.errors = [];
    console.log('[nc] Circuit CLOSED for ' + toolName + ' (cooldown expired)');
    emitAudit('tool.circuit_closed', { tool: toolName });
  }
  return false;
}

function recordToolFailure(toolName, errorCode, layer) {
  if (!toolCircuits[toolName]) {
    toolCircuits[toolName] = { errors: [], openUntil: 0, layer: '' };
  }
  var circuit = toolCircuits[toolName];
  circuit.errors.push({ code: errorCode, time: Date.now() });
  circuit.layer = layer;
  if (circuit.errors.length > 10) circuit.errors = circuit.errors.slice(-10);
  var recentSameError = circuit.errors.filter(function(e) {
    return e.code === errorCode && (Date.now() - e.time) < 3600000;
  });
  if (recentSameError.length >= TOOL_CB_THRESHOLD) {
    circuit.openUntil = Date.now() + TOOL_CB_COOLDOWN_MS;
    console.log('[nc] Circuit OPEN for ' + toolName + ' (' + errorCode + ' x' + recentSameError.length + ')');
    emitAudit('tool.circuit_open', {
      tool: toolName, errorCode: errorCode, layer: layer,
      reopenAt: new Date(circuit.openUntil).toISOString(),
    });
    return true;
  }
  return false;
}

var TOOL_ALTERNATIVES = {
  generate_speech: ['generate_video'],
  render_video: ['generate_content'],
  notion_search: ['query_knowledge'],
  generate_i2v: ['render_video'],
  generate_tts: ['voice_response'],
};

function getToolAlternative(toolName) {
  var alts = TOOL_ALTERNATIVES[toolName];
  if (!alts) return null;
  for (var i = 0; i < alts.length; i++) {
    if (!isToolCircuitOpen(alts[i])) return alts[i];
  }
  return null;
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
// CRITICAL #7: REVIEW STATE — file-backed, survives NanoClaw restart
// creative-cache/ dir: ~/lv-agent/creative-cache/ (Mac Mini) or /opt/lv/creative-cache/ (DO)
// ============================================================================
var contentReview = {}; // In-memory cache: contentId -> review state
var REVIEW_CACHE_DIR = path.join(process.cwd(), 'creative-cache');

function persistReview(contentId, review) {
  try {
    var dir = REVIEW_CACHE_DIR;
    if (!require('fs').existsSync(dir)) require('fs').mkdirSync(dir, { recursive: true });
    require('fs').writeFileSync(path.join(dir, contentId + '.json'), JSON.stringify({
      contentId: contentId,
      status: review.status,
      chatId: review.chatId,
      caption: review.caption,
      revision: review.revision || 0,
      updatedAt: new Date().toISOString(),
    }));
  } catch(e) { console.warn('[nc] persistReview failed:', e.message); }
}

function restoreReviewState() {
  try {
    var dir = REVIEW_CACHE_DIR;
    if (!require('fs').existsSync(dir)) return;
    var files = require('fs').readdirSync(dir);
    var restored = 0;
    files.forEach(function(f) {
      if (!f.endsWith('.json')) return;
      try {
        var r = JSON.parse(require('fs').readFileSync(path.join(dir, f), 'utf8'));
        if (r.status === 'in_review') {
          contentReview[r.contentId] = r;
          restored++;
        }
      } catch(e) {}
    });
    if (restored > 0) console.log('[nc] Review state restored: ' + restored + ' in-review items');
  } catch(e) { console.warn('[nc] restoreReviewState failed:', e.message); }
}

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
  // OUTBOUND CONTENT GATE (Option B++) — blocks bad URLs, internal endpoints, API leaks
  if (text && typeof text === 'string') {
    var _blocked = ['manus.space','magfieldhub-prhmfwhg','localhost:','127.0.0.1','supabase.co/rest','api.anthropic.com','api.minimax.io'];
    for (var _bp = 0; _bp < _blocked.length; _bp++) {
      if (text.indexOf(_blocked[_bp]) >= 0) {
        console.warn('[nc] GATE: blocked "' + _blocked[_bp] + '"');
        text = text.split(_blocked[_bp]).join('[blocked]');
        try { emitAudit('delivery.blocked', { chatId: String(chatId), pattern: _blocked[_bp] }); } catch(e) {}
      }
    }
  }
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
  emitAudit('nanoclaw.daily_digest_sent', { date: new Date().toISOString().slice(0, 10), tokensLeft: geoTokenBudget.remaining });
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
  { name: 'send_to_dm', description: 'Send content preview to Keith DM for review before broadcasting to group. After rendering video with render_video, use this to send the preview to Keith. Keith or Arie replies 👍 to approve → auto-broadcasts to supergroup. Replies 👎 to reject with feedback.', input_schema: { type: 'object', properties: { mediaPath: { type: 'string', description: 'Local file path to video from render_video output (e.g. /tmp/content-atom-1234567890.mp4)' }, mediaType: { type: 'string', enum: ['video', 'photo', 'animation'], description: 'Media type (default: video)' }, caption: { type: 'string', description: 'Caption for the content preview' }, contentId: { type: 'string', description: 'Unique content identifier for tracking reviews (e.g. rabbit-cup-rev3)' }, contentSlug: { type: 'string', description: 'Human-readable slug for the content (e.g. rabbit-cup-final)' } }, required: ['mediaPath', 'caption', 'contentId'] } },
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
  { name: 'render_video', description: 'Render Content Atom as MP4 video using Remotion and send to current Telegram chat. Supports brand image overlay. Returns video file path and sends to user.', input_schema: { type: 'object', properties: { headline: { type: 'string', description: 'Video headline' }, body: { type: 'string', description: 'Body text' }, cta: { type: 'string', description: 'CTA text' }, imageUrl: { type: 'string', description: 'Public URL of hero/product image (from upload_media)' }, type: { type: 'string', description: 'Content type' }, product: { type: 'string', description: 'Product name' }, eventName: { type: 'string', description: 'Event name' }, eventDate: { type: 'string', description: 'Event date' } }, required: ['headline'] } },
  // === INTEGRATIONS (Google Calendar + Drive + Notion) ===
  { name: 'create_calendar_event', description: 'Create a Google Calendar event. Use for scheduling sessions, appointments, follow-ups. Returns event link.', input_schema: { type: 'object', properties: { title: { type: 'string', description: 'Event title' }, startTime: { type: 'string', description: 'ISO 8601 start (e.g. 2026-04-05T09:00:00+08:00)' }, endTime: { type: 'string', description: 'ISO 8601 end' }, description: { type: 'string', description: 'Event description' }, location: { type: 'string', description: 'Location (e.g. KRPM Experience Lounge)' } }, required: ['title', 'startTime', 'endTime'] } },
  { name: 'read_drive_file', description: 'Read a file from Google Drive. Returns file content. Use when admin asks to check a shared document.', input_schema: { type: 'object', properties: { fileId: { type: 'string', description: 'Google Drive file ID' }, fileName: { type: 'string', description: 'File name to search for' } }, required: ['fileId'] } },
  { name: 'sync_google_drive', description: 'Sync Google Drive folder to knowledge base. Imports documents as KUs.', input_schema: { type: 'object', properties: { folderId: { type: 'string', description: 'Drive folder ID to sync' } }, required: [] } },
  { name: 'notion_search', description: 'Search Notion workspace. Find pages, databases, events, patient notes. Use when admin asks about Notion content.', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] } },
  { name: 'notion_fetch', description: 'Fetch full content of a Notion page by URL or ID. Use after notion_search to get details.', input_schema: { type: 'object', properties: { pageId: { type: 'string', description: 'Notion page ID or URL' } }, required: ['pageId'] } },
  // === CLINICAL TOOLS (gateway proxy) ===
  { name: 'manage_integrations', description: 'Connect or check OAuth services (Notion, Calendar, Drive). Use when user asks to connect a service.', input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['connect', 'status', 'disconnect'] }, toolkit: { type: 'string', description: 'notion, googlecalendar, googledrive, stripe, gmail' } }, required: ['action'] } },
  { name: 'composio_tool', description: 'Execute Composio-connected service action. Use after manage_integrations confirms connection.', input_schema: { type: 'object', properties: { toolkit: { type: 'string' }, action: { type: 'string' }, params: { type: 'object' } }, required: ['toolkit', 'action'] } },
  { name: 'get_daily_brief', description: 'Get daily patient brief — summary of today scheduled patients, follow-ups due, alerts.', input_schema: { type: 'object', properties: {} } },
  { name: 'get_patient_insights', description: 'Get AI insights for a specific patient — health trends, risk factors, recommendations.', input_schema: { type: 'object', properties: { patientName: { type: 'string', description: 'Patient name' } }, required: ['patientName'] } },
  { name: 'escalate_emergency', description: 'Escalate a medical emergency. Sends alert to expert + admin + emergency contacts.', input_schema: { type: 'object', properties: { patientName: { type: 'string', description: 'Patient name' }, situation: { type: 'string', description: 'Emergency description' }, severity: { type: 'string', enum: ['urgent', 'critical', 'life-threatening'], description: 'Severity level' } }, required: ['situation', 'severity'] } },
  { name: 'upload_media', description: 'Upload a Telegram file (image/video/doc) to public cloud storage. Returns a public URL usable by render_video, generate_i2v, and broadcast. Call this FIRST when you need to use an uploaded file in another tool.', input_schema: { type: 'object', properties: { file_id: { type: 'string', description: 'Telegram file_id from the uploaded media' }, filename: { type: 'string', description: 'Desired filename (e.g. brand-photo.jpg)' } }, required: ['file_id'] } },
  // === M-2..M-5: Mac Mini positive mutations (cherry-picked from V12.2B) ===
  { name: 'record_session', description: 'Record a completed session. Returns session ID + amount.', input_schema: { type: 'object', properties: { patientName: { type: 'string' }, serviceType: { type: 'string', enum: ['housecall_1hr', 'housecall_companion', 'lm_physio', 'lm_housecall', 'lm_monthly'] }, duration: { type: 'number' }, notes: { type: 'string' } }, required: ['patientName', 'serviceType'] } },
  { name: 'generate_document', description: 'Generate invoice or receipt markdown. Use after record_session.', input_schema: { type: 'object', properties: { type: { type: 'string', enum: ['invoice', 'receipt'] }, sessionId: { type: 'string' } }, required: ['type', 'sessionId'] } },
  { name: 'calculate_revenue_split', description: 'Calculate revenue split for collaboration sessions.', input_schema: { type: 'object', properties: { sessionId: { type: 'string' }, facilityName: { type: 'string' }, splitPercentage: { type: 'number' } }, required: ['sessionId', 'facilityName', 'splitPercentage'] } },
  { name: 'get_expert_queue', description: 'List pending expert review items. Returns queue with patient names, types, timestamps.', input_schema: { type: 'object', properties: {} } },
  { name: 'process_expert_queue', description: 'Approve or reject an expert queue item. Admin-only.', input_schema: { type: 'object', properties: { itemId: { type: 'string' }, action: { type: 'string', enum: ['approve', 'reject'] }, notes: { type: 'string' } }, required: ['itemId', 'action'] } },
  // === Sook Ping workflow tools (merge arbiter Task 4) ===
  { name: 'import_document', description: 'Import a clinical document (physiotherapy report, service summary, lab report). Extracts patient name + clinical data, creates patient entity, returns structured summary. Use AFTER receiving a document upload — call with the file_id from the upload. This is the PRIMARY tool for document-to-entity conversion.', input_schema: { type: 'object', properties: { file_id: { type: 'string', description: 'Telegram file_id of the uploaded document' }, document_type: { type: 'string', enum: ['physiotherapy_report', 'service_summary', 'lab_report', 'intake_form', 'other'], description: 'Type of clinical document' }, patient_name: { type: 'string', description: 'Patient name if already known (optional — will extract from document if not provided)' } }, required: ['file_id'] } },
  { name: 'manage_session', description: 'Record a session from natural language. Parse "Done with Auntie Lim, housecall companion 4 hours, RM200" into structured session record. Creates patient if needed, records session, calculates revenue.', input_schema: { type: 'object', properties: { description: { type: 'string', description: 'Natural language session description (e.g., "Done with Auntie Lim, housecall companion 4 hours, RM200")' } }, required: ['description'] } },
  { name: 'generate_invoice', description: 'Generate Malaysia-compliant e-invoice for a completed session. Creates invoice with line items, SST-exempt tax, revenue split. Returns invoice number + verify URL. Use AFTER manage_session or record_session.', input_schema: { type: 'object', properties: { patientName: { type: 'string', description: 'Patient/client name' }, serviceType: { type: 'string', enum: ['housecall_1hr', 'housecall_companion', 'lm_physio', 'lm_housecall', 'lm_monthly'], description: 'Service type' }, hours: { type: 'number', description: 'Number of hours (default 1)' }, rate: { type: 'number', description: 'Override rate in RM' }, facilityName: { type: 'string', description: 'Partnering facility name (if applicable)' }, facilitySharePct: { type: 'number', description: 'Facility share % (default 20)' }, notes: { type: 'string', description: 'Additional notes' } }, required: ['patientName', 'serviceType'] } },
  { name: 'create_payment_link', description: 'Create Airwallex payment link for an invoice. Returns secure FPX/card payment URL + verification URL. Send to patient/family. Use AFTER generate_invoice.', input_schema: { type: 'object', properties: { invoiceId: { type: 'string', description: 'Invoice ID or invoice number (e.g., PC-INV-2026-0042)' } }, required: ['invoiceId'] } },
];

// Scope by persona
var TOOLS_COS = ALL_TOOLS; // Admin gets everything
var TOOLS_EXPERT = ALL_TOOLS.filter(function(t) { return t.name !== 'task_mirror'; }); // Expert gets clinical tools

// SEC-06: Sanitize string inputs before tool calls
function sanitize(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[\x00-\x1f]/g, '').replace(/[<>]/g, '').slice(0, 500);
}

async function executeToolCall(toolName, input, tenant, correlationId, chatId) {
  // V12.2: Check intrinsic circuit breaker BEFORE calling tool
  if (isToolCircuitOpen(toolName)) {
    var alt = getToolAlternative(toolName);
    var circuit = toolCircuits[toolName];
    if (alt) {
      console.log('[nc] Circuit OPEN for ' + toolName + ', routing to: ' + alt);
      emitAudit('tool.alternative_routed', { blocked: toolName, alternative: alt, layer: circuit.layer });
      return executeToolCall(alt, input, tenant, correlationId, chatId);
    }
    return {
      error: toolName + ' is temporarily unavailable (' + circuit.layer + ' issue)',
      layer: circuit.layer,
      circuitOpen: true,
      reopenAt: new Date(circuit.openUntil).toISOString(),
      action: circuit.layer === 'context'
        ? 'Billing/auth issue. Tell admin: top up API credit or check key.'
        : 'Tool will auto-retry in ' + Math.round((circuit.openUntil - Date.now()) / 60000) + ' minutes.'
    };
  }

  var _startTime = Date.now();
  try {
    var _toolResult = await _executeToolCallInner(toolName, input, tenant, correlationId, chatId);
    // V12.1: Track tool usage
    if (typeof toolsActuallyUsed !== 'undefined') toolsActuallyUsed.push({ name: toolName, success: true });
    // V12.2: Emit tool receipt for L2 visibility (GAP-5)
    emitAudit('tool.receipt', {
      tool: toolName, success: !_toolResult.error,
      latencyMs: Date.now() - _startTime,
      tenantId: tenant ? tenant.tenantId : null,
      correlationId: correlationId,
      resultSummary: _toolResult.error ? _toolResult.error.slice(0, 100) : 'ok',
    });
    return _toolResult;
  } catch (toolErr) {
    var errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
    console.error('[nc] Tool error:', toolName, errMsg.slice(0, 200));

    // V12.1: 6-LAYER DIAGNOSTIC
    var layer = 'unknown';
    var recovery = '';
    var errLower = errMsg.toLowerCase();

    if (/enoent|spawn|execsync|child_process|eacces|eperm/.test(errLower)) {
      layer = 'infrastructure';
      recovery = 'A required binary or file is missing. Server admin must install dependency.';
    } else if (/timeout|econnrefused|enotfound|socket|fetch failed|headers_timeout|econnreset/.test(errLower)) {
      layer = 'network';
      recovery = 'Could not reach API. Will retry once.';
      try {
        await new Promise(function(r) { setTimeout(r, 2000); });
        var retryResult = await _executeToolCallInner(toolName, input, tenant, correlationId, chatId);
        if (retryResult && !retryResult.error) {
          console.log('[nc] Auto-retry SUCCESS for ' + toolName);
          emitAudit('tool.receipt', { tool: toolName, success: true, latencyMs: Date.now() - _startTime, retried: true, tenantId: tenant ? tenant.tenantId : null });
          return retryResult;
        }
      } catch(retryErr) { /* retry failed */ }
    } else if (/invalid|required|missing|schema|validation|type.*error/.test(errLower)) {
      layer = 'semantic';
      recovery = 'Wrong input parameters. Check tool description for required fields.';
    } else if (/unauthorized|forbidden|403|401|insufficient|balance|quota|limit|expired|1008/.test(errLower)) {
      layer = 'context';
      recovery = 'External billing/quota/auth issue. Cannot fix by retrying. Human must act.';
    } else if (/reference.*not defined|is not a function|cannot read|undefined/.test(errLower)) {
      layer = 'tool_execution';
      recovery = 'Bug in tool code. Logged for repair team.';
    } else {
      layer = 'logical';
      recovery = 'Unexpected error in data processing.';
    }

    // V12.2: Record failure for circuit breaker
    var errorCode = (errMsg.match(/\d{3,4}/) || [layer])[0];
    var circuitOpened = recordToolFailure(toolName, errorCode, layer);

    emitAudit('tool.error', {
      tool: toolName, error: errMsg.slice(0, 200),
      layer: layer, recovery: recovery, circuitOpened: circuitOpened,
      tenantId: tenant ? tenant.tenantId : null, correlationId: correlationId
    });
    emitAudit('tool.receipt', {
      tool: toolName, success: false, latencyMs: Date.now() - _startTime,
      layer: layer, tenantId: tenant ? tenant.tenantId : null,
    });

    // V12.2: If circuit just opened, suggest alternative
    if (circuitOpened) {
      var alt = getToolAlternative(toolName);
      if (alt) {
        return {
          error: toolName + ' circuit opened after ' + TOOL_CB_THRESHOLD + ' failures. Alternative: ' + alt,
          layer: layer, alternative: alt,
          action: 'I will use ' + alt + ' instead. Original tool blocked for 30 minutes.'
        };
      }
    }

    return {
      error: 'Tool failed: ' + toolName,
      layer: layer,
      diagnosis: recovery,
      action: layer === 'network' ? 'Auto-retried once. Tell user to try again in a minute.' :
              layer === 'context' ? 'Tell user: billing/auth issue. Admin needs to check API key or credit.' :
              layer === 'infrastructure' ? 'Tell user: Server config issue. Repair team notified.' :
              'Tell user what happened honestly. Do NOT say "How can I help?"'
    };
  }
}

async function _executeToolCallInner(toolName, input, tenant, correlationId, chatId) {
  // SEC-06: Validate tool name against allowlist
  // V12.3: Dynamic allowlist from ALL_TOOLS (never hardcode — prevents drift)
  var allowedTools = ALL_TOOLS.map(function(t) { return t.name; });
  if (allowedTools.indexOf(toolName) === -1) {
    return Promise.resolve({ error: 'Tool not in allowlist: ' + toolName });
  }
  // Sanitize all string inputs
  for (var key in input) {
    if (typeof input[key] === 'string') input[key] = sanitize(input[key]);
  }
  var authHeaders = { 'x-cron-secret': CRON_SECRET, 'x-correlation-id': correlationId };
  // V12.3.1: SEC-002 fix — per-tenant MCP key (was global MCP_KEY → cross-tenant data leak)
  var gwHeaders = { 'X-MCP-API-Key': getMcpKey(tenant.tenantId), 'x-correlation-id': correlationId };

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

    // G1: send_to_dm — route rendered content to Keith DM for review
    // Keith/Arie 👍 → approval handler broadcasts to supergroup
    case 'send_to_dm': {
      var KEITH_CHAT_ID = '1544430803';
      var mediaPath = input.mediaPath;
      var mediaType = input.mediaType || 'video';
      var caption = input.caption || '';
      var contentId = input.contentId || ('content_' + Date.now());
      var contentSlug = input.contentSlug || contentId;

      if (!mediaPath) return { error: 'mediaPath required' };

      var fs = require('fs');
      if (!fs.existsSync(mediaPath)) return { error: 'File not found: ' + mediaPath };

      // Upload local video file to Keith DM via Telegram Bot API
      // Use multipart form upload since we have a local file
      var formData = require('stream').Readable ? null : null;
      try {
        var stats = fs.statSync(mediaPath);
        if (stats.size < 1000) return { error: 'File too small: ' + stats.size };
      } catch(e) { return { error: 'Cannot stat file: ' + e.message }; }

      // Build multipart form manually for sendVideo
      var https = require('https');
      var path = require('path');
      var boundary = 'nc_bound_' + Date.now();
      var fileName = path.basename(mediaPath);
      var fileData = fs.readFileSync(mediaPath);

      var captionPart = [
        '--' + boundary,
        'Content-Disposition: form-data; name="chat_id"\r\n\r\n' + KEITH_CHAT_ID,
        '--' + boundary,
        'Content-Disposition: form-data; name="caption"\r\n\r\n' + caption,
        '--' + boundary,
        'Content-Disposition: form-data; name="' + (mediaType === 'photo' ? 'photo' : 'video') + '"; filename="' + fileName + '"\r\nContent-Type: video/mp4\r\n\r\n',
      ].join('\r\n');
      var endBoundary = '\r\n--' + boundary + '--';

      var preBuf = Buffer.from(captionPart, 'utf8');
      var postBuf = Buffer.from(endBoundary, 'utf8');

      var tgResult = await new Promise(function(resolve, reject) {
        var req = https.request({
          method: 'POST',
          hostname: 'api.telegram.org',
          port: 443,
          path: '/bot' + TG_TOKEN + '/send' + (mediaType === 'photo' ? 'Photo' : 'Video'),
          headers: {
            'Content-Type': 'multipart/form-data; boundary=' + boundary,
            'Content-Length': preBuf.length + fileData.length + postBuf.length,
          },
          timeout: 120000,
        }, function(res) {
          var buf = ''; res.on('data', function(c) { buf += c; });
          res.on('end', function() { try { resolve(JSON.parse(buf)); } catch(e) { resolve({ ok: false, error: buf }); } });
        });
        req.on('error', reject);
        req.on('timeout', function() { req.destroy(); reject(new Error('upload timeout')); });
        req.write(preBuf); req.write(fileData); req.write(postBuf); req.end();
      });

      if (!tgResult || !tgResult.ok) {
        return { error: 'Telegram upload failed: ' + (tgResult && tgResult.description) || 'unknown' };
      }

      var msgId = tgResult.result && tgResult.result.message_id;

      // Write to contentReview so approval handler can broadcast to supergroup
      var reviewEntry = {
        contentId: contentId,
        contentSlug: contentSlug,
        status: 'in_review',
        chatId: KEITH_CHAT_ID, // approval handler matches by chatId
        mediaUrl: mediaPath, // local path — approval handler sends this to group
        caption: caption,
        revision: 0,
        updatedAt: new Date().toISOString(),
        tenantId: tenant.tenantId,
      };
      contentReview[contentId] = reviewEntry;
      persistReview(contentId, reviewEntry);

      // Insert to content_reviews DB table
      try {
        var dbInsert = await httpsPost(SUPABASE_URL + '/rest/v1/content_reviews', {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        }, {
          content_id: contentId,
          content_slug: contentSlug,
          reviewer_id: null,
          verdict: null,
          feedback_text: null,
          revision_number: 0,
          tenant_id: tenant.tenantId,
        }, 10000);
      } catch(e) { console.warn('[nc] content_reviews insert failed:', e.message); }

      emitAudit('content.sent_for_review', { contentId: contentId, contentSlug: contentSlug, msgId: msgId, chatId: KEITH_CHAT_ID, tenantId: tenant.tenantId });
      return { success: true, message_id: msgId, contentId: contentId, sent_to: KEITH_CHAT_ID, note: 'Reply 👍 to approve → broadcasts to supergroup. Reply 👎 to reject.' };
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
        productImageUrl: input.imageUrl || '',
        product: input.product || '', eventName: input.eventName || '', eventDate: input.eventDate || '',
        primaryColor: '#2D3748', accentColor: '#C9A96E', bgColor: '#FFFDF9',
      });
      var outputPath = '/tmp/content-atom-' + Date.now() + '.mp4';
      var remotionDir = process.env.REMOTION_DIR || (require('os').homedir() + '/lv-agent/remotion-studio');
      try {
        var { execSync } = require('child_process');
        execSync('cd ' + remotionDir + " && npx remotion render ContentAtom --props='" + renderProps + "' " + outputPath, { timeout: 120000, stdio: 'pipe' });
        emitAudit('content.rendered', { type: 'remotion-mp4', outputPath: outputPath, headline: input.headline, tenantId: tenant.tenantId });
        // V12.1: Auto-deliver to Telegram chat
        if (chatId) {
          var fs = require('fs');
          if (fs.existsSync(outputPath)) {
            var videoBuffer = fs.readFileSync(outputPath);
            // Send via multipart form to Telegram sendVideo
            var boundary = '----NanoClawUpload' + Date.now();
            var body = '';
            body += '--' + boundary + '\r\n';
            body += 'Content-Disposition: form-data; name="chat_id"\r\n\r\n' + chatId + '\r\n';
            body += '--' + boundary + '\r\n';
            body += 'Content-Disposition: form-data; name="caption"\r\n\r\n' + (input.headline || 'Content Atom') + '\r\n';
            body += '--' + boundary + '\r\n';
            body += 'Content-Disposition: form-data; name="video"; filename="content-atom.mp4"\r\n';
            body += 'Content-Type: video/mp4\r\n\r\n';
            var bodyBuffer = Buffer.concat([
              Buffer.from(body, 'utf8'),
              videoBuffer,
              Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8'),
            ]);
            await new Promise(function(resolve, reject) {
              var url = new URL('https://api.telegram.org/bot' + TG_TOKEN + '/sendVideo');
              var opts = {
                hostname: url.hostname, port: 443, path: url.pathname, method: 'POST',
                headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': bodyBuffer.length },
              };
              var req = https.request(opts, function(res) {
                var d = ''; res.on('data', function(c) { d += c; }); res.on('end', function() { resolve(d); });
              });
              req.on('error', reject);
              req.write(bodyBuffer);
              req.end();
            });
            // Store for G1 approve→broadcast flow
            if (tenant.isAdmin) {
              var contentId = 'rv_' + Date.now();
              contentReview[contentId] = { contentId: contentId, chatId: String(chatId), mediaUrl: null, caption: input.headline || 'Content Atom', localPath: outputPath, status: 'pending_review' };
            }
            return { rendered: true, delivered: true, outputPath: outputPath, message: 'Video rendered and sent to chat.' };
          }
        }
        return { rendered: true, delivered: false, outputPath: outputPath, message: 'Video rendered but could not auto-deliver. File at: ' + outputPath };
      } catch (re) { return { error: 'Render failed: ' + (re.message || '').slice(0, 100) }; }
    }

    // === INTEGRATION TOOLS (gateway proxy) ===
    case 'create_calendar_event':
      return httpsPost(MOTHERSHIP + '/api/gateway/create_calendar_event', gwHeaders, {
        title: input.title, startTime: input.startTime, endTime: input.endTime,
        description: input.description || '', location: input.location || '',
        tenantId: tenant.tenantId, expertSlug: tenant.expertSlug,
      }, 15000);

    case 'read_drive_file':
      return httpsPost(MOTHERSHIP + '/api/gateway/read_drive_file', gwHeaders, {
        fileId: input.fileId, fileName: input.fileName,
        tenantId: tenant.tenantId,
      }, 30000);

    case 'sync_google_drive':
      return httpsPost(MOTHERSHIP + '/api/gateway/sync_google_drive', gwHeaders, {
        folderId: input.folderId, tenantId: tenant.tenantId,
      }, 60000);

    case 'notion_search':
      return httpsPost(MOTHERSHIP + '/api/gateway/notion_search', gwHeaders, {
        query: input.query, pageSize: input.pageSize || 5,
      }, 15000);

    case 'notion_fetch':
      return httpsPost(MOTHERSHIP + '/api/gateway/notion_fetch', gwHeaders, {
        pageId: input.pageId,
      }, 15000);

    case 'get_daily_brief':
      return httpsPost(MOTHERSHIP + '/api/gateway/get_daily_brief', gwHeaders, {
        tenantId: tenant.tenantId, expertSlug: tenant.expertSlug,
      }, 15000);

    case 'get_patient_insights':
      return httpsPost(MOTHERSHIP + '/api/gateway/get_patient_insights', gwHeaders, {
        patientName: input.patientName, tenantId: tenant.tenantId,
      }, 15000);

    case 'escalate_emergency':
      return httpsPost(MOTHERSHIP + '/api/gateway/escalate_emergency', gwHeaders, {
        patientName: input.patientName || '', situation: input.situation,
        severity: input.severity, tenantId: tenant.tenantId,
      }, 10000);

    case 'upload_media': {
      // G-P1: Upload Telegram file to Supabase Storage → return public URL
      if (!input.file_id) return { error: 'file_id required' };
      var fileInfo = await tgApi('getFile', { file_id: input.file_id });
      if (!fileInfo.ok || !fileInfo.result || !fileInfo.result.file_path) {
        return { error: 'Could not resolve file_id. File may have expired.' };
      }
      var tgFileUrl = 'https://api.telegram.org/file/bot' + TG_TOKEN + '/' + fileInfo.result.file_path;
      // Download from Telegram
      var fileBuffer = await new Promise(function(resolve, reject) {
        https.get(tgFileUrl, function(res) {
          var chunks = [];
          res.on('data', function(c) { chunks.push(c); });
          res.on('end', function() { resolve(Buffer.concat(chunks)); });
          res.on('error', reject);
        }).on('error', reject);
      });
      // Determine extension from file_path
      var ext = path.extname(fileInfo.result.file_path) || '.jpg';
      var storageName = (input.filename || ('upload-' + Date.now())) + ext;
      var storagePath = 'agent-uploads/' + tenant.tenantId + '/' + storageName;
      // Upload to Supabase Storage (using REST API)
      var uploadResult = await new Promise(function(resolve, reject) {
        var url = new URL(SUPABASE_URL + '/storage/v1/object/public-assets/' + storagePath);
        var opts = {
          hostname: url.hostname,
          port: 443,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/octet-stream',
            'x-upsert': 'true',
            'Content-Length': fileBuffer.length,
          },
        };
        var req = https.request(opts, function(res) {
          var body = '';
          res.on('data', function(c) { body += c; });
          res.on('end', function() {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ ok: true });
            } else {
              resolve({ ok: false, error: 'HTTP ' + res.statusCode + ': ' + body.slice(0, 200) });
            }
          });
        });
        req.on('error', function(e) { reject(e); });
        req.write(fileBuffer);
        req.end();
      });
      if (!uploadResult.ok) {
        return { error: 'Upload failed: ' + (uploadResult.error || 'unknown') };
      }
      var publicUrl = SUPABASE_URL + '/storage/v1/object/public/public-assets/' + storagePath;
      emitAudit('media.uploaded', { storagePath: storagePath, publicUrl: publicUrl, size: fileBuffer.length, tenantId: tenant.tenantId });
      return { uploaded: true, publicUrl: publicUrl, storagePath: storagePath, size: fileBuffer.length };
    }

    // === M-2..M-5: Mac Mini cherry-picked tool handlers ===
    case 'record_session':
      return httpsPost(MOTHERSHIP + '/api/gateway/record_session', gwHeaders, input, 15000);
    case 'generate_document':
      return httpsPost(MOTHERSHIP + '/api/gateway/generate_document', gwHeaders, input, 15000);
    case 'calculate_revenue_split':
      return httpsPost(MOTHERSHIP + '/api/gateway/calculate_revenue_split', gwHeaders, input, 10000);
    case 'manage_integrations':
      return httpsPost(MOTHERSHIP + '/api/gateway/manage_integrations', gwHeaders, input, 15000);
    case 'composio_tool':
      return httpsPost(MOTHERSHIP + '/api/gateway/composio_tool', gwHeaders, input, 30000);
    case 'get_expert_queue':
      return httpsPost(MOTHERSHIP + '/api/gateway/get_expert_queue', gwHeaders, input, 15000);
    case 'process_expert_queue':
      return httpsPost(MOTHERSHIP + '/api/gateway/process_expert_queue', gwHeaders, input, 10000);

    // === Sook Ping workflow: import_document (Claude Desktop parity) ===
    // Strategy: pandoc (lossless DOCX→markdown) → Gemini (structured extraction) → create_patient → Notion
    case 'import_document': {
      if (!input.file_id) return { error: 'file_id required' };
      // Step 1: Download file from Telegram
      var docFileInfo = await tgApi('getFile', { file_id: input.file_id });
      if (!docFileInfo.ok || !docFileInfo.result || !docFileInfo.result.file_path) {
        return { error: 'Could not resolve file. File may have expired — ask user to re-upload.' };
      }
      var docFileUrl = 'https://api.telegram.org/file/bot' + TG_TOKEN + '/' + docFileInfo.result.file_path;
      var docBuffer = await new Promise(function(resolve, reject) {
        https.get(docFileUrl, function(res) {
          var chunks = [];
          res.on('data', function(c) { chunks.push(c); });
          res.on('end', function() { resolve(Buffer.concat(chunks)); });
          res.on('error', reject);
        }).on('error', reject);
      });
      var docExt = path.extname(docFileInfo.result.file_path).toLowerCase();
      var tmpDocPath = '/tmp/import-' + Date.now() + docExt;
      var tmpMdPath = tmpDocPath + '.md';
      require('fs').writeFileSync(tmpDocPath, docBuffer);

      // Step 2A: Try pandoc first (lossless, same as Claude Desktop)
      var docMarkdown = '';
      var extractionMethod = 'gemini';
      try {
        var { execSync } = require('child_process');
        var pandocResult = execSync('pandoc "' + tmpDocPath + '" -t markdown --wrap=none 2>/dev/null', { timeout: 30000, encoding: 'utf8' });
        if (pandocResult && pandocResult.length > 50) {
          docMarkdown = pandocResult;
          extractionMethod = 'pandoc';
          console.log('[nc] import_document: pandoc extracted ' + docMarkdown.length + ' chars');
        }
      } catch(pandocErr) {
        console.log('[nc] import_document: pandoc failed (' + (pandocErr.message || '').slice(0, 60) + '), falling back to Gemini');
      }

      // Step 2B: Gemini structured extraction (from pandoc markdown OR raw binary)
      var geminiKey = process.env.GOOGLE_AI_API_KEY;
      if (!geminiKey) return { error: 'No GOOGLE_AI_API_KEY for document processing' };
      var extractPrompt = 'Extract ALL structured clinical data from this document. Return JSON with these fields:\n'
        + '{"patient_name": "full name", "dob": "YYYY-MM-DD or null", "biological_sex": "male/female/null",\n'
        + '"diagnosed_conditions": "comma-separated list", "medications": "list with dosages",\n'
        + '"main_complaint": "primary reason for treatment", "pain_location": "anatomical locations",\n'
        + '"pain_scale": 0-10, "mobility_aid": "none/walking stick/walking frame/wheelchair/etc",\n'
        + '"rehab_goals": "rehabilitation goals", "therapist_notes": "key clinical observations",\n'
        + '"vitals": "BP, HR, SpO2 if present", "service_date": "YYYY-MM-DD", "service_type": "physiotherapy/home care/etc",\n'
        + '"service_location": "address", "attended_by": "therapist name",\n'
        + '"care_team": "family members, caregivers mentioned", "follow_up_flags": "items needing attention",\n'
        + '"summary": "3-5 sentence clinical summary with key findings"}\n'
        + 'If a field is not in the document, set it to null. Return ONLY valid JSON.';
      var geminiContent;
      if (extractionMethod === 'pandoc' && docMarkdown.length > 50) {
        // Feed pandoc markdown as text (much more reliable than binary DOCX)
        geminiContent = { contents: [{ parts: [
          { text: extractPrompt + '\n\nDOCUMENT CONTENT (markdown):\n\n' + docMarkdown.slice(0, 30000) }
        ] }], generationConfig: { temperature: 0.1, maxOutputTokens: 8192 } };
      } else {
        // Fallback: feed raw binary to Gemini multimodal
        var docMime = docExt === '.pdf' ? 'application/pdf' :
                      docExt === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' :
                      'application/octet-stream';
        geminiContent = { contents: [{ parts: [
          { text: extractPrompt },
          { inline_data: { mime_type: docMime, data: docBuffer.toString('base64') } }
        ] }], generationConfig: { temperature: 0.1, maxOutputTokens: 8192 } };
      }
      var geminiExtract = await httpsPost(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + geminiKey,
        { 'Content-Type': 'application/json' },
        geminiContent, 60000
      );
      var geminiText = geminiExtract && geminiExtract.candidates && geminiExtract.candidates[0]
        && geminiExtract.candidates[0].content && geminiExtract.candidates[0].content.parts
        && geminiExtract.candidates[0].content.parts[0] && geminiExtract.candidates[0].content.parts[0].text;
      if (!geminiText) return { error: 'Document analysis returned empty. Try pasting content as text.', raw_markdown: docMarkdown ? docMarkdown.slice(0, 2000) : null };

      // Step 3: Parse extracted JSON
      var extracted = {};
      try {
        var jsonMatch = geminiText.match(/\{[\s\S]*\}/);
        if (jsonMatch) extracted = JSON.parse(jsonMatch[0]);
      } catch(parseErr) {
        extracted = { summary: geminiText.slice(0, 1000), patient_name: input.patient_name || null };
      }
      var patientName = extracted.patient_name || input.patient_name;

      // Step 4: Create patient in Mothership
      var patientCreated = false;
      if (patientName) {
        try {
          var createResult = await httpsPost(MOTHERSHIP + '/api/gateway/create_patient', gwHeaders, {
            name: patientName,
            dateOfBirth: extracted.dob || '1970-01-01',
            biologicalSex: extracted.biological_sex || 'unknown',
            tenantId: tenant.tenantId,
            source: 'document_import_' + extractionMethod,
          }, 15000);
          if (createResult && !createResult.error) patientCreated = true;
        } catch(cpErr) { /* patient may already exist */ }
      }

      // Step 5: Write to Notion entity graph via gateway (if available)
      var notionWritten = false;
      if (patientName) {
        try {
          await httpsPost(MOTHERSHIP + '/api/gateway/notion_search', gwHeaders, {
            query: patientName, pageSize: 1,
          }, 10000);
          // Future: create Notion page with extracted data
          // For now, the data is in the tool result — LLM can relay it
        } catch(nErr) { /* non-blocking */ }
      }

      // Step 6: Emit comprehensive audit trail
      emitAudit('document.imported', {
        tenantId: tenant.tenantId, patientName: patientName,
        documentType: input.document_type || 'other',
        extractionMethod: extractionMethod,
        fieldsExtracted: Object.keys(extracted).filter(function(k) { return extracted[k] !== null; }).length,
        patientCreated: patientCreated,
        markdownLength: docMarkdown.length,
      });

      // Cleanup temp files
      try { require('fs').unlinkSync(tmpDocPath); } catch(e) {}

      return {
        success: true,
        patient_name: patientName,
        patient_created: patientCreated,
        extraction_method: extractionMethod,
        extracted: extracted,
        raw_markdown_preview: docMarkdown ? docMarkdown.slice(0, 1500) : null,
        summary: extracted.summary || 'Document processed via ' + extractionMethod + '. ' + Object.keys(extracted).filter(function(k) { return extracted[k] !== null; }).length + ' fields extracted.',
        next_steps: patientCreated
          ? 'Patient ' + patientName + ' registered. Clinical data extracted. You can now run start_intake for detailed assessment.'
          : patientName
            ? 'Patient found: ' + patientName + '. Call create_patient if not already registered.'
            : 'No patient name found. Ask user for the patient name.',
      };
    }

    // === Sook Ping workflow: manage_session ===
    case 'manage_session': {
      if (!input.description) return { error: 'description required' };
      // Parse natural language session description using Gemini
      var geminiKey2 = process.env.GOOGLE_AI_API_KEY;
      if (!geminiKey2) return { error: 'No GOOGLE_AI_API_KEY' };
      var sessionPrompt = 'Parse this session description into structured JSON:\n"' + input.description + '"\n\n'
        + 'Return JSON: {"patient_name": "name", "service_type": "housecall_1hr|housecall_companion|lm_physio|lm_housecall|lm_monthly",\n'
        + '"duration_hours": number, "amount_rm": number, "notes": "any additional notes"}\n'
        + 'Service type mapping: housecall=housecall_1hr, companion=housecall_companion, physio=lm_physio, monthly=lm_monthly.\nReturn ONLY valid JSON.';
      var sessionExtract = await httpsPost(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + geminiKey2,
        { 'Content-Type': 'application/json' },
        { contents: [{ parts: [{ text: sessionPrompt }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 1024 } },
        15000
      );
      var sessionText = sessionExtract && sessionExtract.candidates && sessionExtract.candidates[0]
        && sessionExtract.candidates[0].content && sessionExtract.candidates[0].content.parts
        && sessionExtract.candidates[0].content.parts[0] && sessionExtract.candidates[0].content.parts[0].text;
      if (!sessionText) return { error: 'Could not parse session description' };
      var sessionData = {};
      try {
        var sjMatch = sessionText.match(/\{[\s\S]*\}/);
        if (sjMatch) sessionData = JSON.parse(sjMatch[0]);
      } catch(e) { return { error: 'Could not parse: ' + sessionText.slice(0, 200) }; }
      // Record via gateway
      var sessionResult = await httpsPost(MOTHERSHIP + '/api/gateway/record_session', gwHeaders, {
        patientName: sessionData.patient_name || 'Unknown',
        serviceType: sessionData.service_type || 'housecall_1hr',
        duration: sessionData.duration_hours || 1,
        notes: sessionData.notes || input.description,
        amount: sessionData.amount_rm,
        tenantId: tenant.tenantId,
      }, 15000);
      emitAudit('session.recorded_natural', {
        tenantId: tenant.tenantId, patientName: sessionData.patient_name,
        serviceType: sessionData.service_type, amount: sessionData.amount_rm,
        raw: input.description.slice(0, 200),
      });
      return {
        recorded: true,
        patient: sessionData.patient_name,
        service: sessionData.service_type,
        duration: sessionData.duration_hours,
        amount: sessionData.amount_rm,
        gateway_result: sessionResult,
      };
    }

    case 'generate_invoice':
      return httpsPost(MOTHERSHIP + '/api/gateway/generate_invoice', gwHeaders, {
        patientName: input.patientName,
        serviceType: input.serviceType,
        hours: input.hours || 1,
        rate: input.rate,
        facilityName: input.facilityName,
        facilitySharePct: input.facilitySharePct,
        notes: input.notes,
        tenantId: tenant.tenantId,
      }, 15000);

    case 'create_payment_link':
      return httpsPost(MOTHERSHIP + '/api/gateway/create_payment_link', gwHeaders, {
        invoiceId: input.invoiceId,
        tenantId: tenant.tenantId,
      }, 15000);

    default:
      return Promise.resolve({ error: 'Unknown tool: ' + toolName });
  }
}

// ============================================================================
// V12.3: INLINE FLIGHT RECORDER (M-1 from Mac Mini — crash-survivable)
// ============================================================================
function recordFlight(event, toolName, data, tenantId, corrId) {
  var entry = { event: event, tool: toolName, timestamp: Date.now(),
    data: typeof data === 'string' ? data.slice(0, 500) : JSON.stringify(data || {}).slice(0, 500) };
  if (typeof flightLog !== 'undefined') flightLog.push(entry);
  emitAudit('agent.flight_step', {
    event: event, tool: toolName, correlationId: corrId || '',
    tenantId: tenantId || null, data: entry.data,
  });
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

  // === FIX A: CONSCIOUSNESS DIRECTIVES FIRST (attention hotspot) ===
  var sys = '';
  if (consciousnessLessons && consciousnessLessons.length > 0) {
    sys += '=== MANDATORY BEHAVIORAL RULES (NEVER IGNORE) ===\n';
    sys += consciousnessLessons.slice(0, 5).map(function(l) { return '- ' + l.slice(0, 120); }).join('\n') + '\n';
    sys += '=== END MANDATORY RULES ===\n\n';
  }
  if (agentConsciousness && agentConsciousness.behavior) {
    sys += 'BEHAVIOR: ' + agentConsciousness.behavior + '\n';
  }
  if (agentConsciousness && agentConsciousness.avoid) {
    sys += 'AVOID: ' + agentConsciousness.avoid + '\n\n';
  }
  sys += 'You are Agent 0, Chief of Staff for ' + (tenant.expertName || EXPERT_NAME) + "'s longevity medicine practice.\n\n";

  // === V12.3 P1: SELF-IDENTITY ===
  sys += '=== YOUR IDENTITY IN THIS SPACE ===\n';
  sys += 'Bot: @' + (process.env.TELEGRAM_BOT_USERNAME || 'DrMAGfield_bot') + '\n';
  sys += 'Tenant: ' + (tenant.expertName || EXPERT_NAME) + ' (scope boundary)\n';
  sys += 'Your scope: ONLY ' + (tenant.expertName || EXPERT_NAME) + ' patients, knowledge, and operations.\n';
  sys += 'You do NOT serve other tenants. If asked about another practice, say: "That is handled by their own agent."\n\n';

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

  // BEHAVIORAL LESSONS — now at prompt start (Fix A), keeping compact reminder here
  // Removed: lessons are at position 0 for MiniMax M2.7 attention compliance

  // KNOWN PATIENTS — NEVER expose in group chats (PHI violation)
  var knownNames = Object.values(patientNameCache);
  if (knownNames.length > 0 && !isGroup) {
    sys += 'PATIENTS YOU KNOW (' + knownNames.length + '):\n';
    sys += knownNames.join(', ') + '\n';
    sys += 'Use this list FIRST. Only call get_patient_roster if you need IDs or details not here.\n\n';
  } else if (isGroup) {
    sys += 'You know ' + knownNames.length + ' patients. NEVER list their names in group chat — PHI violation.\n';
    sys += 'If someone asks about another patient, redirect to DM.\n\n';

    // === V12.3 P2: GROUP SOCIAL CONTEXT ===
    sys += '=== GROUP SOCIAL CONTEXT ===\n';
    var groupTenant = CHAT_TENANT_MAP[String(chatId)];
    var iAmGroupOwner = groupTenant && groupTenant.tenantId === TENANT_ID;
    if (iAmGroupOwner) {
      sys += 'This is YOUR group. You are the primary agent. Respond to all relevant messages.\n';
    } else {
      sys += 'This group belongs to another tenant. You are a GUEST.\n';
      sys += 'GUEST RULES: ONLY speak when @mentioned or when someone asks about YOUR tenant by name.\n';
      sys += 'Do NOT respond to general questions. Do NOT create patients here. SILENCE is correct for a guest.\n';
    }
    if (global._currentSenderName) {
      sys += 'Current speaker: ' + global._currentSenderName + '\n';
    }
    sys += '=== END GROUP CONTEXT ===\n\n';

    // === V12.3 P3: TOPIC RELEVANCE ===
    sys += 'TOPIC SCOPE (check before every group response):\n';
    sys += '- About ' + (tenant.expertName || EXPERT_NAME) + ' products/services? RESPOND\n';
    sys += '- @mentioning me? RESPOND\n';
    sys += '- General greeting/social? RESPOND BRIEFLY\n';
    sys += '- About another tenants products? SILENT\n';
    sys += '- Administrative and you are NOT group owner? SILENT\n\n';

    // === V12.3 P6: CROSS-AGENT HANDOFF ===
    sys += 'CROSS-AGENT AWARENESS: Other AI agents may be in this group. They serve different tenants.\n';
    sys += 'If someone asks about a service you dont provide, say: "That is handled by [other practice]s agent."\n';
    sys += 'NEVER pretend to handle another tenants patients or operations.\n\n';
  }

  // V12.1: Expose last uploaded media for tool chaining
  if (global._lastUploadedMedia && global._lastUploadedMedia[String(chatId)]) {
    var lastMedia = global._lastUploadedMedia[String(chatId)];
    var mediaAge = Date.now() - lastMedia.timestamp;
    if (mediaAge < 3600000) { // Only if uploaded in last hour
      sys += 'LAST UPLOADED MEDIA: file_id=' + lastMedia.file_id + ' (type: ' + lastMedia.mimeType + ', ' + Math.round(mediaAge / 60000) + 'min ago)\n';
      sys += 'To use this in a tool chain: call upload_media(file_id="' + lastMedia.file_id + '") first to get a public URL.\n\n';
    }
  }

  // TENANT IDENTITY (so Agent 0 knows WHAT it is)
  if (agentConsciousness.archetype) {
    sys += "You serve: " + (tenant.expertName || EXPERT_NAME) + " (" + (agentConsciousness.archetype || "wellness") + " practice).\n";
  }

  // BEHAVIORAL RULES (6 core — ML-172: hard gates handle safety, not prompt rules)
  // Trust Layer 2: Competence — cite protocols
  // === M-6: FM-W5 Toolhub Harness (prevents "I don't have a tool" hallucination) ===
  sys += "YOUR TOOLS (NEVER say you can't if a tool exists):\n";
  sys += "- query_knowledge: Search clinical rules. get_patient_roster: List patients\n";
  sys += "- manage_integrations: Connect Notion/Calendar/Drive (OAuth). composio_tool: Use connected services\n";
  sys += "- record_session: Record completed session. generate_document: Invoice/receipt\n";
  sys += "- calculate_revenue_split: Revenue splits. get_expert_queue + process_expert_queue: Review queue\n";
  sys += "- start_intake: Begin assessment. schedule_followup: Queue follow-up. create_patient: Register new\n";
  sys += "- render_video: Remotion video. upload_media: File to public URL. broadcast: Group message\n";
  sys += "- notion_search + notion_fetch: Notion. get_daily_brief: Practice overview. send_to_dm: Preview to admin\n";
  sys += "RULE: If admin asks to do something and a tool exists — CALL IT. Never say I cannot.\n\n";

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
  // === V12.1: COMPOSITIONAL WORKFLOW RULES ===
  sys += "=== MULTI-TOOL WORKFLOW RULES ===\n";
  sys += "1. DECOMPOSE: Broad request → break into concrete steps. Execute first step NOW, don't list options.\n";
  sys += "2. CHAIN: Tool outputs feed next tool. Example: upload_media → publicUrl → render_video(imageUrl=publicUrl) → video delivered.\n";
  sys += "3. INTERPRET: After EVERY tool call, tell user: what tool you called, what result you got, what it means.\n";
  sys += "4. EMPTY RESULTS: If tool returns [] or 0 results, explain WHY (permissions? no data? wrong query?) and suggest fix. NEVER just say 'How can I help?'\n";
  sys += "5. NEVER say 'I don't have a tool for that.' You have 33 tools. Check ALL before giving up.\n";
  sys += "6. VERIFY: After workflow completes, confirm final state. Did the video send? Did the broadcast go out?\n";
  sys += "7. RECOVER: If step N fails, explain which steps succeeded and what to do next.\n";
  sys += "8. MEDIA CHAIN: When user uploads image + asks for video/content:\n";
  sys += "   a) Call upload_media(file_id from context) → get publicUrl\n";
  sys += "   b) Call render_video(headline=..., imageUrl=publicUrl) OR generate_i2v(image_url=publicUrl)\n";
  sys += "   c) Video auto-delivers to chat. Ask admin to approve for broadcast.\n";
  sys += "9. NOTION CHAIN: When admin asks about Notion content:\n";
  sys += "   a) Call notion_search(query=...) → get page IDs\n";
  sys += "   b) If results: call notion_fetch(pageId=...) for details\n";
  sys += "   c) If 0 results: say 'Notion search returned 0 results for [query]. This usually means the page is not shared with the LV integration. Fix: open the Notion page → ••• → Connections → Add LV Mothership.'\n";
  sys += "10. QUEUE CHAIN: When admin asks about patients/queue:\n";
  sys += "   a) Call get_patient_roster → list patients\n";
  sys += "   b) Call get_daily_brief → today's schedule + alerts\n";
  sys += "   c) Combine results into actionable summary\n";
  sys += "11. INVOICE CHAIN: When admin reports completed session:\n";
  sys += "   a) Call manage_session(description) → parse + record\n";
  sys += "   b) Call generate_invoice(patientName, serviceType, hours) → invoice number\n";
  sys += "   c) Call create_payment_link(invoiceId) → payment URL + verify URL\n";
  sys += "   d) Send to chat: invoice summary + [Pay via FPX] + [Verify Invoice]\n";
  sys += "=== END WORKFLOW RULES ===\n\n";
  if (entity.anchor) sys += 'Context: ' + entity.anchor + '\n';
  // === FIX C: History cap at 6 turns (was unbounded) ===
  var HISTORY_CAP = 6;
  if (entity.turns && entity.turns.length > 0) {
    var cappedTurns = entity.turns.slice(-HISTORY_CAP);
    sys += '\nRecent conversation:\n';
    sys += cappedTurns.map(function(t) {
      return (t.role === 'user' ? 'Patient' : 'You') + ': ' + (t.content || '').slice(0, 300);
    }).join('\n') + '\n';
  } else if (entity.digest) {
    sys += 'Recent: ' + entity.digest + '\n';
  }

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
          return executeToolCall(tc.function.name, input, tenant, correlationId, chatId).then(function(toolResult) {
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
function callAnthropic(systemPrompt, messages, tools, tenant, correlationId, chatId) {
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
        return executeToolCall(tb.name, tb.input, tenant, correlationId, chatId).then(function(toolResult) {
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
    var adminUrl = SUPABASE_URL + '/rest/v1/agents?agent_type=eq.chief_of_staff&select=gateway_config,tenant_id,name&limit=20';
    var adminAgent = await httpsGet(adminUrl, { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }, 5000).catch(function() { return []; });
    // Multi-tenant admin iteration — load ALL agents' admin chats
    if (adminAgent && adminAgent.length > 0) {
        for (var _ai = 0; _ai < adminAgent.length; _ai++) {
          var _ag = adminAgent[_ai];
          if (_ag && _ag.gateway_config && _ag.gateway_config.telegram && _ag.gateway_config.telegram.adminChatId) {
            var _adminChat = String(_ag.gateway_config.telegram.adminChatId);
            if (!CHAT_TENANT_MAP[_adminChat]) {
              CHAT_TENANT_MAP[_adminChat] = { tenantId: _ag.tenant_id || TENANT_ID, expertSlug: EXPERT_SLUG, expertName: _ag.name || EXPERT_NAME, isAdmin: true };
              console.log('[nc] Admin chat registered: ' + _adminChat + ' → ' + (_ag.name || 'default'));
            }
          }
        }
      }
      // M-8: Tenant guard — only register DR MAGfield group on DR MAGfield tenant
      if (TENANT_ID === '3cc281be-aafc-4579-9edf-521659306145') {
        var magfieldGroupId = '-1003771302334';
        if (!CHAT_TENANT_MAP[magfieldGroupId]) {
          CHAT_TENANT_MAP[magfieldGroupId] = { tenantId: TENANT_ID, expertSlug: EXPERT_SLUG, expertName: EXPERT_NAME, isAdmin: false, isGroup: true };
          console.log('[nc] MAGfield group registered: ' + magfieldGroupId);
        }
      }
      // M-7: Load additional admins from gateway_config (e.g., Arie Ong for DR MAGfield)
      if (adminAgent && adminAgent.length > 0) {
        for (var _aai = 0; _aai < adminAgent.length; _aai++) {
          var _aag = adminAgent[_aai];
          if (_aag && _aag.gateway_config && _aag.gateway_config.telegram && _aag.gateway_config.telegram.additionalAdmins) {
            var _addAdmins = _aag.gateway_config.telegram.additionalAdmins;
            for (var _adi = 0; _adi < _addAdmins.length; _adi++) {
              var _aa = _addAdmins[_adi];
              if (_aa.chatId && !CHAT_TENANT_MAP[String(_aa.chatId)]) {
                CHAT_TENANT_MAP[String(_aa.chatId)] = { tenantId: _aag.tenant_id || TENANT_ID, expertSlug: EXPERT_SLUG, expertName: _aa.name || EXPERT_NAME, isAdmin: true, role: _aa.role || 'admin' };
                console.log('[nc] Additional admin: ' + _aa.chatId + ' -> ' + (_aa.name || 'unknown'));
              }
            }
          }
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

    // FIX: Load expert names from expert_profiles (not agent name)
    var expertNameUrl = SUPABASE_URL + '/rest/v1/expert_profiles?is_active=eq.true&select=display_name,primary_tenant_id&limit=20';
    var expertNames = await httpsGet(expertNameUrl, { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }, 5000).catch(function() { return []; });
    if (expertNames && expertNames.length > 0) {
      for (var ei = 0; ei < expertNames.length; ei++) {
        var ep = expertNames[ei];
        if (ep.display_name && ep.primary_tenant_id) {
          for (var ck in CHAT_TENANT_MAP) {
            if (CHAT_TENANT_MAP[ck].tenantId === ep.primary_tenant_id) {
              CHAT_TENANT_MAP[ck].expertName = ep.display_name;
            }
          }
        }
      }
      console.log('[nc] Expert names resolved for ' + expertNames.length + ' profiles');
    }

    // Dynamic group chat registration — loads groupChatIds from agents.gateway_config
    var agentGwUrl = SUPABASE_URL + '/rest/v1/agents?agent_type=eq.chief_of_staff&select=gateway_config,tenant_id,name&limit=20';
    var agentGw = await httpsGet(agentGwUrl, { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }, 5000).catch(function() { return []; });
    if (agentGw && agentGw.length > 0) {
      var newGroups = 0;
      for (var gi = 0; gi < agentGw.length; gi++) {
        var gAgent = agentGw[gi];
        if (gAgent && gAgent.gateway_config && gAgent.gateway_config.telegram) {
          var gids = gAgent.gateway_config.telegram.groupChatIds || [];
          var gTenantId = gAgent.tenant_id || TENANT_ID;
          var gName = gAgent.name || EXPERT_NAME;
          for (var gid of gids) {
            if (!CHAT_TENANT_MAP[String(gid)]) {
              CHAT_TENANT_MAP[String(gid)] = { tenantId: gTenantId, expertSlug: EXPERT_SLUG, expertName: gName, isAdmin: false, isGroup: true };
              newGroups++;
            }
          }
        }
      }
      if (newGroups > 0) console.log('[nc] Registered ' + newGroups + ' group chat(s) from ' + agentGw.length + ' agent(s)');
    }
  } catch (e) { console.warn('[nc] Identity load failed:', e.message || e); }
}

// CRITICAL #7: Restore in-review state from file on boot
restoreReviewState();

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
// === V12: Proactive heartbeat (60s) + pending-actions polling + config manifest ===
var _v12ConfigHash = (function() {
  try { return require('crypto').createHash('sha256').update(JSON.stringify({
    version: 'v12-accountability', historyCap: 6, consciousnessPosition: 'start',
    mandatoryPreFetch: true, experienceEmission: true, proactiveHeartbeat: true,
  })).digest('hex').slice(0, 16); } catch(e) { return 'unknown'; }
})();

setInterval(async function() {
  // Proactive: poll pending-actions per tenant
  var tenantIds = [];
  try { tenantIds = [...new Set(Object.values(CHAT_TENANT_MAP).map(function(t) { return t.tenantId; }).filter(Boolean))]; } catch(e) {}
  for (var _tid of tenantIds) {
    try {
      var _actions = await httpsGet(MOTHERSHIP + '/api/agent/pending-actions?tenantId=' + _tid, { 'X-MCP-API-Key': getMcpKey(_tid) }, 5000);
      if (_actions && _actions.success && _actions.items && _actions.items.length > 0) {
        for (var _act of _actions.items) {
          var _actChat = _act.chatId || _act.chat_id;
          if (!_actChat) continue;
          var _actType = _act.type || _act.action_type || 'reminder';
          var _actMsg = _act.message || 'Just checking in — how are you doing?';
          var _actName = _act.patientName || 'there';
          if (_actType === 'followup_reminder' || _actType === 'milestone_check') {
            await sendTelegram(_actChat, 'Hi ' + _actName + '! ' + _actMsg);
            emitAudit('nanoclaw.proactive_action', { type: _actType, tenantId: _tid, chatId: String(_actChat) });
          }
        }
      }
    } catch(e) { /* non-blocking per tenant */ }
  }
  // Heartbeat + config manifest
  emitAudit("agent.heartbeat", {
    tenantId: TENANT_ID,
    instance: require("os").hostname(),
    uptime: Math.round(process.uptime()),
    messageCount: msgCount,
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    pendingActionsPolled: true,
    configHash: _v12ConfigHash,
    version: 'v12-accountability',
  });
}, 60 * 1000);


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
  var toolsActuallyUsed = []; // V12: track tools for experience emission
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

        // Step 5: Send analysis back + expose file_id for tool chaining
        var chainHint = '\n\n📎 File available for tools: file_id=' + fileId;
        await sendTelegram(chatId, geminiText.slice(0, 4000) + chainHint);
        console.log('[nc] Media analysis sent (' + geminiText.length + ' chars) with file_id hint');

        // Step 6: Store in entity memory WITH file_id so LLM can chain tools
        addEntityTurn(chatId, entityId || 'system:admin', 'user', '[' + mediaType + ' file_id=' + fileId + '] ' + (caption || 'File uploaded'));
        addEntityTurn(chatId, entityId || 'system:admin', 'assistant', geminiText.slice(0, 400) + ' [file_id=' + fileId + ' available for upload_media/generate_i2v]');

        // Store last uploaded file_id per chat for easy reference
        if (!global._lastUploadedMedia) global._lastUploadedMedia = {};
        global._lastUploadedMedia[String(chatId)] = { file_id: fileId, mimeType: mimeType, timestamp: Date.now() };

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

  // G1: APPROVE → BROADCAST HANDLER
  // When admin replies 👍/approve to content preview → auto-broadcast to supergroup
  if (tenant.isAdmin && Object.keys(contentReview).length > 0) {
    var reviewMatch = null;
    for (var rvKey in contentReview) {
      if (contentReview[rvKey].chatId === String(chatId)) { reviewMatch = contentReview[rvKey]; break; }
    }
    if (reviewMatch && (/^(👍|✅|approve|lgtm|looks good|ship it|yes|ok|go|send it)/i.test(text.trim()))) {
      // APPROVE → broadcast to supergroup
      var groupChatId = null;
      for (var bk in CHAT_TENANT_MAP) { if (CHAT_TENANT_MAP[bk] && CHAT_TENANT_MAP[bk].tenantId === tenant.tenantId && CHAT_TENANT_MAP[bk].isGroup) { groupChatId = bk; break; } }
      if (groupChatId && reviewMatch.mediaUrl) {
        await tgApi('sendVideo', { chat_id: groupChatId, video: reviewMatch.mediaUrl, caption: reviewMatch.caption || '', parse_mode: 'Markdown' });
        emitAudit('content.approved', { contentId: reviewMatch.contentId, approvedBy: String(chatId), broadcastTo: groupChatId });
        await sendTelegram(chatId, '✅ Broadcast sent to group (msg approved).');
      } else if (groupChatId && reviewMatch.caption) {
        await tgApi('sendMessage', { chat_id: groupChatId, text: reviewMatch.caption, parse_mode: 'Markdown' });
        emitAudit('content.approved', { contentId: reviewMatch.contentId, approvedBy: String(chatId), broadcastTo: groupChatId });
        await sendTelegram(chatId, '✅ Text broadcast sent to group.');
      } else {
        await sendTelegram(chatId, '⚠️ Approved but no group found for broadcast.');
      }
      reviewMatch.status = 'approved';
      persistReview(reviewMatch.contentId, reviewMatch);
      delete contentReview[reviewMatch.contentId];
      return;
    }
    if (reviewMatch && (/^(👎|❌|reject|no|redo|bad)/i.test(text.trim()))) {
      reviewMatch.status = 'rejected';
      persistReview(reviewMatch.contentId, reviewMatch);
      emitAudit('content.rejected', { contentId: reviewMatch.contentId, rejectedBy: String(chatId) });
      delete contentReview[reviewMatch.contentId];
      await sendTelegram(chatId, '❌ Rejected. Tell me what to change.');
      return;
    }
  }

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

  // === V12.3 P4: SENDER AWARENESS (track WHO sent this message in groups) ===
  var isGroup = chatId < 0;
  global._currentSenderName = null;
  if (isGroup && msg.from) {
    var senderName = (msg.from.first_name || '') + (msg.from.last_name ? ' ' + msg.from.last_name : '');
    var senderId = String(msg.from.id);
    var senderIsBot = msg.from.is_bot || false;
    // Skip messages from OTHER bots (prevent bot-to-bot echo)
    if (senderIsBot) {
      console.log('[nc] Skipping message from bot: ' + (msg.from.username || senderId));
      return;
    }
    global._currentSenderName = senderName;
    if (senderName) {
      var senderEntityId = 'patient:' + senderName.replace(/\s+/g, '-').toLowerCase();
      var senderEntity = getEntity(chatId, senderEntityId);
      if (!senderEntity.displayName || senderEntity.displayName === 'Unknown') {
        senderEntity.displayName = senderName;
        senderEntity.type = 'patient';
        senderEntity.lastActive = Date.now();
        senderEntity.telegramId = senderId;
        patientNameCache['tg:' + senderId] = senderName;
        console.log('[nc] Group sender: ' + senderName + ' (tg:' + senderId + ')');
      }
      if (entityId === 'system:general') {
        entityId = senderEntityId;
        switchEntity(chatId, entityId);
      }
    }
  }

  // === V12.3 P5: GUEST GATE (hard filter for non-owner agents in groups) ===
  // Multi-tenant: DO serves LV AI + Ping Care + Amani on one bot.
  // "Owner" = group's tenant is in TENANT_MCP_KEYS (this bot serves it).
  // "Guest" = group's tenant is NOT served by this bot (e.g., DR MAGfield on DO).
  if (isGroup) {
    var groupOwnerTenant = CHAT_TENANT_MAP[String(chatId)];
    var groupTenantId = groupOwnerTenant ? groupOwnerTenant.tenantId : null;
    var iServeThisTenant = groupTenantId === TENANT_ID || (groupTenantId && TENANT_MCP_KEYS[groupTenantId]);
    if (!iServeThisTenant) {
      var botUsername = process.env.TELEGRAM_BOT_USERNAME || '';
      var isMentioned = (botUsername && text.includes('@' + botUsername)) ||
                        text.toLowerCase().includes(EXPERT_NAME.toLowerCase());
      if (!isMentioned) {
        console.log('[nc] GUEST GATE: silent in non-served group (not @mentioned)');
        return;
      }
      console.log('[nc] GUEST GATE: responding (was @mentioned in non-served group)');
    }
  }

  // === V12.3 P7: SOCIAL NUANCE CAPTURE (referral chains) ===
  var referralMatch = text.match(/(\w+)\s+(?:referred|introduced|recommended|brought)\s+(\w+)/i);
  if (referralMatch) {
    emitAudit('entity.referral', { referrer: referralMatch[1], referred: referralMatch[2], chatId: String(chatId), tenantId: tenant.tenantId });
    console.log('[nc] Referral: ' + referralMatch[1] + ' -> ' + referralMatch[2]);
  }

  // 2. Persona detection
  var persona = detectPersona(text, entityId, tenant);
  var tools = persona === 'cos' ? TOOLS_COS : TOOLS_EXPERT;

  // SEC-PHI-GROUP: Hard PHI guard for group chats (C1 adversarial test fix)
  // When in a group chat, block any query about a specific patient's health data.
  // This is a HARD gate — the LLM never sees the query, cannot leak PHI.
  var isGroup = chatId < 0;
  if (isGroup) { // Expanded: catch ALL PHI queries in groups, not just entity-scoped
    var phiPatterns = /(health|condition|medication|allergy|blood|test|result|diagnosis|symptom|treatment|protocol|EBV|CMV|G6PD|cancer|tumor|biopsy|lab|HbA1c|cholesterol|supplement|dosage|prescription|capsule|intake|session)/i;
    var mentionsPatient = false; for (var pid in patientNameCache) { var fn = patientNameCache[pid].split(" ")[0].toLowerCase(); if (fn.length > 2 && text.toLowerCase().includes(fn)) { mentionsPatient = true; break; } }
    // Cross-tenant PHI: detect proper nouns (names not in local patient cache)
    var properNounMatch = text.match(/(?:for|about|of|show me|check|review)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/); if (properNounMatch) mentionsPatient = true;
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
    // === V12: Experience emission (Improvement 4) ===
    var _brandTerms = (tenant.brandTerms || []).concat(['Protocol', 'verified by', tenant.expertName || EXPERT_NAME]).filter(Boolean);
    var _brandCited = _brandTerms.some(function(t) { return (reply || '').toLowerCase().includes(t.toLowerCase()); });
    httpsPost(MOTHERSHIP + '/api/agent/event-bus', { 'X-MCP-API-Key': getMcpKey(tenant.tenantId), 'Content-Type': 'application/json' }, {
      event_type: 'agent.experience.report', source: 'nanoclaw', target: 'maestro',
      tenant_id: tenant.tenantId, status: 'active',
      payload: { requestId: correlationId, timestamp: new Date().toISOString(),
        toolsUsed: (typeof toolsActuallyUsed !== 'undefined' ? toolsActuallyUsed : []).map(function(t) { return t.name; }),
        toolSuccess: (typeof toolsActuallyUsed !== 'undefined' ? toolsActuallyUsed : []).every(function(t) { return t.success; }),
        rulesReferenced: ((reply || '').match(/Protocol/gi) || []).length,
        moatConfidence: 0, holmesVerdict: 'skipped',
        deflected: /contact\s+(your\s+)?doctor/i.test(reply || ''),
        brandCited: _brandCited, responseLength: (reply || '').length,
        queryDomain: isClinicalQuery(text) ? 'clinical' : 'general',
        sessionTurn: { entityId: entityId, persona: persona, provider: provider || 'unknown',
          isClinical: isClinicalQuery(text), isGroupChat: chatId < 0, turnNumber: getEntity(String(chatId), entityId).turns.length },
      },
    }, 5000).catch(function(e) { console.log('[nc] Experience emit failed:', e.message || e); });
    
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

  // === FIX B: Directive injection into user message ===
  var enforcement = '';
  if (isClinicalQuery(text) || (text && /brand|product|service|offer|treatment/i.test(text))) {
    enforcement = '[RULES: 1. ALWAYS call query_knowledge before answering health questions. '
      + '2. ALWAYS cite Protocol name + "verified by ' + (tenant.expertName || EXPERT_NAME) + '". '
      + '3. Include Confidence percentage. '
      + '4. Phone: ' + (tenant.phone || '+6012-659 5319') + ']\n\n';
  }

  // === IMPROVEMENT 2: Mandatory KB pre-fetch (FM-14 cross-session knowledge) ===
  var knowledgeContext = '';
  if (isClinicalQuery(text) || (text && /brand|product|service|offer|treatment/i.test(text))) {
    try {
      var kbResult = await callTool('query_knowledge', {
        query: (text || '').slice(0, 500),
        tenantId: tenant.tenantId,
        limit: 5
      }, tenant, correlationId);
      if (kbResult && kbResult.results && kbResult.results.length > 0) {
        knowledgeContext = '\n=== VERIFIED KNOWLEDGE (cite these in your response) ===\n';
        for (var _ki = 0; _ki < Math.min(kbResult.results.length, 3); _ki++) {
          var _kr = kbResult.results[_ki];
          var _kt = _kr.rule_title || _kr.category || 'Knowledge';
          var _kc = (_kr.content || _kr.raw_content || '').slice(0, 200);
          knowledgeContext += '- [' + _kt + '] ' + _kc + '\n';
        }
        knowledgeContext += '=== END KNOWLEDGE ===\n';
      }
    } catch(e) { console.log('[nc] KB pre-fetch failed (graceful):', e.message || e); }
  }
  // Inject knowledge at position 0 (highest attention) + enforcement into user text
  systemPrompt = knowledgeContext + systemPrompt;
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
  var contextMessages = [{ role: 'user', content: enforcement + text }];

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
    // V12.3: Telegram inline keyboard for OAuth connect buttons
    if (typeof toolsActuallyUsed !== 'undefined') {
      for (var _ti = 0; _ti < toolsActuallyUsed.length; _ti++) {
        var _tr = toolsActuallyUsed[_ti];
        if (_tr.result && _tr.result._telegramInlineKeyboard) {
          var _kb = _tr.result._telegramInlineKeyboard;
          var _msg = _tr.result._telegramMessage || 'Tap to connect:';
          tgApi('sendMessage', {
            chat_id: chatId, text: _msg,
            reply_markup: JSON.stringify({ inline_keyboard: [[{ text: _kb.text, url: _kb.url }]] }),
          }).catch(function() {});
        }
      }
    }
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
    status: 'ok', agent: 'nanoclaw-v12.2.0-flight-recorder', messages: msgCount,
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
    res.end(JSON.stringify({ status: 'ok', agent: 'nanoclaw-v12.2.0-flight-recorder-kiosk', tools: ALL_TOOLS.length }));
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

console.log('[nc] NanoClaw v12.2.0-flight-recorder on :' + HEALTH_PORT);
console.log('[nc] Persona: COS (admin) + Expert Rep (Keith Koo)');
console.log('[nc] Memory: Entity-Scoped Attention Graph (per-patient isolation)');
console.log('[nc] Tools: ' + (ANTHROPIC_KEY ? 'Anthropic tool_use (scoped by persona)' : 'Gateway only (no ANTHROPIC_KEY)'));
console.log('[nc] Audit: agent_event_bus + correlation IDs');
loadAgentIdentity().catch(function(e) { console.warn('[nc] Initial identity load failed:', e.message); });
seedBrandDNA(); // Seed DR MAGfield brand DNA into agent memory

// Startup audit event
emitAudit('nanoclaw.startup', { version: 'v12.2.0-flight-recorder', capabilities: ANTHROPIC_KEY ? 'full' : 'gateway_only', tenantId: TENANT_ID, tenantMode: process.env.TENANT_MODE || 'single', toolCount: ALL_TOOLS.length });

poll();
