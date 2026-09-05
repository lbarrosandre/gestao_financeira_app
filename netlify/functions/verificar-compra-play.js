/* ═══════════════════════════════════════════════════════════════════
   VERIFICAR COMPRA — GOOGLE PLAY BILLING
   Recebe o purchaseToken devolvido pelo Play Billing no app Android,
   pergunta ao Google qual é o estado real dessa assinatura e grava o
   resultado em `assinaturas`. É esta tabela que o app lê (planoEfetivo())
   para liberar o Premium — na web também, porque é a mesma conta.

   POR QUE VALIDAR NO SERVIDOR: o purchaseToken que chega do app é só uma
   string. Confiar nela seria liberar Premium para quem mandasse qualquer
   coisa. Quem diz se a assinatura existe, está paga e continua ativa é a
   API do Google, chamada aqui com credenciais que só existem no servidor.

   O "ACKNOWLEDGE" NÃO É OPCIONAL: o Google REEMBOLSA automaticamente toda
   compra que não for confirmada em até 3 dias. Sem o passo 7 o assinante
   pagaria, usaria, e teria o dinheiro devolvido sozinho — com o Premium
   sumindo depois. É por isso que ele roda mesmo quando a assinatura já
   está ativa e nada mais mudou.

   CommonJS puro, sem dependências npm: usa `fetch` e `crypto` nativos do
   runtime Node 18+ da Netlify. Mesmo padrão das outras functions.

   Variáveis de ambiente exigidas (Netlify → Site settings → Environment):
     - GOOGLE_SA_EMAIL          (client_email do JSON da conta de serviço)
     - GOOGLE_SA_PRIVATE_KEY    (private_key do mesmo JSON, com os \n)
     - ANDROID_PACKAGE_NAME     (br.com.bussolafinance.app)
     - SUPABASE_URL
     - SUPABASE_SERVICE_ROLE_KEY

   DEPENDE DA MIGRAÇÃO no Supabase (senão a gravação falha e esta function
   devolve erro dizendo exatamente isso):
     alter table assinaturas add column if not exists play_purchase_token text;
     alter table assinaturas add column if not exists play_product_id  text;
   ═══════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');

/* Mesmo racional de cancelar-assinatura.js: o schema usa `uid TEXT` (NÃO
   uuid), então não exigimos formato uuid — só uma string "razoável". A
   validação de verdade é o passo 4, contra a tabela `profiles`. */
const RE_UID = /^[A-Za-z0-9._:-]{8,128}$/;

/* O token do Play é opaco e longo; validamos só o formato grosseiro para
   não mandar lixo pra API do Google. */
const RE_TOKEN = /^[A-Za-z0-9._~-]{20,1000}$/;

/* Único produto vendido hoje. Deixar explícito impede que um token de
   OUTRO produto (um dia, um plano anual mais barato) libere o Premium. */
const PRODUTOS_VALIDOS = ['premium_mensal'];

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ANDROID_API      = 'https://androidpublisher.googleapis.com/androidpublisher/v3';

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

function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ── Access token do Google (fluxo JWT bearer de conta de serviço) ──
   Sem biblioteca: monta e assina o JWT com o crypto nativo e troca por um
   access token. Vale 1h; como cada invocação da function é um processo
   novo, não vale a pena cachear. */
async function googleAccessToken(email, chavePrivada) {
  const agora  = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim  = base64url(JSON.stringify({
    iss:   email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud:   GOOGLE_TOKEN_URL,
    exp:   agora + 3600,
    iat:   agora
  }));

  let assinatura;
  try {
    assinatura = crypto.createSign('RSA-SHA256')
      .update(header + '.' + claim)
      .sign(chavePrivada);
  } catch (e) {
    /* Erro clássico: a private key colada na Netlify ficou com os "\n"
       literais em vez de quebras de linha reais (ver normalizarChave). */
    throw new Error('chave privada da conta de serviço inválida: ' + e.message);
  }

  const jwt = header + '.' + claim + '.' + base64url(assinatura);

  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt
    }).toString()
  });

  const txt = await r.text();
  if (!r.ok) throw new Error('Google recusou o JWT (' + r.status + '): ' + txt.slice(0, 300));

  let data = null;
  try { data = JSON.parse(txt); } catch (e) { data = null; }
  if (!data?.access_token) throw new Error('resposta do Google sem access_token: ' + txt.slice(0, 200));
  return data.access_token;
}

/* A Netlify guarda a chave numa única linha, com "\n" escrito literalmente.
   O crypto precisa das quebras de verdade. Aceita os dois formatos para
   não depender de como a variável foi colada. */
function normalizarChave(v) {
  return String(v || '').replace(/\\n/g, '\n').trim();
}

/* ── Estado da assinatura → status do nosso banco ──
   Só usamos os quatro status que o app conhece ('ativo', 'atrasado',
   'cancelado', 'cortesia'); inventar um valor novo aqui quebraria as telas
   que fazem switch em cima dele.

   CANCELED merece atenção: no Google significa "não renova mais", e NÃO
   "acabou agora". Quem cancelou no dia 3 e pagou até o dia 30 continua com
   direito ao Premium até lá — por isso a data de expiração manda, não o
   rótulo. */
function traduzirEstado(estado, expiraEm) {
  const aindaVale = expiraEm ? (new Date(expiraEm).getTime() > Date.now()) : false;

  switch (estado) {
    case 'SUBSCRIPTION_STATE_ACTIVE':
    case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
      /* Grace period = a cobrança falhou e o Google está tentando de novo.
         O acesso continua de propósito: tirar o Premium de quem só teve um
         cartão recusado é a forma mais rápida de perder um assinante. */
      return 'ativo';

    case 'SUBSCRIPTION_STATE_CANCELED':
      return aindaVale ? 'ativo' : 'cancelado';

    case 'SUBSCRIPTION_STATE_ON_HOLD':
      /* Cobrança em suspenso: o acesso já caiu do lado do Google. */
      return 'atrasado';

    case 'SUBSCRIPTION_STATE_PAUSED':
    case 'SUBSCRIPTION_STATE_EXPIRED':
      return 'cancelado';

    case 'SUBSCRIPTION_STATE_PENDING':
      /* Compra iniciada mas ainda não paga (boleto, aprovação familiar).
         Não libera nada até virar ACTIVE. */
      return 'cancelado';

    default:
      return 'cancelado';
  }
}

exports.handler = async (event) => {
  /* ── 1. Só POST ── */
  if (event.httpMethod !== 'POST') return json(405, { erro: 'Método não permitido.' });

  const supaBase = process.env.SUPABASE_URL;
  const supaKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const saEmail  = process.env.GOOGLE_SA_EMAIL;
  const saKey    = normalizarChave(process.env.GOOGLE_SA_PRIVATE_KEY);
  const pacote   = process.env.ANDROID_PACKAGE_NAME;

  const faltando = [
    !supaBase && 'SUPABASE_URL',
    !supaKey  && 'SUPABASE_SERVICE_ROLE_KEY',
    !saEmail  && 'GOOGLE_SA_EMAIL',
    !saKey    && 'GOOGLE_SA_PRIVATE_KEY',
    !pacote   && 'ANDROID_PACKAGE_NAME'
  ].filter(Boolean);
  if (faltando.length) {
    console.error('[verificar-compra-play] variáveis de ambiente ausentes:', faltando.join(', '));
    return json(500, { erro: 'Configuração incompleta no servidor.' });
  }

  /* ── 2. Corpo JSON: { uid, purchaseToken, productId } ── */
  let payload = null;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) { return json(400, { erro: 'JSON inválido.' }); }

  const uid      = typeof payload?.uid           === 'string' ? payload.uid.trim()           : '';
  const token    = typeof payload?.purchaseToken === 'string' ? payload.purchaseToken.trim() : '';
  const produto  = typeof payload?.productId     === 'string' ? payload.productId.trim()     : '';

  if (!uid || !RE_UID.test(uid))       return json(400, { erro: 'uid inválido.' });
  if (!token || !RE_TOKEN.test(token)) return json(400, { erro: 'purchaseToken inválido.' });
  if (!PRODUTOS_VALIDOS.includes(produto)) {
    console.warn('[verificar-compra-play] produto desconhecido:', produto);
    return json(400, { erro: 'produto inválido.' });
  }

  console.log('[verificar-compra-play] início — uid:', uid, 'produto:', produto);

  try {
    /* ── 3. O uid existe mesmo? (mesmo padrão das outras functions) ── */
    const rPerfil = await fetch(
      `${supaBase}/rest/v1/profiles?uid=eq.${encodeURIComponent(uid)}&select=uid`,
      { headers: supaHeaders(supaKey) }
    );
    if (!rPerfil.ok) {
      console.error('[verificar-compra-play] falha ao consultar profiles:', rPerfil.status);
      return json(502, { erro: 'Não foi possível validar a conta agora.' });
    }
    const perfis = await rPerfil.json();
    if (!Array.isArray(perfis) || perfis.length === 0) return json(403, { erro: 'Conta não encontrada.' });

    /* ── 4. Esse token já pertence a OUTRA conta? ──
       Um mesmo purchaseToken não pode liberar Premium em duas contas: sem
       esta checagem, quem repassasse o token daria acesso de graça a
       terceiros em cima da própria assinatura. */
    const rDono = await fetch(
      `${supaBase}/rest/v1/assinaturas?play_purchase_token=eq.${encodeURIComponent(token)}&select=uid`,
      { headers: supaHeaders(supaKey) }
    );
    if (rDono.ok) {
      const donos = await rDono.json();
      const outro = Array.isArray(donos) ? donos.find(d => d.uid && d.uid !== uid) : null;
      if (outro) {
        console.warn('[verificar-compra-play] token já vinculado a outro uid — recusado. uid pedido:', uid);
        return json(409, { erro: 'Esta assinatura já está vinculada a outra conta.' });
      }
    } else {
      const txt = await rDono.text();
      /* Coluna ausente = migração não rodou. Falhar aqui, alto e claro, é
         melhor do que seguir e descobrir depois que nada foi gravado. */
      if (txt.includes('play_purchase_token')) {
        console.error('[verificar-compra-play] coluna play_purchase_token não existe — rode a migração.');
        return json(500, { erro: 'Banco desatualizado: falta a coluna play_purchase_token em assinaturas.' });
      }
      console.error('[verificar-compra-play] erro ao checar dono do token:', rDono.status, txt.slice(0, 200));
      return json(502, { erro: 'Não foi possível validar a compra agora.' });
    }

    /* ── 5. Credencial do Google ── */
    const accessToken = await googleAccessToken(saEmail, saKey);

    /* ── 6. Estado real da assinatura, direto no Google ── */
    const urlAssin = `${ANDROID_API}/applications/${encodeURIComponent(pacote)}`
                   + `/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`;
    const rAssin = await fetch(urlAssin, { headers: { Authorization: `Bearer ${accessToken}` } });
    const txtAssin = await rAssin.text();

    if (rAssin.status === 404 || rAssin.status === 410) {
      console.warn('[verificar-compra-play] token desconhecido/expirado no Google — uid:', uid);
      return json(404, { erro: 'Compra não encontrada no Google Play.' });
    }
    if (!rAssin.ok) {
      console.error('[verificar-compra-play] Google recusou a consulta:', rAssin.status, txtAssin.slice(0, 300));
      return json(502, { erro: 'Não foi possível confirmar a compra com o Google agora.' });
    }

    let assin = null;
    try { assin = JSON.parse(txtAssin); } catch (e) { assin = null; }
    if (!assin) return json(502, { erro: 'Resposta inesperada do Google Play.' });

    /* O produto vem dentro de lineItems (a v2 já prevê planos múltiplos). */
    const item      = Array.isArray(assin.lineItems) ? assin.lineItems[0] : null;
    const produtoOk = item?.productId === produto;
    if (!produtoOk) {
      console.warn('[verificar-compra-play] produto do token difere do informado:', item?.productId, '≠', produto);
      return json(400, { erro: 'Esta compra não corresponde ao plano Premium.' });
    }

    const expiraEm = item?.expiryTime || null;
    const estado   = assin.subscriptionState || '';
    const status   = traduzirEstado(estado, expiraEm);

    console.log('[verificar-compra-play] uid:', uid, '| estado Google:', estado,
                '| status gravado:', status, '| expira:', expiraEm);

    /* ── 7. Acknowledge — sem isto o Google reembolsa em 3 dias ── */
    if (assin.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING') {
      const urlAck = `${ANDROID_API}/applications/${encodeURIComponent(pacote)}`
                   + `/purchases/subscriptions/${encodeURIComponent(produto)}`
                   + `/tokens/${encodeURIComponent(token)}:acknowledge`;
      const rAck = await fetch(urlAck, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: '{}'
      });
      if (rAck.ok) {
        console.log('[verificar-compra-play] compra confirmada (acknowledge) — uid:', uid);
      } else {
        /* Já confirmada por outra chamada é resultado bom, não erro: o
           plugin do app também pode ter confirmado antes de chegar aqui. */
        const txtAck = await rAck.text();
        const jaFeito = rAck.status === 400 && txtAck.includes('already acknowledged');
        if (jaFeito) console.log('[verificar-compra-play] compra já estava confirmada — uid:', uid);
        else console.error('[verificar-compra-play] FALHA no acknowledge — uid:', uid,
                           'status:', rAck.status, 'resp:', txtAck.slice(0, 300));
      }
    }

    /* ── 8. Grava em `assinaturas` (upsert pelo uid) ──
       Falha aqui NÃO pode virar sucesso na resposta: foi exatamente esse
       tipo de gravação silenciosamente recusada que fez baixas sumirem no
       Planejar. Se o banco recusar, o app fica sabendo. */
    const linha = {
      uid,
      status,
      plano: 'premium',
      proxima_cobranca: expiraEm,
      play_purchase_token: token,
      play_product_id: produto,
      atualizado_em: new Date().toISOString()
    };

    const rGrava = await fetch(
      `${supaBase}/rest/v1/assinaturas?on_conflict=uid`,
      {
        method: 'POST',
        headers: supaHeaders(supaKey, {
          Prefer: 'resolution=merge-duplicates,return=minimal'
        }),
        body: JSON.stringify(linha)
      }
    );

    if (!rGrava.ok) {
      const txtGrava = await rGrava.text();
      console.error('[verificar-compra-play] FALHA ao gravar assinatura — uid:', uid,
                    'status:', rGrava.status, 'resp:', txtGrava.slice(0, 400));
      if (txtGrava.includes('play_purchase_token') || txtGrava.includes('play_product_id')) {
        return json(500, { erro: 'Banco desatualizado: rode a migração das colunas play_* em assinaturas.' });
      }
      return json(502, { erro: 'A compra foi confirmada, mas não conseguimos liberar o acesso agora. Tente novamente em instantes.' });
    }

    console.log('[verificar-compra-play] OK — uid:', uid, 'status:', status);
    return json(200, {
      ok: true,
      status,
      plano: 'premium',
      proximaCobranca: expiraEm
    });

  } catch (e) {
    console.error('[verificar-compra-play] erro inesperado:', e);
    return json(500, { erro: 'Erro ao verificar a compra.' });
  }
};
