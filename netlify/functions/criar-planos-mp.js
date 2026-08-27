/* ═══════════════════════════════════════════════════════════════════
   Bússola Finance — criar-planos-mp   ⚠️ FUNCTION TEMPORÁRIA ⚠️
   ───────────────────────────────────────────────────────────────────
   ESTA FUNCTION DEVE SER APAGADA DO PROJETO depois de rodar UMA vez.
   Ela não faz parte do fluxo do app: nenhuma tela de usuário a chama,
   nada no app depende dela. É uma ferramenta de bootstrap, rodada à mão
   pelo admin, cujo único produto são DOIS IDs de plano do Mercado Pago
   que precisam ser anotados e colados depois, à mão, em
   `criar-assinatura.js`. Anotou os IDs → apague este arquivo e o botão
   correspondente no Painel Admin.

   ── Por que isso existe ──
   O checkout atual cria uma `preapproval` avulsa, SEM
   `preapproval_plan_id`. A página de checkout que o Mercado Pago
   hospeda para esse caso tem o botão "Confirmar" permanentemente
   desabilitado por uma violação de CSP NA PÁGINA DELES — reproduzido em
   várias contas, cartões e navegadores, então não é bug do nosso lado.
   A hipótese a testar: uma preapproval AMARRADA a um plano nativo
   (`preapproval_plan_id`) cai numa página de checkout diferente, sem o
   bug. Só que para amarrar a um plano é preciso que o plano exista — e
   criar plano é `POST /preapproval_plan`, que é exatamente o que esta
   function faz.

   ── Idempotência: NÃO tem, de propósito ──
   Rodar duas vezes cria DOIS pares de planos duplicados no Mercado
   Pago. Não há checagem de "já existe" porque não existe chave natural
   para consultar (o MP aceita planos com o mesmo `reason` sem
   reclamar), e inventar uma trava daria falsa sensação de segurança
   numa function que é executada uma única vez, manualmente, por uma
   pessoa que está olhando o resultado. Cuidado é do operador: rodou,
   anotou os IDs, apagou o arquivo.

   ── Tudo-ou-nada ──
   Se QUALQUER um dos dois planos falhar na API do MP, a resposta é 502.
   Meio-criado não serve pra nada: o app tem dois planos pagos e precisa
   dos dois IDs pra seguir. O corpo do erro do MP vai pro log do
   servidor, nunca pro client.

   ── O portão de admin ──
   Mesmo padrão de `enviar-reengajamento.js` / `admin-relatorio.js`:
   consulta `profiles.is_admin` do `uidAdmin` com a SERVICE ROLE (a RLS
   não deixaria ninguém ler a flag de outra pessoa, e aqui essa leitura
   É a autorização). Sem linha, flag diferente de `true`, ou erro → 403
   e nenhum plano é criado. Flag do client não vale nada: quem forçar
   `window._souAdmin = true` no console chega até aqui e leva 403.

   ── Comportamento esperado (para validação por leitura de código) ──
     • método != POST ..................... 405
     • env var faltando ................... 500
     • corpo não-JSON / uidAdmin vazio .... 400
     • uidAdmin sem perfil / não admin .... 403, nenhum plano criado
     • falha ao checar is_admin ........... 502, nenhum plano criado
     • MP recusou qualquer um dos planos .. 502 (detalhe só no log)
     • tudo certo ......................... 200 { ok:true, planos:{plus,premium} }

   CommonJS puro, sem dependências npm: usa o `fetch` nativo do
   runtime Node 18+ da Netlify e chama Mercado Pago / Supabase via REST.

   Variáveis de ambiente exigidas (já configuradas):
     - MP_ACCESS_TOKEN            (a MESMA de criar-assinatura.js)
     - SUPABASE_URL
     - SUPABASE_SERVICE_ROLE_KEY

   NENHUM desses valores pode ser exposto no client — eles só existem aqui.
   ═══════════════════════════════════════════════════════════════════ */

/* Espelho exato de VALORES_PLANO em `criar-assinatura.js`. Se os preços
   mudarem lá, os planos criados aqui viram lixo: um plano do Mercado
   Pago tem o valor congelado dentro dele, e uma assinatura amarrada ao
   plano cobra o valor DO PLANO, não o que a nossa function mandar.
   Divergência entre os dois arquivos = cobrança errada. */
const VALORES_PLANO = { plus: 9.90, premium: 14.99 };

/* Mesma BACK_URL de `criar-assinatura.js`: é pra onde o Mercado Pago
   devolve a pessoa depois do checkout, e o app já sabe tratar esse
   parâmetro. */
const BACK_URL = 'https://bussola-finance.netlify.app/?assinatura=retorno';

/* Mesmo racional de `admin-relatorio.js` e `enviar-reengajamento.js`: o
   schema usa `uid TEXT` (NÃO uuid), então não exigimos formato uuid —
   só uma string "razoável". A validação de verdade é a consulta a
   `profiles`. */
const RE_UID = /^[A-Za-z0-9._:@-]{8,128}$/;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function supaHeaders(key, extra) {
  return Object.assign({
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json'
  }, extra || {});
}

/* Cria um plano e devolve `{ ok, id }` ou `{ ok:false, detalhe }`. Não
   lança: quem chama decide o que fazer com a falha (aqui, abortar). */
async function criarPlano(token, rotulo, valor) {
  const corpo = {
    reason: `Bússola Finance — Assinatura ${rotulo}`,
    auto_recurring: {
      frequency: 1,
      frequency_type: 'months',
      transaction_amount: valor,
      currency_id: 'BRL'
    },
    back_url: BACK_URL
  };

  let resp;
  try {
    resp = await fetch('https://api.mercadopago.com/preapproval_plan', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(corpo)
    });
  } catch (e) {
    return { ok: false, detalhe: `falha de rede: ${e && e.message ? e.message : e}` };
  }

  const txt = await resp.text().catch(() => '');

  if (!resp.ok) {
    return { ok: false, detalhe: `status ${resp.status} — resp: ${txt}` };
  }

  let dados;
  try {
    dados = JSON.parse(txt);
  } catch (e) {
    return { ok: false, detalhe: `resposta não é JSON — resp: ${txt}` };
  }

  if (!dados || !dados.id) {
    return { ok: false, detalhe: `resposta sem id — resp: ${txt}` };
  }

  return { ok: true, id: String(dados.id) };
}

exports.handler = async (event) => {
  /* ── 1. Só POST ── */
  if (event.httpMethod !== 'POST') {
    console.warn('[criar-planos-mp] método rejeitado:', event.httpMethod);
    return json(405, { erro: 'Método não permitido.' });
  }

  /* ── 2. Config obrigatória ── */
  const MP_ACCESS_TOKEN           = process.env.MP_ACCESS_TOKEN;
  const SUPABASE_URL              = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!MP_ACCESS_TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[criar-planos-mp] variáveis de ambiente ausentes:', {
      MP_ACCESS_TOKEN: !!MP_ACCESS_TOKEN,
      SUPABASE_URL: !!SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!SUPABASE_SERVICE_ROLE_KEY
    });
    return json(500, { erro: 'Serviço indisponível no momento.' });
  }

  const supaBase = String(SUPABASE_URL).replace(/\/+$/, '');

  /* ── 3. Corpo JSON: { uidAdmin } ── */
  let payload;
  try {
    const raw = event.isBase64Encoded && event.body
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : (event.body || '');
    payload = JSON.parse(raw);
  } catch (e) {
    console.error('[criar-planos-mp] body inválido (JSON):', e.message);
    return json(400, { erro: 'Requisição inválida.' });
  }

  const uidAdmin = typeof payload?.uidAdmin === 'string' ? payload.uidAdmin.trim() : '';

  if (!uidAdmin)              return json(400, { erro: 'uidAdmin é obrigatório.' });
  if (!RE_UID.test(uidAdmin)) {
    console.warn('[criar-planos-mp] uidAdmin com formato inválido — tamanho:', uidAdmin.length);
    return json(400, { erro: 'uidAdmin inválido.' });
  }

  /* ── 4. PORTÃO DE ADMIN ──
         Cópia fiel do passo 5 de `enviar-reengajamento.js`. Consulta com
         a service role DE PROPÓSITO: a RLS de `profiles` não deixaria
         ninguém ler a flag de outra pessoa, e aqui a leitura É a própria
         checagem de autorização. A resposta ao client é sempre a mesma
         mensagem, sem dizer qual dos casos aconteceu. ── */
  try {
    const r = await fetch(
      `${supaBase}/rest/v1/profiles?uid=eq.${encodeURIComponent(uidAdmin)}&select=is_admin`,
      { method: 'GET', headers: supaHeaders(SUPABASE_SERVICE_ROLE_KEY) }
    );

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`profiles (checagem de admin) — status ${r.status} — resp: ${txt}`);
    }

    const linhas = await r.json();

    if (!Array.isArray(linhas) || linhas.length === 0) {
      console.warn('[criar-planos-mp] ACESSO NEGADO — uid sem perfil:', uidAdmin);
      return json(403, { erro: 'Acesso restrito ao administrador.' });
    }
    if (linhas[0]?.is_admin !== true) {
      console.warn('[criar-planos-mp] ACESSO NEGADO — uid não é admin:', uidAdmin);
      return json(403, { erro: 'Acesso restrito ao administrador.' });
    }

    console.log('[criar-planos-mp] acesso liberado para admin — uid:', uidAdmin);
  } catch (e) {
    console.error('[criar-planos-mp] erro ao checar is_admin — uid:', uidAdmin, e);
    /* 502 (e não 403) porque é falha de infra, não de autorização. */
    return json(502, { erro: 'Não foi possível validar seu acesso agora. Tente novamente.' });
  }

  /* ── 5. Cria os dois planos ──
         Sequencial, não `Promise.all`: se o primeiro já falhar (token
         sem permissão, conta sem checkout de assinatura habilitado), não
         há motivo pra criar o segundo e deixar um plano órfão pendurado
         numa conta de produção. ── */
  console.log('[criar-planos-mp] criando planos — plus:', VALORES_PLANO.plus,
              'premium:', VALORES_PLANO.premium);

  const rPlus = await criarPlano(MP_ACCESS_TOKEN, 'Plus', VALORES_PLANO.plus);
  if (!rPlus.ok) {
    console.error('[criar-planos-mp] Mercado Pago recusou o plano Plus —', rPlus.detalhe);
    return json(502, { erro: 'Não foi possível criar os planos no Mercado Pago.' });
  }
  console.log('[criar-planos-mp] plano Plus criado — id:', rPlus.id);

  const rPremium = await criarPlano(MP_ACCESS_TOKEN, 'Premium', VALORES_PLANO.premium);
  if (!rPremium.ok) {
    /* O plano Plus JÁ existe no Mercado Pago neste ponto e não há como
       desfazer isso por API. O id vai pro log de propósito: se o operador
       for reexecutar depois de corrigir o problema, ele precisa saber que
       existe um Plus órfão pra arquivar/ignorar no painel do MP. */
    console.error('[criar-planos-mp] Mercado Pago recusou o plano Premium —', rPremium.detalhe,
                  '— ATENÇÃO: o plano Plus já foi criado e ficou órfão, id:', rPlus.id);
    return json(502, { erro: 'Não foi possível criar os planos no Mercado Pago.' });
  }
  console.log('[criar-planos-mp] plano Premium criado — id:', rPremium.id);

  /* Log em bloco: é daqui que os IDs são copiados pro `criar-assinatura.js`
     caso o admin feche a tela antes de anotar o que o app mostrou. */
  console.log('[criar-planos-mp] CONCLUÍDO — admin:', uidAdmin,
              '— preapproval_plan_id PLUS:', rPlus.id,
              '— preapproval_plan_id PREMIUM:', rPremium.id,
              '— anote os dois e APAGUE esta function.');

  return json(200, { ok: true, planos: { plus: rPlus.id, premium: rPremium.id } });
};
