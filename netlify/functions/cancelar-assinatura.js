/* ═══════════════════════════════════════════════════════════════════
   Bússola Finance — cancelar-assinatura
   ───────────────────────────────────────────────────────────────────
   Cancela a assinatura (preapproval) do usuário no Mercado Pago e
   marca a linha da tabela `assinaturas` como `cancelado`.

   O usuário mantém o acesso até o fim do período já pago — quem
   controla isso é o status/`proxima_cobranca` lido pelo app; aqui
   apenas interrompemos a recorrência no Mercado Pago.

   Idempotente: chamar de novo com a assinatura já cancelada devolve
   200 { ok:true, jaEstavaCancelada:true } em vez de erro — e NÃO chama o
   Mercado Pago de novo à toa.

   CommonJS puro, sem dependências npm: usa o `fetch` nativo do
   runtime Node 18+ da Netlify e chama Mercado Pago / Supabase via REST.

   Variáveis de ambiente exigidas (já configuradas — nenhuma nova):
     - MP_ACCESS_TOKEN
     - SUPABASE_URL
     - SUPABASE_SERVICE_ROLE_KEY

   NENHUM desses valores pode ser exposto no client — eles só existem aqui.
   ═══════════════════════════════════════════════════════════════════ */

/* O schema deste projeto usa `uid TEXT` (NÃO uuid) em todas as tabelas de
   dados do usuário — inclusive `profiles.uid` e `assinaturas.uid`. Por isso
   NÃO exigimos formato uuid aqui: validamos só que é uma string "razoável"
   (tamanho e charset sãos), o suficiente pra barrar lixo/injeção antes de
   gastar uma ida ao banco. A validação de verdade é o passo 4: o uid tem
   que existir em `profiles`. */
const RE_UID = /^[A-Za-z0-9._:@-]{8,128}$/;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

/* ── Helpers Supabase REST (service role key — ignora RLS) ── */
function supaHeaders(key, extra) {
  return Object.assign({
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json'
  }, extra || {});
}

exports.handler = async (event) => {
  /* ── 1. Só POST ── */
  if (event.httpMethod !== 'POST') {
    console.warn('[cancelar-assinatura] método rejeitado:', event.httpMethod);
    return json(405, { erro: 'Método não permitido.' });
  }

  /* ── Config obrigatória ── */
  const MP_ACCESS_TOKEN           = process.env.MP_ACCESS_TOKEN;
  const SUPABASE_URL              = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!MP_ACCESS_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[cancelar-assinatura] variáveis de ambiente ausentes:', {
      MP_ACCESS_TOKEN: !!MP_ACCESS_TOKEN,
      SUPABASE_URL: !!SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!SUPABASE_SERVICE_ROLE_KEY
    });
    return json(500, { erro: 'Serviço de assinatura indisponível no momento.' });
  }

  const supaBase = String(SUPABASE_URL).replace(/\/+$/, '');

  /* ── 2. Corpo JSON: { uid } ── */
  let payload;
  try {
    const raw = event.isBase64Encoded && event.body
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : (event.body || '');
    payload = JSON.parse(raw);
  } catch (e) {
    console.error('[cancelar-assinatura] body inválido (JSON):', e.message);
    return json(400, { erro: 'Requisição inválida.' });
  }

  const uid = typeof payload?.uid === 'string' ? payload.uid.trim() : '';

  /* ── 3. Validação básica ── */
  if (!uid)              return json(400, { erro: 'uid é obrigatório.' });
  if (!RE_UID.test(uid)) {
    console.warn('[cancelar-assinatura] uid com formato inválido — tamanho:', uid.length);
    return json(400, { erro: 'uid inválido.' });
  }

  console.log('[cancelar-assinatura] início — uid:', uid);

  /* ── 4. Confirma que o uid é um usuário real. Mesmo padrão de
         `criar-assinatura.js`: consulta a tabela `profiles` via PostgREST
         (comprovadamente funciona neste projeto) em vez da API de admin do
         GoTrue (`/auth/v1/admin/...`), que já devolveu PGRST125 aqui. ── */
  try {
    const rUser = await fetch(
      `${supaBase}/rest/v1/profiles?uid=eq.${encodeURIComponent(uid)}&select=uid`,
      { method: 'GET', headers: supaHeaders(SUPABASE_SERVICE_ROLE_KEY) }
    );

    if (!rUser.ok) {
      const txt = await rUser.text().catch(() => '');
      console.error('[cancelar-assinatura] falha ao consultar profiles — uid:', uid,
                    'status:', rUser.status, 'resp:', txt);
      return json(502, { erro: 'Não foi possível validar sua conta agora. Tente novamente.' });
    }

    const linhas = await rUser.json().catch(() => []);
    if (!Array.isArray(linhas) || linhas.length === 0) {
      console.warn('[cancelar-assinatura] uid sem perfil correspondente — uid:', uid);
      return json(403, { erro: 'Usuário não autorizado.' });
    }
    console.log('[cancelar-assinatura] usuário validado (profiles) — uid:', uid);
  } catch (e) {
    console.error('[cancelar-assinatura] erro ao validar usuário no Supabase:', e);
    return json(502, { erro: 'Não foi possível validar sua conta agora. Tente novamente.' });
  }

  /* ── 5. Busca a assinatura do usuário ── */
  let assinatura = null;
  try {
    const rAssin = await fetch(
      `${supaBase}/rest/v1/assinaturas?uid=eq.${encodeURIComponent(uid)}&select=mp_subscription_id,status`,
      { method: 'GET', headers: supaHeaders(SUPABASE_SERVICE_ROLE_KEY) }
    );

    if (!rAssin.ok) {
      const txt = await rAssin.text().catch(() => '');
      console.error('[cancelar-assinatura] falha ao consultar assinaturas — uid:', uid,
                    'status:', rAssin.status, 'resp:', txt);
      return json(502, { erro: 'Não foi possível consultar sua assinatura agora. Tente novamente.' });
    }

    const linhas = await rAssin.json().catch(() => []);
    if (!Array.isArray(linhas) || linhas.length === 0) {
      console.warn('[cancelar-assinatura] nenhuma linha em assinaturas — uid:', uid);
      return json(400, { erro: 'Nenhuma assinatura ativa encontrada para cancelar.' });
    }
    assinatura = linhas[0] || null;
  } catch (e) {
    console.error('[cancelar-assinatura] erro ao consultar assinaturas — uid:', uid, e);
    return json(502, { erro: 'Não foi possível consultar sua assinatura agora. Tente novamente.' });
  }

  const statusAtual      = assinatura && assinatura.status ? String(assinatura.status) : '';
  const mpSubscriptionId = assinatura && assinatura.mp_subscription_id
    ? String(assinatura.mp_subscription_id).trim()
    : '';

  console.log('[cancelar-assinatura] assinatura encontrada — uid:', uid,
              'status:', statusAtual || '(vazio)',
              'mp_subscription_id:', mpSubscriptionId || '(vazio)');

  /* ── 5b. Já cancelado: idempotente, não é erro chamar de novo ── */
  if (statusAtual === 'cancelado') {
    console.log('[cancelar-assinatura] assinatura já estava cancelada — uid:', uid,
                '(retorno 200 idempotente, sem chamar o Mercado Pago)');
    return json(200, { ok: true, jaEstavaCancelada: true });
  }

  /* ── 5c. Sem id no Mercado Pago: não há o que cancelar lá ── */
  if (!mpSubscriptionId) {
    console.warn('[cancelar-assinatura] assinatura sem mp_subscription_id — uid:', uid,
                 'status:', statusAtual || '(vazio)');
    return json(400, { erro: 'Nenhuma assinatura ativa encontrada para cancelar.' });
  }

  /* ── 6. Cancela a preapproval no Mercado Pago ── */
  try {
    const rMp = await fetch(
      `https://api.mercadopago.com/preapproval/${encodeURIComponent(mpSubscriptionId)}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status: 'cancelled' })
      }
    );

    const txt = await rMp.text().catch(() => '');

    if (!rMp.ok) {
      /* Log detalhado no servidor, mensagem genérica pro client. */
      console.error('[cancelar-assinatura] Mercado Pago retornou erro — uid:', uid,
                    'mp_subscription_id:', mpSubscriptionId,
                    'status:', rMp.status, 'resp:', txt);
      return json(502, { erro: 'Não foi possível cancelar agora. Tente novamente em instantes.' });
    }

    console.log('[cancelar-assinatura] preapproval cancelada no Mercado Pago — uid:', uid,
                'mp_subscription_id:', mpSubscriptionId, 'status HTTP:', rMp.status);
  } catch (e) {
    console.error('[cancelar-assinatura] falha de rede ao chamar Mercado Pago — uid:', uid,
                  'mp_subscription_id:', mpSubscriptionId, e);
    return json(502, { erro: 'Não foi possível cancelar agora. Tente novamente em instantes.' });
  }

  /* ── 7. Reflete o cancelamento no Supabase ──
         Se isto falhar, o cancelamento no MP JÁ aconteceu (não dá pra
         desfazer) — o webhook do MP ainda deve corrigir o status depois.
         Por isso não devolvemos erro pro usuário, só logamos alto. */
  try {
    const rPatch = await fetch(
      `${supaBase}/rest/v1/assinaturas?uid=eq.${encodeURIComponent(uid)}`,
      {
        method: 'PATCH',
        headers: supaHeaders(SUPABASE_SERVICE_ROLE_KEY, { Prefer: 'return=minimal' }),
        body: JSON.stringify({
          status: 'cancelado',
          atualizado_em: new Date().toISOString()
        })
      }
    );

    if (!rPatch.ok) {
      const txt = await rPatch.text().catch(() => '');
      console.error('[cancelar-assinatura] FALHA ao marcar status=cancelado no Supabase — uid:', uid,
                    'status:', rPatch.status, 'resp:', txt,
                    '(o cancelamento no Mercado Pago JÁ foi feito — o webhook deve corrigir)');
    } else {
      console.log('[cancelar-assinatura] status=cancelado gravado no Supabase — uid:', uid);
    }
  } catch (e) {
    console.error('[cancelar-assinatura] erro ao gravar status=cancelado no Supabase — uid:', uid, e,
                  '(o cancelamento no Mercado Pago JÁ foi feito — o webhook deve corrigir)');
  }

  console.log('[cancelar-assinatura] concluído com sucesso — uid:', uid);
  return json(200, { ok: true });
};
