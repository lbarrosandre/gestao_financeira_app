/* ═══════════════════════════════════════════════════════════════════
   Bússola Finance — criar-assinatura
   ───────────────────────────────────────────────────────────────────
   Cria uma assinatura (preapproval) no Mercado Pago com checkout
   hospedado e devolve a URL de checkout pro client redirecionar.
   NÃO existe período de teste: a cobrança começa imediatamente, na
   hora em que a pessoa conclui o checkout.

   O client escolhe o PLANO ('plus' ou 'premium'); o PREÇO de cada um
   é decidido aqui no servidor (VALORES_PLANO) — o client nunca manda
   valor, só o nome do plano.

   CommonJS puro, sem dependências npm: usa o `fetch` nativo do
   runtime Node 18+ da Netlify e chama Mercado Pago / Supabase via REST.

   Variáveis de ambiente exigidas (Netlify → Site settings → Environment):
     - MP_ACCESS_TOKEN
     - SUPABASE_URL
     - SUPABASE_SERVICE_ROLE_KEY

   NENHUM desses valores pode ser exposto no client — eles só existem aqui.
   ═══════════════════════════════════════════════════════════════════ */

/* Preço mensal de cada plano PAGO. O plano 'basico' não aparece aqui de
   propósito: ele é grátis e não gera preapproval nenhuma no Mercado Pago —
   pedir checkout pra 'basico' é requisição inválida (400 no passo 3). */
const VALORES_PLANO  = { plus: 9.90, premium: 14.99 };
const BACK_URL       = 'https://bussola-finance.netlify.app/?assinatura=retorno';
const RE_UUID        = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const RE_EMAIL       = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  /* ── 1. Só POST ── */
  if (event.httpMethod !== 'POST') {
    console.warn('[criar-assinatura] método rejeitado:', event.httpMethod);
    return json(405, { erro: 'Método não permitido.' });
  }

  /* ── Config obrigatória ── */
  const MP_ACCESS_TOKEN           = process.env.MP_ACCESS_TOKEN;
  const SUPABASE_URL              = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!MP_ACCESS_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[criar-assinatura] variáveis de ambiente ausentes:', {
      MP_ACCESS_TOKEN: !!MP_ACCESS_TOKEN,
      SUPABASE_URL: !!SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!SUPABASE_SERVICE_ROLE_KEY
    });
    return json(500, { erro: 'Serviço de assinatura indisponível no momento.' });
  }

  const supaBase = String(SUPABASE_URL).replace(/\/+$/, '');

  /* ── 2. Corpo JSON: { uid, email, plano } ── */
  let payload;
  try {
    const raw = event.isBase64Encoded && event.body
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : (event.body || '');
    payload = JSON.parse(raw);
  } catch (e) {
    console.error('[criar-assinatura] body inválido (JSON):', e.message);
    return json(400, { erro: 'Requisição inválida.' });
  }

  const uid   = typeof payload?.uid   === 'string' ? payload.uid.trim()             : '';
  const email = typeof payload?.email === 'string' ? payload.email.trim().toLowerCase() : '';
  const plano = typeof payload?.plano === 'string' ? payload.plano.trim().toLowerCase() : '';

  /* ── 3. Validação básica ── */
  if (!uid || !email)          return json(400, { erro: 'uid e email são obrigatórios.' });
  if (!RE_UUID.test(uid))      return json(400, { erro: 'uid inválido.' });
  if (!RE_EMAIL.test(email))   return json(400, { erro: 'e-mail inválido.' });
  /* O valor cobrado vem SÓ daqui (VALORES_PLANO), nunca do client — o client
     manda apenas qual plano quer. Plano desconhecido (ou 'basico', que é
     grátis) não tem preço nesta tabela e é rejeitado. */
  if (!VALORES_PLANO[plano])   return json(400, { erro: 'plano inválido.' });

  console.log('[criar-assinatura] início — uid:', uid, 'plano:', plano,
              'valor:', VALORES_PLANO[plano]);

  /* ── 4. Confirma que o uid é um usuário real (evita chamada direta à
         function com uid inventado, sem passar pelo app). Checa a tabela
         `profiles` via PostgREST (mesmo caminho que o resto do app já usa
         e comprovadamente funciona) em vez da API de admin do GoTrue
         (`/auth/v1/admin/...`), que devolveu erro de roteamento (PGRST125)
         neste projeto. ── */
  try {
    const rUser = await fetch(
      `${supaBase}/rest/v1/profiles?uid=eq.${encodeURIComponent(uid)}&select=uid`,
      {
        method: 'GET',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    );

    if (!rUser.ok) {
      const txt = await rUser.text().catch(() => '');
      console.error('[criar-assinatura] falha ao consultar profiles — uid:', uid,
                   'status:', rUser.status, 'resp:', txt);
      return json(502, { erro: 'Não foi possível validar sua conta agora. Tente novamente.' });
    }

    const linhas = await rUser.json().catch(() => []);
    if (!Array.isArray(linhas) || linhas.length === 0) {
      console.warn('[criar-assinatura] uid sem perfil correspondente — uid:', uid);
      return json(403, { erro: 'Usuário não autorizado.' });
    }
    console.log('[criar-assinatura] usuário validado (profiles) — uid:', uid);
  } catch (e) {
    console.error('[criar-assinatura] erro ao validar usuário no Supabase:', e);
    return json(502, { erro: 'Não foi possível validar sua conta agora. Tente novamente.' });
  }

  /* ── 5. Cria a preapproval no Mercado Pago (sem plano associado,
         checkout hospedado, cobrança imediata — sem período de teste) ── */
  let mpData;
  try {
    const rMp = await fetch('https://api.mercadopago.com/preapproval', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        reason: `Bússola Finance — Assinatura ${plano === 'premium' ? 'Premium' : 'Plus'}`,
        external_reference: uid,
        payer_email: email,
        back_url: BACK_URL,
        auto_recurring: {
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: VALORES_PLANO[plano],
          currency_id: 'BRL'
        },
        status: 'pending'
      })
    });

    const txt = await rMp.text();

    /* ── 6. Erro do MP: log detalhado no servidor, mensagem genérica pro client ── */
    if (!rMp.ok) {
      console.error('[criar-assinatura] Mercado Pago retornou erro — uid:', uid,
                    'status:', rMp.status, 'resp:', txt);
      return json(502, { erro: 'Não foi possível iniciar a assinatura agora. Tente novamente em instantes.' });
    }

    try {
      mpData = JSON.parse(txt);
    } catch (e) {
      console.error('[criar-assinatura] resposta do Mercado Pago não é JSON — uid:', uid, 'resp:', txt);
      return json(502, { erro: 'Não foi possível iniciar a assinatura agora. Tente novamente em instantes.' });
    }
  } catch (e) {
    console.error('[criar-assinatura] falha de rede ao chamar Mercado Pago — uid:', uid, e);
    return json(502, { erro: 'Não foi possível iniciar a assinatura agora. Tente novamente em instantes.' });
  }

  /* ── 7. init_point (checkout hospedado) + id da preapproval ── */
  const checkoutUrl        = mpData.init_point || mpData.sandbox_init_point || '';
  const mpSubscriptionId   = mpData.id ? String(mpData.id) : '';

  if (!checkoutUrl || !mpSubscriptionId) {
    console.error('[criar-assinatura] resposta do Mercado Pago sem init_point/id — uid:', uid,
                  'resp:', JSON.stringify(mpData));
    return json(502, { erro: 'Não foi possível iniciar a assinatura agora. Tente novamente em instantes.' });
  }

  console.log('[criar-assinatura] preapproval criada — uid:', uid, 'mp_subscription_id:', mpSubscriptionId);

  /* ── 8. Grava o mp_subscription_id JÁ (antes de qualquer pagamento):
         é isso que permite o webhook achar o usuário certo depois.

         Grava também o `plano` escolhido AGORA, e não depois: o webhook só
         mexe em `status`, nunca em `plano` — e não precisa mesmo, porque o
         valor da preapproval já saiu daqui com o preço certo do plano.
         Assim, quando o pagamento confirmar, a linha já sabe o que foi
         contratado. ── */
  try {
    const rPatch = await fetch(
      `${supaBase}/rest/v1/assinaturas?uid=eq.${encodeURIComponent(uid)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({
          mp_subscription_id: mpSubscriptionId,
          mp_payer_email: email,
          plano: plano,
          atualizado_em: new Date().toISOString()
        })
      }
    );

    if (!rPatch.ok) {
      const txt = await rPatch.text().catch(() => '');
      /* Não aborta: a preapproval já existe no MP e o usuário deve conseguir
         pagar. O webhook ainda consegue linkar pelo external_reference (uid).
         Mas isso PRECISA aparecer no log pra investigação. */
      console.error('[criar-assinatura] FALHA ao gravar mp_subscription_id no Supabase — uid:', uid,
                    'status:', rPatch.status, 'resp:', txt);
    } else {
      console.log('[criar-assinatura] mp_subscription_id gravado no Supabase — uid:', uid);
    }
  } catch (e) {
    console.error('[criar-assinatura] erro ao gravar mp_subscription_id no Supabase — uid:', uid, e);
  }

  /* ── 9. Client redireciona pro checkout ── */
  return json(200, { checkoutUrl });
};
