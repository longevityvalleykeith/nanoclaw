#!/usr/bin/env node
/**
 * NanoClaw v11 — Entity-Scoped Attention Graph Memory (ESAGM)
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
const fs = require('fs');
const path = require('path');

const NANOCLAW_VERSION = 'v11.2.0'; // S1-S4 + T2A direct voice, chatId passthrough, 5-provider LLM router
const TENANT_MODE = process.env.TENANT_MODE || 'multi';
const BOT_USERNAME = process.env.BOT_USERNAME || 'LongevityValley_Bot';

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MOTHERSHIP = process.env.LV_BACKEND_URL || 'https://app.longevityvalley.ai';
const MCP_KEY = process.env.MCP_API_KEY;

// Per-tenant MCP key map (prevents cross-tenant data leak)
var TENANT_MCP_KEYS = {};
if (TENANT_MODE === 'multi') {
  TENANT_MCP_KEYS = {
    'abe1b946-6643-4acc-9cc1-6a47336d31d8': process.env.MCP_API_KEY_AMANI || MCP_KEY,   // Amani Wellness
    '3cc281be-aafc-4579-9edf-521659306145': process.env.MCP_API_KEY_MAGFIELD || MCP_KEY,  // DR MAGfield
    '313a6002-5718-4c28-8fe1-82f831b83cdf': MCP_KEY,                                      // Keith LV (default)
  };
}
function getMcpKey(tenantId) {
  if (TENANT_MODE === 'single') return MCP_KEY;
  return TENANT_MCP_KEYS[tenantId] || MCP_KEY;
}
if (!MCP_KEY) { console.error('[nc] FATAL: MCP_API_KEY not set'); process.exit(1); }
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const MINIMAX_KEY = process.env.MINIMAX_API_KEY || '';
const MINIMAX_URL = 'https://api.minimax.io/v1/chat/completions';
const MINIMAX_MODEL = 'MiniMax-M2.7';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CRON_SECRET = process.env.CRON_SECRET || '';
const POLL_TIMEOUT = 30;
const TENANT_ID = process.env.TENANT_ID || '313a6002-5718-4c28-8fe1-82f831b83cdf';
const EXPERT_NAME = process.env.EXPERT_NAME || 'Keith Koo';
const EXPERT_SLUG = process.env.EXPERT_SLUG || 'keith-koo';
const HEALTH_PORT = 3002;
const GATEWAY_TIMEOUT = 120000;

if (!TG_TOKEN) { console.error('[nc] FATAL: TELEGRAM_BOT_TOKEN not set'); process.exit(1); }

// ============================================================================
// S1: PROCESS CRASH RECOVERY
// ============================================================================
process.on('uncaughtException', function(err) {
  console.error('[nc] UNCAUGHT EXCEPTION:', err.message, err.stack);
  emitAudit('nanoclaw.crash', { type: 'uncaughtException', error: err.message });
  // Give audit time to flush, then exit with error code
  setTimeout(function() { process.exit(1); }, 2000);
});
process.on('unhandledRejection', function(reason) {
  console.error('[nc] UNHANDLED REJECTION:', reason);
  emitAudit('nanoclaw.crash', { type: 'unhandledRejection', error: String(reason) });
});

// ============================================================================
// S2: GRACEFUL SHUTDOWN
// ============================================================================
var healthServer = null; // assigned later at startup
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
var GATEWAY_CB_COOLDOWN_MS = 60000; // 1 minute
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

// Strip <think>...</think> tags and clean LLM artifacts from response
function cleanResponse(text) {
  if (!text) return text;
  // Remove <think>...</think> blocks (including multiline)
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // Remove any remaining orphaned think tags
  text = text.replace(/<\/?think>/gi, '').trim();
  return text || 'I understand. How can I help?';
}

function sendTelegram(chatId, text) {
  var clean = text.replace(/<think>[^]*?<\/think>/g, '').replace(/<\/?think>/g, '').replace(/<!-- .*? -->/g, '').trim();
  if (!clean) clean = 'How can I help?';
  var truncated = clean.length > 4000 ? clean.slice(0, 3997) + '...' : clean;
  return tgApi('sendMessage', { chat_id: chatId, text: truncated, parse_mode: 'Markdown' })
    .catch(function() { return tgApi('sendMessage', { chat_id: chatId, text: truncated }); });
}

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
    {
      name: 'report_incident',
      description: 'Report a violation, failure, or anomaly to Mothership. Use when: cross-tenant data leak, PHI violation, hallucinated data, tool failure.',
      input_schema: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Incident severity' },
          type: { type: 'string', enum: ['cross-tenant-data-leak', 'phi-violation', 'hallucinated-data', 'tool-failure', 'delivery-failure', 'compliance-violation', 'other'], description: 'Incident type' },
          description: { type: 'string', description: 'What happened' },
          affectedPatient: { type: 'string', description: 'Patient name or ID if relevant' },
          remediation: { type: 'string', description: 'What was done to fix it' }
        },
        required: ['severity', 'type', 'description']
      }
    },
    {
      name: 'request_capability',
      description: 'Request a new tool or integration from Mothership. Use when a needed capability does not exist yet.',
      input_schema: {
        type: 'object',
        properties: {
          capability: { type: 'string', description: 'What is needed — e.g. PDF reading, WhatsApp outbound' },
          reason: { type: 'string', description: 'Why this is needed' },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'How urgent' },
          requestedBy: { type: 'string', description: 'Who is requesting' }
        },
        required: ['capability', 'reason']
      }
    },
  { name: 'create_checkout_link', description: 'Create Stripe checkout link for product purchase (Qi Master, Qi Mini). Returns payment URL.', input_schema: { type: 'object', properties: { productId: { type: 'string', description: 'qi-master or qi-mini' }, patientName: { type: 'string', description: 'Patient name' } }, required: ['productId'] } },
  { name: 'voice_response', description: 'Convert text to speech audio and send as Telegram voice message. Use for accessibility or when patient prefers audio.', input_schema: { type: 'object', properties: { text: { type: 'string', description: 'Text to speak (max 5000 chars)' } }, required: ['text'] } },
];


// ============================================================================
// DYNAMIC TOOL DISCOVERY (v11) — boot-time fetch from Mothership
// Falls back to hardcoded ALL_TOOLS if fetch fails. Caches to disk.
// ============================================================================
var HARDCODED_TOOLS = ALL_TOOLS.slice(); // preserve original

async function discoverTools() {
  try {
    var resp = await httpsPost(MOTHERSHIP + '/api/gateway', { 'X-MCP-API-Key': MCP_KEY }, { method: 'tools/list' }, 15000);
    if (resp && resp.tools && Array.isArray(resp.tools) && resp.tools.length > 0) {
      var discovered = resp.tools.map(function(t) {
        return {
          name: t.name,
          description: t.description || '',
          input_schema: t.inputSchema || t.input_schema || { type: 'object', properties: {} },
        };
      });
      // Merge: discovered tools + any hardcoded-only tools not in discovered set
      var discoveredNames = new Set(discovered.map(function(t) { return t.name; }));
      for (var i = 0; i < HARDCODED_TOOLS.length; i++) {
        if (!discoveredNames.has(HARDCODED_TOOLS[i].name)) discovered.push(HARDCODED_TOOLS[i]);
      }
      if (discovered.length >= 10) {
        ALL_TOOLS = discovered;
        console.log('[nc] Tool discovery: ' + discovered.length + ' tools accepted');
      } else {
        console.warn('[nc] Tool discovery: only ' + discovered.length + ' tools — keeping existing ' + ALL_TOOLS.length);
      }
      // Update scoped tool lists
      TOOLS_COS = ALL_TOOLS;
      TOOLS_EXPERT = ALL_TOOLS.filter(function(t) { return t.name !== 'task_mirror'; });
      // Cache to disk
      try { fs.writeFileSync('/tmp/nanoclaw-tools-cache.json', JSON.stringify(ALL_TOOLS, null, 2)); } catch(e) {}
      console.log('[nc] Dynamic tools discovered: ' + ALL_TOOLS.length + ' tools from Mothership');
      return;
    }
  } catch(e) {
    console.warn('[nc] Dynamic tool discovery failed: ' + (e.message || e));
  }
  // Fallback: try disk cache
  try {
    var cached = JSON.parse(fs.readFileSync('/tmp/nanoclaw-tools-cache.json', 'utf8'));
    if (cached && cached.length > 0) {
      ALL_TOOLS = cached;
      TOOLS_COS = ALL_TOOLS;
      TOOLS_EXPERT = ALL_TOOLS.filter(function(t) { return t.name !== 'task_mirror'; });
      console.log('[nc] Loaded ' + ALL_TOOLS.length + ' tools from cache');
      return;
    }
  } catch(e) {}
  console.log('[nc] Using ' + ALL_TOOLS.length + ' hardcoded tools (discovery + cache failed)');
}

// Scope by persona
var TOOLS_COS = ALL_TOOLS; // Admin gets everything
var TOOLS_EXPERT = ALL_TOOLS.filter(function(t) { return t.name !== 'task_mirror'; }); // Expert gets clinical tools

// SEC-06: Sanitize string inputs before tool calls
function sanitize(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[\x00-\x1f]/g, '').replace(/[<>]/g, '').slice(0, 500);
}

async function executeToolCall(toolName, input, tenant, correlationId, chatId) {
  // SEC-06: Validate tool name against allowlist
  var allowedTools = ['query_knowledge', 'get_patient_roster', 'create_patient', 'start_intake', 'ask_wellness_question', 'get_synthesized_capsule', 'task_mirror', 'verify_response', 'send_to_group', 'schedule_followup', 'list_scheduled_tasks', 'report_incident', 'request_capability', 'create_checkout_link', 'voice_response'];
  if (allowedTools.indexOf(toolName) === -1) {
    return Promise.resolve({ error: 'Tool not in allowlist: ' + toolName });
  }
  // Sanitize all string inputs
  for (var key in input) {
    if (typeof input[key] === 'string') input[key] = sanitize(input[key]);
  }
  var authHeaders = { 'x-cron-secret': CRON_SECRET, 'x-correlation-id': correlationId };
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
      return httpsPost(MOTHERSHIP + '/api/gateway/ask_wellness_question', gwHeaders, {
        question: input.question,
        context: { tenantId: tenant.tenantId, domain: 'wellness' },
      }, GATEWAY_TIMEOUT);

    case 'get_synthesized_capsule':
      return httpsPost(MOTHERSHIP + '/api/gateway/capsule', gwHeaders, {
        expertSlug: tenant.expertSlug,
        sessionId: input.sessionId || tenant.tenantId,
        message: input.message,
      }, GATEWAY_TIMEOUT); // 120s — capsule runs full flywheel

    case 'send_to_group': {
      // TENANT-SCOPED: Only send to THIS tenant's group (ML-175 fix)
      var groupChatId = null;
      var myGroups = tenantGroups[tenant.tenantId] || [];
      if (myGroups.length > 0) {
        groupChatId = myGroups[0];
      }
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

    
    case 'report_incident':
      return httpsPost(MOTHERSHIP + '/api/gateway/report_incident', gwHeaders, {
        severity: input.severity,
        type: input.type,
        description: input.description,
        affectedPatient: input.affectedPatient || null,
        remediation: input.remediation || null,
        reportedBy: 'agent-0-' + tenant.tenantId,
      }, 15000);

    case 'request_capability':
      return httpsPost(MOTHERSHIP + '/api/gateway/request_capability', gwHeaders, {
        capability: input.capability,
        reason: input.reason,
        priority: input.priority || 'medium',
        requestedBy: input.requestedBy || 'agent-0',
      }, 15000);

    case 'create_checkout_link': {
      var ckBody = { productId: input.productId || 'qi-master', tenantId: tenant.tenantId, expertId: tenant.expertSlug, patientName: input.patientName || '', quantity: 1, successUrl: MOTHERSHIP + '/checkout?success=true', cancelUrl: MOTHERSHIP + '/checkout?canceled=true' };
      var ckResult = await httpsPost(MOTHERSHIP + '/api/billing/product-checkout', { 'Content-Type': 'application/json' }, ckBody);
      if (ckResult && ckResult.checkoutUrl) return { checkoutUrl: ckResult.checkoutUrl, product: ckResult.product, total: ckResult.totalUsd };
      return { error: 'Checkout failed', fallback: MOTHERSHIP + '/checkout' };
    }

    case 'voice_response': {
      // T2A: Try direct MiniMax API first (per-tenant BYOK key), Mothership fallback
      var ttsText = (input.text || '').slice(0, 5000);
      var ttsKey = process.env.MINIMAX_TTS_API_KEY || process.env.MINIMAX_API_KEY || '';
      var audioUrl = null;

      // Path A: Direct MiniMax T2A (speech-2.8-hd, fastest)
      if (ttsKey && ttsKey.startsWith('sk-api-')) {
        try {
          var t2aResult = await httpsPost('https://api.minimax.io/v1/t2a_v2', {
            'Authorization': 'Bearer ' + ttsKey,
            'Content-Type': 'application/json',
          }, {
            model: process.env.MINIMAX_TTS_MODEL || 'speech-02-hd',
            text: ttsText,
            voice_setting: { voice_id: input.voiceId || 'male-qn-qingse', speed: 1.0, vol: 1.0 },
            output_format: 'url',
          }, 15000);
          if (t2aResult && t2aResult.base_resp && t2aResult.base_resp.status_code === 0) {
            audioUrl = (t2aResult.data && t2aResult.data.audio) || (t2aResult.audio_file && t2aResult.audio_file.url) || null;
          } else {
            console.warn('[nc] Direct T2A error:', (t2aResult.base_resp || {}).status_msg || 'unknown');
          }
        } catch (t2aErr) {
          console.warn('[nc] Direct T2A failed:', t2aErr.message || t2aErr);
        }
      }

      // Path B: Mothership /api/agent/tts fallback (has per-tenant BYOK resolution)
      if (!audioUrl) {
        try {
          var ttsHeaders = { 'Content-Type': 'application/json' };
          if (process.env.CRON_SECRET) ttsHeaders['Authorization'] = 'Bearer ' + process.env.CRON_SECRET;
          var ttsResult = await httpsPost(MOTHERSHIP + '/api/agent/tts', ttsHeaders, {
            text: ttsText, tenantId: tenant.tenantId, voiceId: input.voiceId,
          }, 15000);
          if (ttsResult && ttsResult.success) audioUrl = ttsResult.audioUrl;
        } catch (e) { console.warn('[nc] Mothership T2A fallback failed:', e.message); }
      }

      // Send voice note to Telegram
      if (audioUrl && chatId) {
        await tgApi('sendVoice', { chat_id: chatId, voice: audioUrl, caption: ttsText.slice(0, 100) });
        emitAudit('tts.delivered', { chatId: chatId, tenantId: tenant.tenantId, textLength: ttsText.length });
        return { sent: true, audioUrl: audioUrl };
      }
      return { error: 'Voice generation failed — no T2A key (sk-api-) or Mothership unreachable' };
    }

    default:
      // ADAPTIVE PROXY: Any tool from Mothership SSOT dispatched via generic gateway
      if (ALL_TOOLS && ALL_TOOLS.find(function(t) { return t.name === toolName; })) {
        console.log('[nc] Dynamic tool dispatch: ' + toolName + ' → gateway');
        return httpsPost(MOTHERSHIP + '/api/gateway/' + toolName, gwHeaders, input, 30000);
      }
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

  var tenantLabel = tenant.tenantId === '313a6002-5718-4c28-8fe1-82f831b83cdf' ? 'longevity medicine practice'
    : tenant.tenantId === 'abe1b946-6643-4acc-9cc1-6a47336d31d8' ? 'Amani Wellness wellness practice'
    : tenant.tenantId === '3cc281be-aafc-4579-9edf-521659306145' ? 'DR MAGfield magnetic therapy practice'
    : 'wellness practice';
  var sys = 'You are Agent 0, Chief of Staff for ' + tenantLabel + '.\n\n';

  // IDENTITY
  var expertDisplayName = tenant.tenantId === 'abe1b946-6643-4acc-9cc1-6a47336d31d8' ? 'Dr Jeffrey Chew (Amani Wellness)'
    : tenant.tenantId === '3cc281be-aafc-4579-9edf-521659306145' ? 'DR MAGfield'
    : (tenant.expertName || EXPERT_NAME);
  sys += 'Expert: ' + expertDisplayName + '. ';
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
  // CONSCIOUSNESS (per-tenant)
  var tc = (tenantConsciousness[tenant.tenantId] || {}).consciousness || agentConsciousness || {};
  var tl = (tenantConsciousness[tenant.tenantId] || {}).lessons || consciousnessLessons || [];
  if (tc && tc.tone) {
    sys += 'Your personality: ' + tc.tone + '.\n';
    if (tc.behavior) sys += tc.behavior + '.\n';
    if (tc.avoid) sys += 'Avoid: ' + tc.avoid + '.\n';
    sys += '\n';
  }

  // PATIENT
  if (patientName) {
    sys += 'You\'re talking to ' + patientName + '. Call them ' + patientName.split(' ')[0] + '. Be personal.\n\n';
  }

  // BEHAVIORAL LESSONS (compact — max 1 line per lesson)
  if (tl.length > 0) {
    sys += 'Lessons: ' + tl.slice(0, 3).map(function(l) { return l.slice(0, 60); }).join('. ') + '.\n';
  }

  // KNOWN PATIENTS — NEVER expose in group chats (PHI violation)
  // Use per-tenant patient list to prevent cross-tenant data leak
  var tenantPatients = (typeof tenantPatientCache !== 'undefined' && tenantPatientCache[tenant.tenantId]) || patientNameCache;
  var knownNames = Object.values(tenantPatients);
  if (knownNames.length > 0 && !isGroup) {
    sys += 'PATIENTS YOU KNOW (' + knownNames.length + '):\n';
    sys += knownNames.join(', ') + '\n';
    sys += 'Use this list FIRST. Only call get_patient_roster if you need IDs or details not here.\n\n';
  } else if (isGroup) {
    sys += 'You know ' + knownNames.length + ' patients. NEVER list their names in group chat — PHI violation.\n';
    sys += 'If someone asks about another patient, redirect to DM.\n\n';
  }

  // TENANT IDENTITY (so Agent 0 knows WHAT it is)
  if (tc.archetype) {
    sys += "You serve: " + expertDisplayName + " (" + (tc.archetype || "wellness") + " practice).\n";
  }

  // BEHAVIORAL RULES (6 core — ML-172: hard gates handle safety, not prompt rules)
  sys += "Rules:\n";
  sys += "- Be warm, curious, conversational. Companion, not form.\n";
  sys += "- Execute admin tasks immediately using tools. Look up patient data yourself — never ask admin what the KB already knows.\n";
  var adminName = tenant.tenantId === 'abe1b946-6643-4acc-9cc1-6a47336d31d8' ? 'the Amani Wellness team'
    : tenant.tenantId === '3cc281be-aafc-4579-9edf-521659306145' ? 'Arie'
    : 'Keith';
  sys += "- When unsure: Let me check with " + adminName + " on that.\n";
  sys += "- send_to_group = GROUP (everyone sees). schedule_followup = queued (needs patient DM).\n";
  if (isGroup) sys += "- GROUP: Never mention other patients. Never list names. PHI queries = redirect to DM.\n";
  sys += "\n";
  if (entity.anchor) sys += 'Context: ' + entity.anchor + '\n';
  if (entity.digest) sys += 'Recent: ' + entity.digest + '\n';

  return sys;
}


// ============================================================================
// S4: MODEL-AGNOSTIC LLM ROUTER
// ============================================================================
// Supported providers: minimax, anthropic, openai, deepseek, google
// Each provider has its own call function. callLLM() dispatches by provider name.
// Adding a new provider: 1) write callXxx() 2) add case to callLLM() 3) add env key check

var LLM_PROVIDERS = {
  minimax:   { available: !!MINIMAX_KEY,   name: 'MiniMax M2.7' },
  anthropic: { available: !!ANTHROPIC_KEY, name: 'Anthropic Haiku 4.5' },
  openai:    { available: !!(process.env.OPENAI_API_KEY), name: 'OpenAI' },
  deepseek:  { available: !!(process.env.DEEPSEEK_API_KEY), name: 'DeepSeek' },
  google:    { available: !!(process.env.GOOGLE_AI_API_KEY), name: 'Google Gemini' },
};

/**
 * Model-agnostic LLM call. Dispatches to provider-specific function.
 * @param {string} provider - 'minimax' | 'anthropic' | 'openai' | 'deepseek'
 * @param {string} systemPrompt
 * @param {Array} messages
 * @param {Array} tools
 * @param {object} tenant
 * @param {string} correlationId
 * @returns {Promise<string|null>}
 */
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

/**
 * Resolve which LLM provider to use for a given query.
 * Clinical → Anthropic (safety-proven). Admin/content → MiniMax (cheaper).
 * Fallback chain: primary → secondary → tertiary.
 */
function resolveLLMProvider(text) {
  if (isClinicalQuery(text)) {
    // Clinical: Anthropic > MiniMax > OpenAI
    if (LLM_PROVIDERS.anthropic.available) return 'anthropic';
    if (LLM_PROVIDERS.minimax.available) return 'minimax';
    if (LLM_PROVIDERS.openai.available) return 'openai';
  } else {
    // Admin/content: MiniMax > Anthropic > OpenAI > DeepSeek
    if (LLM_PROVIDERS.minimax.available) return 'minimax';
    if (LLM_PROVIDERS.anthropic.available) return 'anthropic';
    if (LLM_PROVIDERS.openai.available) return 'openai';
    if (LLM_PROVIDERS.deepseek.available) return 'deepseek';
  }
  return 'anthropic'; // last resort
}

// ============================================================================
// OPENAI-COMPATIBLE PROVIDER (works for OpenAI, DeepSeek, and other OpenAI-API-compatible services)
// ============================================================================
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

function callOpenAI(systemPrompt, messages, tools, tenant, correlationId, chatId) {
  return callOpenAICompatible('https://api.openai.com/v1/chat/completions', process.env.OPENAI_API_KEY || '', process.env.OPENAI_MODEL || 'gpt-4.1-mini', systemPrompt, messages, tools, tenant, correlationId, chatId);
}

function callDeepSeek(systemPrompt, messages, tools, tenant, correlationId, chatId) {
  return callOpenAICompatible('https://api.deepseek.com/v1/chat/completions', process.env.DEEPSEEK_API_KEY || '', process.env.DEEPSEEK_MODEL || 'deepseek-chat', systemPrompt, messages, tools, tenant, correlationId, chatId);
}

// ============================================================================
// MINIMAX M2.7 TOOL_USE (OpenAI-compatible format)
// Used for non-clinical queries: admin tasks, scheduling, roster, group messages
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
          var resultStr = JSON.stringify(toolResult).slice(0, 3000).replace(/<think>[^]*?<\/think>/g, '').replace(/<\/?think>/g, '');
          return { type: 'tool_result', tool_use_id: tb.id, content: resultStr };
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
    chatId: String(chatId), entityId: entityId,
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
var tenantConsciousness = {}; // per-tenant consciousness map
var tenantPatientCache = {}; // per-tenant patient name cache
var consciousnessLessons = [];
var patientNameCache = {};

async function loadAgentIdentity() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    // Phase 1: Load consciousness from Mothership API (dynamic, per-tenant)
    var consciousnessUrl = MOTHERSHIP + '/api/agent/consciousness?tenantId=' + TENANT_ID + '';
    var ctx = await httpsGet(consciousnessUrl, { 'X-MCP-API-Key': (typeof tenant !== 'undefined' && tenant ? getMcpKey(tenant.tenantId) : MCP_KEY) }, 10000).catch(function() { return null; });

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
    // Load patient names per-tenant (prevents cross-tenant data leak)
    patientNameCache = {};
    var tenantPatientCache = {};
    var knownTenants = new Set();
    for (var ck in CHAT_TENANT_MAP) { if (CHAT_TENANT_MAP[ck]) knownTenants.add(CHAT_TENANT_MAP[ck].tenantId); }
    knownTenants.add(TENANT_ID);
    for (var ptid of knownTenants) {
      var idUrl = SUPABASE_URL + '/rest/v1/patient_identities?tenant_id=eq.' + ptid + '&preferred_name=not.is.null&select=patient_profile_id,preferred_name&limit=100';
      var identities = await httpsGet(idUrl, { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }, 5000).catch(function() { return []; });
      tenantPatientCache[ptid] = {};
      if (identities) for (var id of identities) {
        if (id.preferred_name && id.patient_profile_id) {
          tenantPatientCache[ptid][id.patient_profile_id] = id.preferred_name;
          if (ptid === TENANT_ID) patientNameCache[id.patient_profile_id] = id.preferred_name;
        }
      }
    }
    var totalPatients = Object.values(tenantPatientCache).reduce(function(s, t) { return s + Object.keys(t).length; }, 0);
    console.log('[nc] Loaded ' + totalPatients + ' patient names across ' + knownTenants.size + ' tenant(s)');
    // Dynamic admin chat loading — resolve from agents table
    var adminUrl = SUPABASE_URL + '/rest/v1/agents?agent_type=eq.chief_of_staff&select=gateway_config,tenant_id,name&limit=20';
    var adminAgent = await httpsGet(adminUrl, { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }, 5000).catch(function() { return []; });
    if (adminAgent && adminAgent.length > 0) {
      for (var ai = 0; ai < adminAgent.length; ai++) {
        var ag = adminAgent[ai];
        if (ag && ag.gateway_config && ag.gateway_config.telegram) {
          var tgConfig = ag.gateway_config.telegram;
          var agTenantId = ag.tenant_id || TENANT_ID;
          var agName = ag.name || EXPERT_NAME;
          if (tgConfig.adminChatId && !CHAT_TENANT_MAP[String(tgConfig.adminChatId)]) {
            CHAT_TENANT_MAP[String(tgConfig.adminChatId)] = { tenantId: agTenantId, expertSlug: EXPERT_SLUG, expertName: agName, isAdmin: true };
            console.log('[nc] Admin chat registered: ' + tgConfig.adminChatId + ' → ' + agName);
          }
        }
      }
    }
    // Load behavioral lessons for ALL tenants from consciousness.update events
    var allTenantIds = new Set();
    for (var ck in CHAT_TENANT_MAP) { if (CHAT_TENANT_MAP[ck]) allTenantIds.add(CHAT_TENANT_MAP[ck].tenantId); }
    allTenantIds.add(TENANT_ID);
    var _prevLessons = consciousnessLessons.slice();
    var _prevConsciousness = Object.assign({}, agentConsciousness);
    consciousnessLessons = [];
    for (var tid of allTenantIds) {
      var lessonsUrl = SUPABASE_URL + '/rest/v1/agent_event_bus?event_type=eq.consciousness.update&status=eq.completed&tenant_id=eq.' + tid + '&select=payload&order=created_at.desc&limit=10';
      var lessonEvents = await httpsGet(lessonsUrl, { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }, 5000).catch(function() { return []; });
      var tLessons = [];
      var tConsciousness = {};
      if (lessonEvents && lessonEvents.length > 0) {
        for (var le of lessonEvents) {
          var lp = le.payload;
          if (lp && lp.behavior) tLessons.push(lp.behavior);
          if (lp && lp.tone && !tConsciousness.tone) tConsciousness.tone = lp.tone;
          if (lp && lp.archetype && !tConsciousness.archetype) tConsciousness.archetype = lp.archetype;
          if (lp && lp.avoid && !tConsciousness.avoid) tConsciousness.avoid = lp.avoid;
          if (lp && lp.behavior && !tConsciousness.behavior) tConsciousness.behavior = lp.behavior;
        }
      }
      tenantConsciousness[tid] = { lessons: Array.from(new Set(tLessons)), consciousness: tConsciousness };
      // Primary tenant also populates the global (backward compat)
      if (tid === TENANT_ID) {
        if (tenantConsciousness[tid].lessons.length > 0) {
          consciousnessLessons = tenantConsciousness[tid].lessons;
          Object.assign(agentConsciousness, tConsciousness);
        } else {
          consciousnessLessons = _prevLessons;
          Object.assign(agentConsciousness, _prevConsciousness);
          console.warn('[nc] Consciousness reload empty — keeping ' + _prevLessons.length + ' existing lessons');
        }
      }
    }
    var totalLessons = Object.values(tenantConsciousness).reduce(function(s, t) { return s + t.lessons.length; }, 0);
    if (totalLessons > 0) console.log('[nc] Loaded ' + totalLessons + ' behavioral lessons across ' + allTenantIds.size + ' tenant(s)');
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
    // Build tenant→group lookup from CHAT_TENANT_MAP
    tenantGroups = {};
    for (var mapKey in CHAT_TENANT_MAP) {
      var mapEntry = CHAT_TENANT_MAP[mapKey];
      if (mapEntry && mapEntry.isGroup && mapEntry.tenantId) {
        if (!tenantGroups[mapEntry.tenantId]) tenantGroups[mapEntry.tenantId] = [];
        tenantGroups[mapEntry.tenantId].push(mapKey);
      }
    }
    var tgCount = Object.keys(tenantGroups).length;
    if (tgCount > 0) console.log('[nc] Tenant→group map: ' + tgCount + ' tenant(s) with groups');
  } catch (e) { console.warn('[nc] Identity load failed:', e.message || e); }
}

setInterval(function() { loadAgentIdentity().catch(function() {}); }, 5 * 60 * 1000);

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
      // TENANT-SCOPED: Use this tenant's group for followup notifications
      var groupId = null;
      var fGroups = tenantGroups[tenant.tenantId] || [];
      if (fGroups.length > 0) { groupId = fGroups[0]; }
      if (!groupId) { for (var gName in knownGroups) { groupId = knownGroups[gName]; break; } }
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
var tenantGroups = {}; // tenantId → chatId (scoped group lookup)
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

  // Hard gate: ignore commands addressed to other bots (G-11)
  if (text && text.includes('@') && !text.includes('@' + BOT_USERNAME)) {
    var botCommandMatch = text.match(/@(\w+)/);
    if (botCommandMatch && botCommandMatch[1] !== BOT_USERNAME) {
      console.log('[nc] Ignoring command for other bot: @' + botCommandMatch[1]);
      return;
    }
  }
  var userName = msg.from ? (msg.from.first_name || msg.from.username || 'User') : 'User';

  // MEDIA RELAY: Forward ALL media (with or without caption) to Mothership for Gemini processing
  // Agent 0 cannot see image content — Mothership has Gemini multimodal pipeline
  var hasMedia = msg.photo || msg.document || msg.voice || msg.video;
  if (hasMedia) {
    var tenant = CHAT_TENANT_MAP[String(chatId)];
    if (!tenant) return;
    var mediaType = msg.photo ? 'image' : msg.document ? 'document' : msg.voice ? 'voice' : 'video';
    console.log('[nc] Media detected (' + mediaType + ') — downloading with Agent 0 bot token');
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

      // Step 7: Relay extracted content to Mothership for KU materialization (closes Telegram↔Desktop gap)
      // This bridges the pipeline disparity — Telegram media → Gemini extraction → Mothership KU
      if (geminiText.length > 100 && tenant && tenant.tenantId) {
        try {
          var matPayload = {
            content: geminiText.slice(0, 8000),
            sourceType: mediaType === 'document' ? 'telegram_document' : 'telegram_' + mediaType,
            sourceFilename: (msg.document && msg.document.file_name) || mediaType + '_' + Date.now(),
            domain: 'clinical',
            tenantId: tenant.tenantId,
          };
          httpsPost(MOTHERSHIP + '/api/gateway/materialize_content',
            { 'X-MCP-API-Key': getMcpKey(tenant.tenantId), 'Content-Type': 'application/json' },
            matPayload, 30000
          ).then(function(r) {
            if (r && r.content) console.log('[nc] Media→KU materialized for tenant ' + tenant.tenantId);
          }).catch(function(e) {
            console.warn('[nc] Media→KU materialization failed (non-blocking):', e.message || e);
          });
        } catch (matErr) {
          // Non-blocking — don't fail the media response if materialization fails
        }
      }
    } catch (mediaErr) {
      console.warn('[nc] Media processing failed:', mediaErr.message || mediaErr);
      await sendTelegram(chatId, 'Could not analyze your file. Please try describing it in text, or send it to @LV_Butler_Bot for processing.');
    }
    return;
  }
  if (!text || text === '/start') return;

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
      await sendTelegram(chatId, 'For patient privacy, I cannot discuss individual health details in the group chat. Please send me a direct message for this — tap @' + BOT_USERNAME + ' and hit Start.');
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
      reply += '- NanoClaw: ' + NANOCLAW_VERSION + '-ESAGM, entities=' + Object.keys(getChat(chatId).entities).length + ', msgs=' + msgCount;
      reply = cleanResponse(reply);
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
          { 'X-MCP-API-Key': getMcpKey(tenant.tenantId) }, 3000
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

    // S4: Model-agnostic LLM routing via resolveLLMProvider()
    var primaryProvider = resolveLLMProvider(text);
    response = await callLLM(primaryProvider, systemPrompt, contextMessages, tools, tenant, correlationId, chatId);

    // Fallback chain: if primary fails, try next available provider
    if (!response) {
      var fallbacks = ['anthropic', 'minimax', 'openai', 'deepseek'].filter(function(p) {
        return p !== primaryProvider && LLM_PROVIDERS[p] && LLM_PROVIDERS[p].available;
      });
      for (var fi = 0; fi < fallbacks.length && !response; fi++) {
        console.warn('[nc] ' + primaryProvider + ' failed, trying ' + fallbacks[fi]);
        response = await callLLM(fallbacks[fi], systemPrompt, contextMessages, tools, tenant, correlationId, chatId);
      }
    }

    // Last resort: gateway text-only
    if (!response) {
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
    response = cleanResponse(response);
    // Hard gate: detect and flag potential fabricated UUIDs (ML-185)
    var uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    var uuidsInResponse = response.match(uuidPattern);
    if (uuidsInResponse && uuidsInResponse.length > 0) {
      console.warn('[nc] WARN: Response contains ' + uuidsInResponse.length + ' UUID(s) — may be fabricated. IDs: ' + uuidsInResponse.join(', '));
      // Don't block — but log for audit. Future: validate against DB.
    }
    await sendTelegram(chatId, response);
    console.log('[nc] Delivered (' + response.length + ' chars) entity=' + entityId);

    // 9. Audit: response delivered (G1)
    persistConversationData(chatId, entityId, text, response, tenant);
    emitAudit('nanoclaw.response', {
      correlationId: correlationId, chatId: chatId, entity: entityId,
      persona: persona, responseLength: response.length,
    });

  } catch (e) {
    clearInterval(typingInterval);
    console.error('[nc] Error:', e.message);
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
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MCP-API-Key': (typeof tenant !== 'undefined' && tenant ? getMcpKey(tenant.tenantId) : MCP_KEY) },
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
      var r = await tgApi('getUpdates', { offset: offset, timeout: POLL_TIMEOUT, allowed_updates: ['message'] });
      if (r.ok && r.result) {
        for (var i = 0; i < r.result.length; i++) {
          offset = r.result[i].update_id + 1;
          if (r.result[i].message) handleMessage(r.result[i].message).catch(function(e) { console.error('[nc] Handler:', e.message); });
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
    status: 'ok', agent: 'nanoclaw-v11-esagm', messages: msgCount,
    uptime: Math.round(process.uptime()),
    memory: { type: 'ESAGM', entities: Object.keys(entities).length }, // SEC-07: no patient names in health
    capabilities: ANTHROPIC_KEY ? 'tool_use+esagm' : 'gateway_only',
  }));
}).listen(HEALTH_PORT, '127.0.0.1'); // SEC-07: localhost only
healthServer = this; // S2: reference for graceful shutdown

console.log('[nc] NanoClaw ' + NANOCLAW_VERSION + ' ESAGM on :' + HEALTH_PORT);
console.log('[nc] Persona: COS (admin) + Expert Rep (Keith Koo)');
console.log('[nc] Memory: Entity-Scoped Attention Graph (per-patient isolation)');
console.log('[nc] Tools: ' + (ANTHROPIC_KEY ? 'Anthropic tool_use (scoped by persona)' : 'Gateway only (no ANTHROPIC_KEY)'));
console.log('[nc] Audit: agent_event_bus + correlation IDs');
console.log('[nc] Version: ' + NANOCLAW_VERSION + ' | Tools: ' + ALL_TOOLS.length);
loadAgentIdentity().catch(function(e) { console.warn('[nc] Initial identity load failed:', e.message); });
discoverTools().catch(function(e) { console.warn('[nc] Tool discovery failed:', e.message); });

// Startup audit event
emitAudit('nanoclaw.startup', { version: NANOCLAW_VERSION, capabilities: ANTHROPIC_KEY ? 'full' : 'gateway_only' });

poll();
