/**
 * excalibur-capi
 * Recebe eventos do lado do navegador (LP Excalibur) e reenvia
 * server-side para a Meta Conversions API, com o mesmo event_id
 * usado no fbq() do navegador (dedupe automático no Ads Manager).
 *
 * Também recebe eventos offline (lead qualificado, agendamento, venda)
 * reportados manualmente depois da conversa no WhatsApp, casando com o
 * fbp/fbc do clique original via um código de referência curto (ref)
 * guardado no KV.
 *
 * Env vars esperadas (wrangler secret / vars):
 *   META_ACCESS_TOKEN     -> token de sistema com permissão ads_management (secret)
 *   PIXEL_ID              -> 1916536729320394 (var, já tem default abaixo)
 *   TEST_EVENT_CODE       -> opcional, código do Test Events (Events Manager)
 *   ALLOWED_ORIGIN        -> opcional, ex: https://excaliburfestas.netlify.app
 *   OFFLINE_EVENTS_TOKEN  -> secret, obrigatório pra usar POST /offline-event
 *
 * Bindings esperados (wrangler.toml):
 *   LEADS  -> KV namespace, guarda ref -> {fbp, fbc, event_source_url, ts}
 */

const DEFAULT_PIXEL_ID = '1916536729320394';
const REF_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 dias, alinhado à janela de atribuição de clique da Meta

const ATTRIBUTION_KEYS = ['fbclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'campaign_id', 'adset_id', 'ad_id'];

// Eventos offline aceitos no /offline-event -> nome do evento mandado pra Meta.
// "Lead Qualificado", "Agendamento" e "Venda" (== Purchase, evento padrão da Meta).
const OFFLINE_EVENT_MAP = {
  LeadQualificado: 'LeadQualificado',
  Agendamento: 'Schedule',
  Venda: 'Purchase',
};

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Offline-Token',
  };
}

function jsonResponse(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

async function sha256Hex(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

function normalizePhone(phone) {
  // Meta espera só dígitos, com código do país, sem "+" nem espaços.
  return String(phone).replace(/[^\d]/g, '');
}

async function sendToMeta(env, eventEntry) {
  const pixelId = env.PIXEL_ID || DEFAULT_PIXEL_ID;
  const payload = { data: [eventEntry] };
  if (env.TEST_EVENT_CODE) payload.test_event_code = env.TEST_EVENT_CODE;

  const metaRes = await fetch(
    `https://graph.facebook.com/v20.0/${pixelId}/events?access_token=${env.META_ACCESS_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );
  return { status: metaRes.status, data: await metaRes.json() };
}

function buildCustomData(attribution) {
  const customData = {};
  if (attribution && typeof attribution === 'object') {
    for (const key of ATTRIBUTION_KEYS) {
      const value = attribution[key];
      if (typeof value === 'string' && value.length > 0 && value.length <= 256) {
        customData[key] = value;
      }
    }
  }
  return customData;
}

// POST /event — evento do lado do navegador (PageView já é padrão; aqui
// tratamos LeadQualificado e Lead). Se vier "ref", guarda fbp/fbc no KV
// pra permitir casar com um evento offline depois.
async function handleEvent(request, env, headers) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'invalid_json' }, 400, headers);
  }

  const { event_name, event_id, event_source_url, fbp, fbc, attribution, ref } = body || {};

  if (!event_name || !event_id) {
    return jsonResponse({ error: 'missing_event_name_or_event_id' }, 400, headers);
  }
  if (!env.META_ACCESS_TOKEN) {
    return jsonResponse({ error: 'server_not_configured' }, 500, headers);
  }

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ua = request.headers.get('User-Agent') || '';

  const userData = { client_ip_address: ip, client_user_agent: ua };
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;

  const customData = buildCustomData(attribution);

  const eventEntry = {
    event_name,
    event_time: Math.floor(Date.now() / 1000),
    event_id,
    event_source_url: event_source_url || '',
    action_source: 'website',
    user_data: userData,
  };
  if (Object.keys(customData).length > 0) eventEntry.custom_data = customData;

  if (ref && env.LEADS) {
    try {
      await env.LEADS.put(
        `ref:${ref}`,
        JSON.stringify({ fbp: fbp || '', fbc: fbc || '', event_source_url: event_source_url || '', ts: Date.now() }),
        { expirationTtl: REF_TTL_SECONDS }
      );
    } catch (e) {
      // Não bloqueia o envio do evento principal se o KV falhar.
    }
  }

  try {
    const { status, data } = await sendToMeta(env, eventEntry);
    return jsonResponse(data, status, headers);
  } catch (err) {
    return jsonResponse({ error: 'meta_request_failed', detail: String(err) }, 502, headers);
  }
}

// POST /offline-event — reportado manualmente quando o lead vira
// LeadQualificado / Agendamento / Venda depois da conversa no WhatsApp.
// Body: { ref, event_name, phone?, email? }
// Requer header X-Offline-Token igual a env.OFFLINE_EVENTS_TOKEN.
async function handleOfflineEvent(request, env, headers) {
  if (!env.OFFLINE_EVENTS_TOKEN) {
    return jsonResponse({ error: 'offline_events_not_configured' }, 500, headers);
  }
  const token = request.headers.get('X-Offline-Token') || '';
  if (token !== env.OFFLINE_EVENTS_TOKEN) {
    return jsonResponse({ error: 'unauthorized' }, 401, headers);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: 'invalid_json' }, 400, headers);
  }

  const { ref, event_name, phone, email } = body || {};
  const metaEventName = OFFLINE_EVENT_MAP[event_name];
  if (!metaEventName) {
    return jsonResponse({ error: 'invalid_event_name', allowed: Object.keys(OFFLINE_EVENT_MAP) }, 400, headers);
  }
  if (!phone && !email) {
    return jsonResponse({ error: 'missing_phone_or_email' }, 400, headers);
  }
  if (!env.META_ACCESS_TOKEN) {
    return jsonResponse({ error: 'server_not_configured' }, 500, headers);
  }

  let stored = null;
  if (ref && env.LEADS) {
    try {
      const raw = await env.LEADS.get(`ref:${ref}`);
      if (raw) stored = JSON.parse(raw);
    } catch (e) {
      // segue sem fbp/fbc se o KV falhar ou o ref não existir/expirou
    }
  }

  const userData = {};
  if (phone) userData.ph = await sha256Hex(normalizePhone(phone));
  if (email) userData.em = await sha256Hex(normalizeEmail(email));
  if (stored?.fbp) userData.fbp = stored.fbp;
  if (stored?.fbc) userData.fbc = stored.fbc;

  const eventEntry = {
    event_name: metaEventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: `offline-${ref || 'noref'}-${metaEventName}-${Date.now()}`,
    event_source_url: stored?.event_source_url || '',
    action_source: 'system_generated',
    user_data: userData,
  };

  try {
    const { status, data } = await sendToMeta(env, eventEntry);
    return jsonResponse({ matched_ref: Boolean(stored), meta: data }, status, headers);
  } catch (err) {
    return jsonResponse({ error: 'meta_request_failed', detail: String(err) }, 502, headers);
  }
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(env);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }
    if (url.pathname.endsWith('/health')) {
      return new Response('ok', { status: 200, headers });
    }
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'method_not_allowed' }, 405, headers);
    }

    if (url.pathname.endsWith('/offline-event')) {
      return handleOfflineEvent(request, env, headers);
    }
    return handleEvent(request, env, headers);
  },
};
