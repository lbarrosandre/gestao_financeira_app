/* ═══════════════════════════════════════════════════════════════════
   Bússola Finance — criar-assinatura
   ───────────────────────────────────────────────────────────────────
   Cria uma assinatura (preapproval) JÁ ATIVA no Mercado Pago a partir
   de um token de cartão gerado no NOSSO próprio site. NÃO existe mais
   redirecionamento: a pessoa nunca sai do bussolafinance.com.br.

   POR QUE SEM REDIRECIONAMENTO
   Antes esta function devolvia um `init_point` (checkout hospedado do
   Mercado Pago) pro client redirecionar. Aquela página tinha o botão
   "Confirmar" permanentemente travado por uma violação de CSP DENTRO
   DA PÁGINA DELES — reproduzido em várias contas, cartões e navegadores.
   Amarrar a preapproval a um plano nativo não resolveu: uma preapproval
   com `preapproval_plan_id` sequer aceita o fluxo de redirecionamento —
   a API responde `{"message":"card_token_id is required"}`, e a doc é
   explícita ("A subscription with an associated plan must always be
   created with your card_token_id and with the status Authorized").
   Então o cartão é tokenizado no client, pelo SDK JS do Mercado Pago
   (campos em iframe deles, dado sensível nunca toca no nosso código),
   e aqui só trafega o `card_token_id` — que é de uso único e expira em
   7 dias, por isso é sempre gerado na hora e nunca armazenado.

   O client escolhe o PLANO ('plus' ou 'premium'); o PREÇO de cada um
   está congelado no preapproval_plan lá no Mercado Pago (ver PLAN_IDS)
   — o client nunca manda valor, só o nome do plano.

   CommonJS puro, sem dependências npm: usa o `fetch` nativo do
   runtime Node 18+ da Netlify e chama Mercado Pago / Supabase via REST.

   Variáveis de ambiente exigidas (Netlify → Site settings → Environment):
     - MP_ACCESS_TOKEN
     - SUPABASE_URL
     - SUPABASE_SERVICE_ROLE_KEY

   NENHUM desses valores pode ser exposto no client — eles só existem aqui.
   (A MP_PUBLIC_KEY usada pelo SDK no navegador é outra chave, essa sim
   pública por natureza, e mora no index.html — não aqui.)
   ═══════════════════════════════════════════════════════════════════ */

/* Preço mensal de cada plano PAGO. O plano 'basico' não aparece aqui de
   propósito: ele é grátis e não gera preapproval nenhuma no Mercado Pago —
   pedir assinatura pra 'basico' é requisição inválida (400 no passo 3).
   Serve só de referência/log daqui pra frente: quem manda no valor
   cobrado agora é o PLANO no Mercado Pago (ver PLAN_IDS abaixo), não mais
   este número — mudar aqui sem mudar o plano lá não muda a cobrança. */
const VALORES_PLANO  = { premium: 14.99 };

/* preapproval_plan_id de cada plano, criados uma única vez via a function
   temporária `criar-planos-mp.js`. Se um dia for preciso mudar preço, NÃO
   dá pra editar o valor aqui: precisa criar um plano novo no Mercado Pago
   com o valor novo e trocar o ID correspondente — um preapproval_plan tem
   o valor congelado nele.

   O plano 'plus' foi descontinuado (o catálogo virou só Grátis + Premium):
   o preapproval_plan dele segue existindo no Mercado Pago para não quebrar
   quem já assinou, mas não é mais oferecido — pedir 'plus' agora cai no
   "plano inválido" do passo 2, porque saiu de VALORES_PLANO. */
const PLAN_IDS = {
  premium: '2b2ec18f28ff48f2bf2e31e5d705b345'
};
const RE_UUID        = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const RE_EMAIL       = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* Tradução dos poucos motivos de recusa em que dizer o motivo REALMENTE
   ajuda a pessoa a resolver (trocar cartão, corrigir CVV, refazer o
   formulário). Tudo que não casar aqui vira a mensagem genérica: detalhe
   técnico do Mercado Pago nunca chega ao usuário. A ordem importa — a
   primeira regra que casar vence. */
const RECUSAS_AMIGAVEIS = [
  { re: /insufficient_amount|insufficient_funds/i,
    msg: 'Cartão sem limite disponível para esta cobrança. Tente outro cartão.' },
  { re: /security_code|cvv/i,
    msg: 'Código de segurança (CVV) incorreto. Confira os dados e tente de novo.' },
  { re: /card_expired|bad_filled_date|expiration/i,
    msg: 'Data de validade do cartão incorreta ou cartão vencido. Confira e tente de novo.' },
  { re: /card_token|invalid_card|card_number/i,
    msg: 'Não conseguimos validar os dados do cartão. Preencha o formulário novamente.' },
  { re: /cc_rejected|call_for_authorize|blacklist|high_risk/i,
    msg: 'Cartão recusado pelo banco. Tente outro cartão.' }
];

const ERRO_GENERICO = 'Não foi possível ativar sua assinatura agora. Tente novamente em instantes.';

/* Procura um motivo amigável na resposta crua do Mercado Pago (o texto
   inteiro, porque o código de recusa às vezes vem em `message`, às vezes
   dentro de `cause[]`). Devolve null quando nada casa. */
function motivoAmigavel(textoResposta) {
  const txt = String(textoResposta || '');
  for (const r of RECUSAS_AMIGAVEIS) {
    if (r.re.test(txt)) return r.msg;
  }
  return null;
}

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

  /* ── 2. Corpo JSON: { uid, email, plano, cardTokenId } ── */
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

  const uid         = typeof payload?.uid         === 'string' ? payload.uid.trim()                     : '';
  const email       = typeof payload?.email       === 'string' ? payload.email.trim().toLowerCase()     : '';
  const plano       = typeof payload?.plano       === 'string' ? payload.plano.trim().toLowerCase()     : '';
  const cardTokenId = typeof payload?.cardTokenId === 'string' ? payload.cardTokenId.trim()             : '';

  /* ── 3. Validação básica ── */
  if (!uid || !email)          return json(400, { erro: 'uid e email são obrigatórios.' });
  if (!RE_UUID.test(uid))      return json(400, { erro: 'uid inválido.' });
  if (!RE_EMAIL.test(email))   return json(400, { erro: 'e-mail inválido.' });
  /* O valor cobrado vem SÓ do plano no Mercado Pago, nunca do client — o
     client manda apenas qual plano quer. Plano desconhecido (ou 'basico',
     que é grátis) não tem preço nesta tabela e é rejeitado. */
  if (!VALORES_PLANO[plano])   return json(400, { erro: 'plano inválido.' });
  /* Sem token de cartão não existe assinatura possível: uma preapproval com
     plano associado SÓ pode nascer authorized, e authorized exige o token. */
  if (!cardTokenId)            return json(400, { erro: 'Dados do cartão não recebidos. Preencha o formulário novamente.' });

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

  /* ── 5. Cria a preapproval JÁ AUTORIZADA no Mercado Pago, amarrada ao
         plano nativo (preapproval_plan_id) e ao cartão tokenizado no client.

         Não vai `back_url` (não existe pra onde voltar — ninguém sai do
         site) nem `auto_recurring` (frequência/valor/moeda estão congelados
         no plano; reenviar poderia divergir do que está lá). `status:
         'authorized'` é o único valor aceito quando há plano associado:
         a cobrança acontece agora, sem período de teste. ── */
  const planId = PLAN_IDS[plano];
  if (!planId) {
    console.error('[criar-assinatura] plano sem preapproval_plan_id cadastrado:', plano);
    return json(500, { erro: 'Serviço de assinatura indisponível no momento.' });
  }

  let mpData;
  try {
    const rMp = await fetch('https://api.mercadopago.com/preapproval', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        preapproval_plan_id: planId,
        card_token_id: cardTokenId,
        external_reference: uid,
        payer_email: email,
        status: 'authorized'
      })
    });

    const txt = await rMp.text();

    /* ── 6. Erro do MP: log detalhado no servidor, mensagem útil (mas sem
           detalhe técnico) pro client. Recusa de cartão é o caso comum aqui,
           e é o único em que vale a pena dizer o motivo. ── */
    if (!rMp.ok) {
      console.error('[criar-assinatura] Mercado Pago retornou erro — uid:', uid,
                    'status:', rMp.status, 'resp:', txt);
      return json(502, { erro: motivoAmigavel(txt) || ERRO_GENERICO });
    }

    try {
      mpData = JSON.parse(txt);
    } catch (e) {
      console.error('[criar-assinatura] resposta do Mercado Pago não é JSON — uid:', uid, 'resp:', txt);
      return json(502, { erro: ERRO_GENERICO });
    }
  } catch (e) {
    console.error('[criar-assinatura] falha de rede ao chamar Mercado Pago — uid:', uid, e);
    return json(502, { erro: ERRO_GENERICO });
  }

  /* ── 7. A preapproval precisa ter nascido `authorized`. O request pode dar
         200 e mesmo assim a assinatura ficar 'pending' — quando o emissor
         não autorizou o cartão do jeito esperado. Isso é falha pro usuário:
         nada foi cobrado e não há acesso a liberar. ── */
  const mpStatus         = mpData.status ? String(mpData.status) : '';
  const mpSubscriptionId = mpData.id ? String(mpData.id) : '';

  if (mpStatus !== 'authorized' || !mpSubscriptionId) {
    console.error('[criar-assinatura] preapproval não autorizada — uid:', uid,
                  'status:', mpStatus, 'resp:', JSON.stringify(mpData));
    return json(502, { erro: 'Cartão recusado pelo banco. Tente outro cartão.' });
  }

  console.log('[criar-assinatura] preapproval autorizada — uid:', uid,
              'mp_subscription_id:', mpSubscriptionId);

  /* ── 8. Grava o mp_subscription_id JÁ (antes de o webhook chegar):
         é isso que permite o webhook achar o usuário certo depois.

         Grava também o `plano` escolhido AGORA, e não depois: o webhook só
         mexe em `status`, nunca em `plano` — e não precisa mesmo, porque o
         valor da assinatura já saiu daqui com o plano certo.
         Assim, quando o pagamento confirmar, a linha já sabe o que foi
         contratado.

         UPSERT, não PATCH: um PATCH com `?uid=eq.` só grava se JÁ existir uma
         linha pra esse uid — se por qualquer motivo ela não existir (ex: o
         trigger que cria a linha de trial falhou silenciosamente pra essa
         conta), a gravação passava em branco sem erro nenhum. Upsert garante
         a gravação nos dois casos (cria se não existir, atualiza se existir). ── */
  try {
    const rUpsert = await fetch(
      /* on_conflict=uid explícito: garante que o PostgREST sabe usar `uid`
         como alvo do upsert mesmo que ele não seja literalmente a chave
         primária da tabela (só precisa ter uma constraint UNIQUE nela, que
         já é premissa de todo o resto do app — uma linha por uid). */
      `${supaBase}/rest/v1/assinaturas?on_conflict=uid`,
      {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify({
          uid: uid,
          mp_subscription_id: mpSubscriptionId,
          mp_payer_email: email,
          plano: plano,
          atualizado_em: new Date().toISOString()
        })
      }
    );

    if (!rUpsert.ok) {
      const txt = await rUpsert.text().catch(() => '');
      /* Não aborta: a assinatura já está autorizada no MP e a cobrança vai
         acontecer. O webhook ainda consegue linkar pelo external_reference
         (uid). Mas isso PRECISA aparecer no log pra investigação. */
      console.error('[criar-assinatura] FALHA ao gravar mp_subscription_id no Supabase — uid:', uid,
                    'status:', rUpsert.status, 'resp:', txt);
    } else {
      console.log('[criar-assinatura] mp_subscription_id gravado no Supabase — uid:', uid);
    }
  } catch (e) {
    console.error('[criar-assinatura] erro ao gravar mp_subscription_id no Supabase — uid:', uid, e);
  }

  /* ── 9. Sem checkoutUrl: não existe redirecionamento. O client só precisa
         saber que deu certo — quem vira `assinaturas.status = 'ativo'` é o
         webhook, quando o Mercado Pago confirmar o pagamento. ── */
  return json(200, { ok: true, status: mpStatus });
};
