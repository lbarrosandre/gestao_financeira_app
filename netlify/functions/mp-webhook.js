/* ═══════════════════════════════════════════════════════════════════
   Bússola Finance — mp-webhook
   ───────────────────────────────────────────────────────────────────
   Recebe as notificações (webhooks) do Mercado Pago, VALIDA a assinatura
   HMAC do header `x-signature` e sincroniza o status da assinatura na
   tabela `public.assinaturas` do Supabase.

   Regras de resposta:
     - Assinatura HMAC inválida/ausente  → 401 (rejeita, NÃO processa).
     - Qualquer outro erro de processamento → 200 mesmo assim, com log,
       pra não entrar em loop infinito de retentativa do Mercado Pago.
     - Método diferente de POST → 405.

   NUNCA confiamos no status que vem no corpo do webhook: sempre buscamos
   o recurso atualizado direto na API do Mercado Pago pelo id.

   CommonJS puro, sem dependências npm: `fetch` nativo (Node 18+) e o
   módulo `crypto` nativo do Node.

   Variáveis de ambiente exigidas:
     - MP_ACCESS_TOKEN
     - MP_WEBHOOK_SECRET
     - SUPABASE_URL
     - SUPABASE_SERVICE_ROLE_KEY
   ═══════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');

const RE_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/* Sempre 200 pro Mercado Pago parar de retentar (exceto assinatura inválida). */
const OK = { statusCode: 200, body: JSON.stringify({ recebido: true }) };

/* ── Comparação em tempo constante de duas strings hex ── */
function assinaturasBatem(hexA, hexB) {
  if (typeof hexA !== 'string' || typeof hexB !== 'string') return false;
  if (!/^[0-9a-fA-F]+$/.test(hexA) || !/^[0-9a-fA-F]+$/.test(hexB)) return false;
  const a = Buffer.from(hexA, 'hex');
  const b = Buffer.from(hexB, 'hex');
  /* timingSafeEqual LANÇA se os tamanhos diferirem — checa antes. */
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ── Parseia `ts=...,v1=...` do header x-signature ── */
function parseXSignature(header) {
  const out = { ts: '', v1: '' };
  if (!header || typeof header !== 'string') return out;
  for (const parte of header.split(',')) {
    const i = parte.indexOf('=');
    if (i === -1) continue;
    const chave = parte.slice(0, i).trim();
    const valor = parte.slice(i + 1).trim();
    if (chave === 'ts') out.ts = valor;
    else if (chave === 'v1') out.v1 = valor;
  }
  return out;
}

/* ── Helpers Supabase REST (service role key — ignora RLS) ── */
function supaHeaders(key, extra) {
  return Object.assign({
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json'
  }, extra || {});
}

async function supaPatchAssinatura(base, key, uid, campos) {
  const body = Object.assign({}, campos, { atualizado_em: new Date().toISOString() });
  const r = await fetch(
    `${base}/rest/v1/assinaturas?uid=eq.${encodeURIComponent(uid)}`,
    {
      method: 'PATCH',
      headers: supaHeaders(key, { Prefer: 'return=minimal' }),
      body: JSON.stringify(body)
    }
  );
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    console.error('[mp-webhook] FALHA no PATCH do Supabase — uid:', uid,
                  'status:', r.status, 'resp:', txt, 'campos:', JSON.stringify(body));
    return false;
  }
  console.log('[mp-webhook] Supabase atualizado — uid:', uid, 'campos:', JSON.stringify(body));
  return true;
}

async function supaBuscarUid(base, key, coluna, valor) {
  try {
    const r = await fetch(
      `${base}/rest/v1/assinaturas?${coluna}=eq.${encodeURIComponent(valor)}&select=uid`,
      { method: 'GET', headers: supaHeaders(key) }
    );
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.error('[mp-webhook] erro ao buscar uid por', coluna, '- status:', r.status, 'resp:', txt);
      return null;
    }
    const linhas = await r.json().catch(() => []);
    if (!Array.isArray(linhas) || linhas.length === 0) {
      console.warn('[mp-webhook] nenhuma assinatura encontrada por', coluna, '=', valor);
      return null;
    }
    if (linhas.length > 1) {
      /* Ambíguo: não dá pra saber de quem é o pagamento. Melhor não fazer nada. */
      console.warn('[mp-webhook] MÚLTIPLAS assinaturas para', coluna, '=', valor, '— ignorando por segurança.');
      return null;
    }
    return linhas[0].uid || null;
  } catch (e) {
    console.error('[mp-webhook] exceção ao buscar uid por', coluna, e);
    return null;
  }
}

/* ── GET num recurso da API do Mercado Pago ── */
async function mpGet(url, token) {
  const r = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` }
  });
  const txt = await r.text();
  if (!r.ok) {
    console.error('[mp-webhook] GET', url, 'falhou — status:', r.status, 'resp:', txt);
    return null;
  }
  try {
    return JSON.parse(txt);
  } catch (e) {
    console.error('[mp-webhook] resposta não-JSON de', url, '- resp:', txt);
    return null;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    console.warn('[mp-webhook] método rejeitado:', event.httpMethod);
    return { statusCode: 405, body: JSON.stringify({ erro: 'Método não permitido.' }) };
  }

  const MP_ACCESS_TOKEN           = process.env.MP_ACCESS_TOKEN;
  const MP_WEBHOOK_SECRET         = process.env.MP_WEBHOOK_SECRET;
  const SUPABASE_URL              = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const headers = event.headers || {};
  const qs      = event.queryStringParameters || {};

  /* Netlify normaliza headers pra minúsculo, mas não custa cobrir os dois. */
  const xSignature = headers['x-signature']  || headers['X-Signature']  || '';
  const xRequestId = headers['x-request-id'] || headers['X-Request-Id'] || '';

  /* ── Corpo ── */
  let body = {};
  let rawBody = '';
  try {
    rawBody = event.isBase64Encoded && event.body
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : (event.body || '');
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch (e) {
    console.warn('[mp-webhook] corpo não é JSON válido:', e.message, '| raw:', rawBody);
    body = {};
  }

  /* data.id: pode vir na query string (?data.id=123&type=...) OU no corpo. */
  const dataId = String(
    qs['data.id'] || qs['id'] || body?.data?.id || body?.resource || ''
  ).trim();

  const tipo = String(qs['type'] || qs['topic'] || body?.type || body?.topic || '').trim();

  console.log('[mp-webhook] notificação recebida — type/topic:', tipo,
              '| data.id:', dataId, '| x-request-id:', xRequestId);

  /* ══ 1. VERIFICAÇÃO DA ASSINATURA (obrigatória) ══ */
  if (!MP_WEBHOOK_SECRET) {
    console.error('[mp-webhook] MP_WEBHOOK_SECRET não configurada — rejeitando notificação.');
    return { statusCode: 401, body: JSON.stringify({ erro: 'Assinatura não verificável.' }) };
  }

  const { ts, v1 } = parseXSignature(xSignature);
  if (!ts || !v1) {
    console.warn('[mp-webhook] header x-signature ausente ou malformado:', xSignature);
    return { statusCode: 401, body: JSON.stringify({ erro: 'Assinatura inválida.' }) };
  }

  const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
  const esperado = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex');

  if (!assinaturasBatem(esperado, v1)) {
    console.warn('[mp-webhook] ASSINATURA INVÁLIDA — manifest usado:', manifest,
                 '| v1 recebido:', v1);
    return { statusCode: 401, body: JSON.stringify({ erro: 'Assinatura inválida.' }) };
  }
  console.log('[mp-webhook] assinatura HMAC válida.');

  /* ══ A partir daqui, SEMPRE 200 (mesmo em erro) ══ */
  try {
    if (!MP_ACCESS_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.error('[mp-webhook] variáveis de ambiente ausentes:', {
        MP_ACCESS_TOKEN: !!MP_ACCESS_TOKEN,
        SUPABASE_URL: !!SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: !!SUPABASE_SERVICE_ROLE_KEY
      });
      return OK;
    }
    if (!dataId) {
      console.warn('[mp-webhook] notificação sem data.id — nada a fazer.');
      return OK;
    }

    const supaBase = String(SUPABASE_URL).replace(/\/+$/, '');
    const tipoLower = tipo.toLowerCase();

    /* ─────────────────────────────────────────────────────────────
       A) Assinatura (preapproval) criada / atualizada / cancelada
       ───────────────────────────────────────────────────────────── */
    if (tipoLower.includes('preapproval') && !tipoLower.includes('authorized_payment')) {
      console.log('[mp-webhook] evento de preapproval — buscando recurso atualizado no MP…');
      const pre = await mpGet(`https://api.mercadopago.com/preapproval/${encodeURIComponent(dataId)}`, MP_ACCESS_TOKEN);
      if (!pre) { console.error('[mp-webhook] não foi possível ler a preapproval', dataId); return OK; }

      const statusMp = String(pre.status || '').toLowerCase();
      let uid = typeof pre.external_reference === 'string' ? pre.external_reference.trim() : '';
      if (!RE_UUID.test(uid)) {
        console.warn('[mp-webhook] external_reference da preapproval não é um uid válido:', uid,
                     '— tentando pelo mp_subscription_id.');
        uid = await supaBuscarUid(supaBase, SUPABASE_SERVICE_ROLE_KEY, 'mp_subscription_id', String(pre.id || dataId));
      }
      if (!uid) { console.warn('[mp-webhook] preapproval sem uid associado — ignorando.', dataId); return OK; }

      console.log('[mp-webhook] preapproval', dataId, '| status MP:', statusMp, '| uid:', uid);

      const campos = {};
      if (statusMp === 'authorized') {
        campos.status = 'ativo';
        /* O nome do campo de próxima cobrança varia conforme a resposta do MP. */
        const prox = pre.next_payment_date
                  || pre.auto_recurring?.next_payment_date
                  || pre.summarized?.next_payment_date
                  || null;
        if (prox) {
          const d = new Date(prox);
          if (!isNaN(d.getTime())) campos.proxima_cobranca = d.toISOString();
          else console.warn('[mp-webhook] next_payment_date não parseável:', prox);
        } else {
          console.log('[mp-webhook] preapproval sem next_payment_date — proxima_cobranca mantida.');
        }
      } else if (statusMp === 'cancelled' || statusMp === 'canceled' || statusMp === 'paused') {
        campos.status = 'cancelado';
      } else {
        console.log('[mp-webhook] status de preapproval sem mapeamento ("' + statusMp + '") — nada alterado.');
        return OK;
      }

      /* Garante o vínculo pro caso da gravação na criação ter falhado. */
      if (pre.id) campos.mp_subscription_id = String(pre.id);
      await supaPatchAssinatura(supaBase, SUPABASE_SERVICE_ROLE_KEY, uid, campos);
      return OK;
    }

    /* ─────────────────────────────────────────────────────────────
       B) Cobrança da assinatura (subscription_authorized_payment)
          e pagamentos avulsos (payment)
       ───────────────────────────────────────────────────────────── */
    if (tipoLower.includes('payment')) {
      let statusPagamento = '';
      let uid = '';
      let preapprovalId = '';
      let emailPagador = '';

      if (tipoLower.includes('authorized_payment')) {
        /* Cobrança recorrente gerada pela assinatura: o id do evento é de um
           "authorized payment", que tem endpoint próprio e traz preapproval_id. */
        console.log('[mp-webhook] evento de cobrança da assinatura — buscando authorized_payment…');
        const ap = await mpGet(`https://api.mercadopago.com/authorized_payments/${encodeURIComponent(dataId)}`, MP_ACCESS_TOKEN);
        if (ap) {
          preapprovalId   = ap.preapproval_id ? String(ap.preapproval_id) : '';
          statusPagamento = String(ap.payment?.status || ap.status || '').toLowerCase();
          console.log('[mp-webhook] authorized_payment', dataId,
                      '| preapproval_id:', preapprovalId, '| status:', statusPagamento);
        } else {
          console.warn('[mp-webhook] authorized_payment', dataId, 'não encontrado — tentando /v1/payments.');
        }
      }

      if (!statusPagamento) {
        const pag = await mpGet(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(dataId)}`, MP_ACCESS_TOKEN);
        if (!pag) { console.error('[mp-webhook] não foi possível ler o pagamento', dataId); return OK; }
        statusPagamento = String(pag.status || '').toLowerCase();
        const ext = typeof pag.external_reference === 'string' ? pag.external_reference.trim() : '';
        if (RE_UUID.test(ext)) uid = ext;
        if (!preapprovalId && pag.metadata && pag.metadata.preapproval_id) {
          preapprovalId = String(pag.metadata.preapproval_id);
        }
        if (!uid && pag.payer && pag.payer.email) {
          /* guardado só como último recurso, abaixo */
          emailPagador = String(pag.payer.email).toLowerCase();
        }
        console.log('[mp-webhook] payment', dataId, '| status:', statusPagamento,
                    '| external_reference:', ext, '| preapproval_id:', preapprovalId);
      }

      /* Descoberta do uid, em ordem de confiabilidade. */
      if (!uid && preapprovalId) {
        uid = await supaBuscarUid(supaBase, SUPABASE_SERVICE_ROLE_KEY, 'mp_subscription_id', preapprovalId);
      }
      if (!uid && emailPagador) {
        console.warn('[mp-webhook] linkando pagamento pelo mp_payer_email (último recurso):', emailPagador);
        uid = await supaBuscarUid(supaBase, SUPABASE_SERVICE_ROLE_KEY, 'mp_payer_email', emailPagador);
      }
      if (!uid) {
        console.warn('[mp-webhook] pagamento', dataId, 'não pôde ser associado a nenhum uid — ignorando (não é erro fatal).');
        return OK;
      }

      let novoStatus = '';
      if (statusPagamento === 'approved' || statusPagamento === 'processed') novoStatus = 'ativo';
      else if (statusPagamento === 'rejected') novoStatus = 'atrasado';

      if (!novoStatus) {
        console.log('[mp-webhook] status de pagamento sem mapeamento ("' + statusPagamento + '") — nada alterado. uid:', uid);
        return OK;
      }

      console.log('[mp-webhook] pagamento', dataId, '→ status interno:', novoStatus, '| uid:', uid);
      await supaPatchAssinatura(supaBase, SUPABASE_SERVICE_ROLE_KEY, uid, { status: novoStatus });
      return OK;
    }

    console.log('[mp-webhook] tipo de evento não tratado ("' + tipo + '") — ignorado.');
    return OK;
  } catch (e) {
    /* Nunca devolve 500: o MP retentaria em loop. Log e segue. */
    console.error('[mp-webhook] ERRO INESPERADO ao processar notificação:', e);
    return OK;
  }
};
