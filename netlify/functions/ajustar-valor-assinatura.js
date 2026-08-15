/* ═══════════════════════════════════════════════════════════════════
   Bússola Finance — ajustar-valor-assinatura
   ───────────────────────────────────────────────────────────────────
   Utilitário ADMINISTRATIVO (não é chamado pelo app).

   ── O quê ──
   Baixa o valor cobrado das preapprovals já existentes no Mercado Pago
   para o preço atual do plano Premium (R$ 14,99/mês).

   ── Por quê ──
   Até a migração de planos existia UM plano só, de R$ 19,90/mês. A
   migração de banco (`migracao_planos.sql`) transformou quem tinha
   `status in ('ativo','cortesia')` em `plano='premium'` — mas o VALOR da
   recorrência vive no Mercado Pago, NÃO no Supabase. Sem este ajuste,
   esses assinantes continuariam sendo cobrados R$ 19,90 por um plano que
   hoje custa R$ 14,99. Nenhum SQL resolve isso: só a API do MP.

   ── Quando usar ──
   Chame uma vez manualmente (ex: via curl ou Postman) depois de rodar a
   migração `migracao_planos.sql`. Pode rodar de novo sem problema — é
   idempotente (PUT do mesmo valor não causa efeito colateral). Também
   serve no futuro, se o preço do Premium mudar de novo: basta ajustar
   VALOR_PREMIUM e chamar outra vez.

   ── Tolerância a falha (mesmo padrão de `excluir-conta.js`) ──
   Se uma assinatura falhar no Mercado Pago, NÃO interrompemos: seguimos
   pras próximas e coletamos os uids que falharam em `falhas`. Parar na
   primeira falha deixaria o resto do público sendo cobrado a mais, que é
   justamente o que não queremos. Só validação de senha / env ausente
   devolve erro — uma conta falhando nunca vira 500.

   ── Exemplo de chamada ──
     curl -X POST https://bussola-finance.netlify.app/.netlify/functions/ajustar-valor-assinatura \
          -H 'Content-Type: application/json' \
          -d '{"senhaAdmin":"<valor de ADMIN_MIGRACAO_SENHA>"}'

   CommonJS puro, sem dependências npm: usa o `fetch` nativo do
   runtime Node 18+ da Netlify, o módulo `crypto` nativo e chama
   Mercado Pago / Supabase via REST.

   Variáveis de ambiente exigidas:
     - MP_ACCESS_TOKEN             (já configurada)
     - SUPABASE_URL                (já configurada)
     - SUPABASE_SERVICE_ROLE_KEY   (já configurada)
     - ADMIN_MIGRACAO_SENHA        ⚠️ NOVA — criar em Netlify → Site
       settings → Environment. Qualquer string longa e aleatória serve;
       é o único portão desta function.

   NENHUM desses valores pode ser exposto no client — eles só existem aqui.
   ═══════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');

/* Preço atual do plano Premium — o mesmo VALORES_PLANO.premium de
   `criar-assinatura.js`. Se mudar lá, mude aqui e rode de novo. */
const VALOR_PREMIUM = 14.99;

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

/* ── Comparação de senha em tempo constante ──
   Mesmo padrão de `assinaturasBatem` em `mp-webhook.js`: crypto.timingSafeEqual
   pra não vazar, pelo tempo de resposta, quantos caracteres iniciais bateram.
   Diferença: lá os dois lados são hex de tamanho fixo; aqui é uma senha
   qualquer, de tamanho arbitrário — e timingSafeEqual LANÇA se os buffers
   tiverem tamanhos diferentes. Por isso passamos os dois pelo SHA-256 antes:
   vira sempre 32 bytes dos dois lados, e o próprio tamanho da senha deixa de
   ser observável. */
function senhasBatem(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!a || !b) return false;
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

exports.handler = async (event) => {
  /* ── 1. Só POST ── */
  if (event.httpMethod !== 'POST') {
    console.warn('[ajustar-valor-assinatura] método rejeitado:', event.httpMethod);
    return json(405, { erro: 'Método não permitido.' });
  }

  /* ── Config obrigatória ── */
  const MP_ACCESS_TOKEN           = process.env.MP_ACCESS_TOKEN;
  const SUPABASE_URL              = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ADMIN_MIGRACAO_SENHA      = process.env.ADMIN_MIGRACAO_SENHA;

  if (!MP_ACCESS_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ADMIN_MIGRACAO_SENHA) {
    console.error('[ajustar-valor-assinatura] variáveis de ambiente ausentes:', {
      MP_ACCESS_TOKEN: !!MP_ACCESS_TOKEN,
      SUPABASE_URL: !!SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!SUPABASE_SERVICE_ROLE_KEY,
      ADMIN_MIGRACAO_SENHA: !!ADMIN_MIGRACAO_SENHA
    });
    return json(500, { erro: 'Serviço indisponível no momento.' });
  }

  const supaBase = String(SUPABASE_URL).replace(/\/+$/, '');

  /* ── 2. Corpo JSON: { senhaAdmin } ── */
  let payload;
  try {
    const raw = event.isBase64Encoded && event.body
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : (event.body || '');
    payload = JSON.parse(raw);
  } catch (e) {
    console.error('[ajustar-valor-assinatura] body inválido (JSON):', e.message);
    return json(400, { erro: 'Requisição inválida.' });
  }

  const senhaAdmin = typeof payload?.senhaAdmin === 'string' ? payload.senhaAdmin : '';

  /* ── 3. Portão: senha administrativa ──
         Nunca logamos a senha recebida (nem parte dela). */
  if (!senhasBatem(senhaAdmin, ADMIN_MIGRACAO_SENHA)) {
    console.warn('[ajustar-valor-assinatura] senha administrativa inválida — requisição recusada.');
    return json(401, { erro: 'Não autorizado.' });
  }

  console.log('[ajustar-valor-assinatura] início — valor alvo:', VALOR_PREMIUM);

  /* ── 4. Busca os assinantes migrados ──
         Filtro: ativos, no plano premium e COM preapproval real no Mercado
         Pago. Sem `mp_subscription_id` não há o que ajustar lá (ex.: linhas
         de cortesia, que nunca passaram pelo checkout). */
  let linhas = [];
  try {
    const rAssin = await fetch(
      `${supaBase}/rest/v1/assinaturas` +
      `?status=eq.ativo&plano=eq.premium&mp_subscription_id=not.is.null` +
      `&select=uid,mp_subscription_id`,
      { method: 'GET', headers: supaHeaders(SUPABASE_SERVICE_ROLE_KEY) }
    );

    if (!rAssin.ok) {
      const txt = await rAssin.text().catch(() => '');
      console.error('[ajustar-valor-assinatura] falha ao consultar assinaturas —',
                    'status:', rAssin.status, 'resp:', txt);
      return json(502, { erro: 'Não foi possível consultar as assinaturas agora.' });
    }

    const dados = await rAssin.json().catch(() => []);
    linhas = Array.isArray(dados) ? dados : [];
  } catch (e) {
    console.error('[ajustar-valor-assinatura] erro de rede ao consultar assinaturas:', e);
    return json(502, { erro: 'Não foi possível consultar as assinaturas agora.' });
  }

  console.log('[ajustar-valor-assinatura] assinaturas encontradas:', linhas.length);

  if (linhas.length === 0) {
    console.log('[ajustar-valor-assinatura] nada a ajustar — concluído.');
    return json(200, { ok: true, total: 0, sucesso: 0, falhas: [] });
  }

  /* ── 5. Ajusta o valor de cada uma, sem parar na primeira falha ──
         Sequencial (for/await, não Promise.all) de propósito: evita rajada
         de requisições na API do Mercado Pago e mantém o log legível na
         ordem em que as coisas aconteceram. */
  const falhas = [];
  let sucesso  = 0;

  for (const linha of linhas) {
    const uid = linha && linha.uid ? String(linha.uid) : '(sem uid)';
    const mpSubscriptionId = linha && linha.mp_subscription_id
      ? String(linha.mp_subscription_id).trim()
      : '';

    if (!mpSubscriptionId) {
      /* Não deveria acontecer (o filtro exclui null), mas string vazia passa
         pelo `not.is.null` — e um PUT em /preapproval/ sem id bateria na URL errada. */
      console.warn('[ajustar-valor-assinatura] linha sem mp_subscription_id utilizável — uid:', uid);
      falhas.push({ uid, motivo: 'mp_subscription_id vazio' });
      continue;
    }

    try {
      const rMp = await fetch(
        `https://api.mercadopago.com/preapproval/${encodeURIComponent(mpSubscriptionId)}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            auto_recurring: { transaction_amount: VALOR_PREMIUM }
          })
        }
      );

      const txt = await rMp.text().catch(() => '');

      if (!rMp.ok) {
        console.error('[ajustar-valor-assinatura] FALHA no Mercado Pago — uid:', uid,
                      'mp_subscription_id:', mpSubscriptionId,
                      'status:', rMp.status, 'resp:', txt);
        falhas.push({ uid, mpSubscriptionId, status: rMp.status });
        continue; /* segue pras próximas: queremos ajustar o máximo possível */
      }

      sucesso++;
      console.log('[ajustar-valor-assinatura] valor ajustado — uid:', uid,
                  'mp_subscription_id:', mpSubscriptionId,
                  'novo valor:', VALOR_PREMIUM, 'status HTTP:', rMp.status);
    } catch (e) {
      console.error('[ajustar-valor-assinatura] erro de rede ao chamar Mercado Pago — uid:', uid,
                    'mp_subscription_id:', mpSubscriptionId, e);
      falhas.push({ uid, mpSubscriptionId, status: 0 });
    }
  }

  /* ── 6. Resposta final: 200 mesmo com falhas individuais ──
         Quem chamou precisa ver o que deu certo E o que sobrou pra tratar
         na mão; devolver 500 por causa de uma conta esconderia as outras. */
  if (falhas.length > 0) {
    console.error('[ajustar-valor-assinatura] assinaturas que NÃO puderam ser ajustadas:',
                  falhas.map(f => f.uid).join(', '),
                  '(rodar de novo depois — é idempotente)');
  }

  console.log('[ajustar-valor-assinatura] concluído — total:', linhas.length,
              'sucesso:', sucesso, 'falhas:', falhas.length);

  return json(200, {
    ok: true,
    total: linhas.length,
    sucesso,
    falhas
  });
};
