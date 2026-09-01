/**
 * excalibur-capi
 * Recebe eventos do lado do navegador (LP Excalibur) e reenvia
 * server-side para a Meta Conversions API, com o mesmo event_id
 * usado no fbq() do navegador (dedupe automático no Ads Manager).
 *
 * Env vars esperadas (wrangler secret / vars):
 *   META_ACCESS_TOKEN  -> token de sistema com permissão ads_management (secret)
 *   PIXEL_ID           -> 1916536729320394 (var, já tem default abaixo)
 *   TEST_EVENT_CODE    -> opcional, código do Test Events (Events Manager)
 *   ALLOWED_ORIGIN     -> opcional, ex: https://excalibur-orcamento.netlify.app
 */

const DEFAULT_PIXEL_ID = '1916536729320394';

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    if (request.url.endsWith('/health')) {
      return new Response('ok', { status: 200, headers });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
        status: 405,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'invalid_json' }), {
        status: 400,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    const { event_name, event_id, event_source_url, fbp, fbc, attribution } = body || {};

    if (!event_name || !event_id) {
      return new Response(JSON.stringify({ error: 'missing_event_name_or_event_id' }), {
        status: 400,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    if (!env.META_ACCESS_TOKEN) {
      return new Response(JSON.stringify({ error: 'server_not_configured' }), {
        status: 500,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }

    const pixelId = env.PIXEL_ID || DEFAULT_PIXEL_ID;
    const ip = request.headers.get('CF-Connecting-IP') || '';
    const ua = request.headers.get('User-Agent') || '';

    const userData = {
      client_ip_address: ip,
      client_user_agent: ua,
    };
    if (fbp) userData.fbp = fbp;
    if (fbc) userData.fbc = fbc;

    // Atribuição (fbclid, UTMs, campaign/adset/ad id) capturada na LP.
    // Repassada como custom_data pra ficar visível no Events Manager e
    // permitir cruzar lead x anúncio/campanha nos relatórios.
    const ATTRIBUTION_KEYS = ['fbclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'campaign_id', 'adset_id', 'ad_id'];
    const customData = {};
    if (attribution && typeof attribution === 'object') {
      for (const key of ATTRIBUTION_KEYS) {
        const value = attribution[key];
        if (typeof value === 'string' && value.length > 0 && value.length <= 256) {
          customData[key] = value;
        }
      }
    }

    const eventEntry = {
      event_name,
      event_time: Math.floor(Date.now() / 1000),
      event_id,
      event_source_url: event_source_url || '',
      action_source: 'website',
      user_data: userData,
    };
    if (Object.keys(customData).length > 0) {
      eventEntry.custom_data = customData;
    }

    const payload = { data: [eventEntry] };

    if (env.TEST_EVENT_CODE) {
      payload.test_event_code = env.TEST_EVENT_CODE;
    }

    try {
      const metaRes = await fetch(
        `https://graph.facebook.com/v20.0/${pixelId}/events?access_token=${env.META_ACCESS_TOKEN}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      );
      const metaData = await metaRes.json();

      return new Response(JSON.stringify(metaData), {
        status: metaRes.status,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'meta_request_failed', detail: String(err) }), {
        status: 502,
        headers: { ...headers, 'Content-Type': 'application/json' },
      });
    }
  },
};
