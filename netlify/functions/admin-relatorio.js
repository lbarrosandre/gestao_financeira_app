/* ═══════════════════════════════════════════════════════════════════
   Bússola Finance — admin-relatorio
   ───────────────────────────────────────────────────────────────────
   Relatório de administração: TODOS os usuários do app, quando se
   cadastraram, quando acessaram pela última vez, há quantos dias estão
   sem acessar, qual o plano efetivo de cada um — mais um resumo
   agregado (total, MRR, novos, atrasados, elegíveis a exclusão).

   ── Por que isso é uma Netlify Function, e não uma query no client? ──
   Duas informações que o relatório precisa NÃO existem no PostgREST
   com a chave anon:
     • `last_sign_in_at` / `created_at` de cada usuário moram no GoTrue
       (schema `auth`), acessível só pela admin API com service role.
     • A lista de TODOS os perfis/assinaturas é bloqueada pela RLS, que
       (corretamente) só deixa cada um ler a própria linha.
   Então a leitura tem que acontecer no servidor, com a service role
   key — que nunca pode aparecer no client.

   ── O portão de admin ──
   Como a service role ignora RLS, este arquivo é o único lugar onde a
   pergunta "quem está pedindo?" precisa ser respondida à mão. O passo 4
   consulta `profiles.is_admin` do uid que veio no corpo e devolve 403
   se não for `true`. A coluna `is_admin boolean not null default false`
   foi criada por migração já aplicada; a conta do dono do app já está
   marcada. Ninguém mais recebe dado nenhum.

   ⚠️ Este endpoint é SOMENTE LEITURA. Ele não apaga, não altera e não
   cria nada. A exclusão de conta continua sendo `excluir-conta.js`,
   chamada uma a uma, sempre por decisão explícita do admin — NUNCA
   automaticamente a partir de `elegivelExclusao`, que é só um destaque
   visual ("provavelmente vale olhar esta conta"), não uma ordem.

   ── Comportamento esperado (para validação por leitura de código) ──
     • método != POST ..................... 405
     • env var faltando ................... 500
     • corpo não-JSON / uid vazio ......... 400
     • uid sem linha em profiles .......... 403 (mesma resposta de não-admin)
     • uid com is_admin != true ........... 403
     • falha de rede/parse em qualquer
       uma das 3 buscas ................... 502, detalhe só no log
     • tudo certo ......................... 200 { ok:true, usuarios:[...], resumo:{...} }

   CommonJS puro, sem dependências npm: usa o `fetch` nativo do
   runtime Node 18+ da Netlify e chama o Supabase via REST.

   Variáveis de ambiente exigidas (já configuradas — nenhuma nova):
     - SUPABASE_URL
     - SUPABASE_SERVICE_ROLE_KEY

   NENHUM desses valores pode ser exposto no client — eles só existem aqui.
   ═══════════════════════════════════════════════════════════════════ */

/* Mesmo racional de `excluir-conta.js`: o schema usa `uid TEXT` (NÃO uuid),
   então não exigimos formato uuid — só uma string "razoável". A validação
   de verdade é a consulta a `profiles` no passo 4. */
const RE_UID = /^[A-Za-z0-9._:@-]{8,128}$/;

/* Valor mensal de cada plano pago, em reais. Fonte única do MRR deste
   relatório. O Básico é grátis (0) e por isso nem aparece aqui. Se o
   preço mudar na tela de planos do app, mude aqui também — senão o MRR
   passa a mentir silenciosamente. */
const VALOR_PLANO = { plus: 9.90, premium: 14.99 };

/* Quantos dias sem acessar tornam uma conta do Básico "candidata a
   exclusão". Só destaque visual — ver aviso no cabeçalho. */
const DIAS_INATIVO_LIMITE = 30;

/* Paginação da admin API do GoTrue. 1000 é o teto prático por página;
   o loop do passo 5 continua pedindo páginas até vir uma incompleta. */
const AUTH_PER_PAGE = 1000;
/* Trava de segurança do loop de paginação: mesmo que a API responda
   sempre "cheio" por algum bug, o loop para aqui em vez de rodar pra
   sempre e estourar o tempo da function. */
const AUTH_MAX_PAGINAS = 50;

const MS_DIA = 86400000;

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

/* Dias INTEIROS decorridos entre `iso` e agora. Devolve null se a data
   for ausente ou inválida — quem chama decide o fallback (nunca fingimos
   "0 dias", que leria como "acessou hoje" e é o oposto da verdade). */
function diasDesde(iso, agora) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return Math.floor((agora - t) / MS_DIA);
}

/* Réplica EXATA da regra de `planoEfetivo()` do client (index.html):
   só 'ativo'/'cortesia' valem o plano contratado; trial, atrasado,
   cancelado ou SEM linha em `assinaturas` caem pro Básico.
   As duas cópias precisam concordar — se a regra mudar lá, muda aqui. */
function planoEfetivoDe(assin) {
  if (!assin) return 'basico';
  if (assin.status === 'ativo' || assin.status === 'cortesia') {
    return assin.plano || 'basico';
  }
  return 'basico';
}

/* GET + JSON com erro falante. Qualquer falha vira throw, e o handler
   converte num 502 genérico — o detalhe fica só no log do servidor. */
async function buscarJson(url, headers, rotulo) {
  const r = await fetch(url, { method: 'GET', headers });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`${rotulo} — status ${r.status} — resp: ${txt}`);
  }
  try {
    return await r.json();
  } catch (e) {
    throw new Error(`${rotulo} — resposta não é JSON: ${e.message}`);
  }
}

/* Lista TODOS os usuários de autenticação, paginando.
   A admin API do GoTrue responde `{ users: [...], aud, ... }`, mas
   toleramos também um array puro — se o formato mudar numa versão
   futura do Supabase, o relatório continua funcionando em vez de
   devolver zero usuário silenciosamente. */
async function listarUsuariosAuth(supaBase, key) {
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`
  };

  const todos = [];
  let page = 1;

  while (page <= AUTH_MAX_PAGINAS) {
    const data = await buscarJson(
      `${supaBase}/auth/v1/admin/users?per_page=${AUTH_PER_PAGE}&page=${page}`,
      headers,
      `GoTrue admin/users (página ${page})`
    );

    const lote = Array.isArray(data) ? data
               : Array.isArray(data?.users) ? data.users
               : null;

    if (lote === null) {
      throw new Error(
        `GoTrue admin/users (página ${page}) — formato inesperado, chaves: ${Object.keys(data || {}).join(',') || '(nenhuma)'}`
      );
    }

    todos.push(...lote);

    /* Página incompleta (ou vazia) = acabou. */
    if (lote.length < AUTH_PER_PAGE) break;
    page++;
  }

  if (page > AUTH_MAX_PAGINAS) {
    console.warn('[admin-relatorio] limite de páginas atingido (', AUTH_MAX_PAGINAS,
                 ') — a lista pode estar truncada. Usuários lidos:', todos.length);
  }

  return todos;
}

exports.handler = async (event) => {
  /* ── 1. Só POST ── */
  if (event.httpMethod !== 'POST') {
    console.warn('[admin-relatorio] método rejeitado:', event.httpMethod);
    return json(405, { erro: 'Método não permitido.' });
  }

  /* ── 2. Config obrigatória ── */
  const SUPABASE_URL              = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[admin-relatorio] variáveis de ambiente ausentes:', {
      SUPABASE_URL: !!SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!SUPABASE_SERVICE_ROLE_KEY
    });
    return json(500, { erro: 'Serviço indisponível no momento.' });
  }

  const supaBase = String(SUPABASE_URL).replace(/\/+$/, '');

  /* ── 3. Corpo JSON: { uid } — uid de QUEM ESTÁ PEDINDO o relatório ── */
  let payload;
  try {
    const raw = event.isBase64Encoded && event.body
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : (event.body || '');
    payload = JSON.parse(raw);
  } catch (e) {
    console.error('[admin-relatorio] body inválido (JSON):', e.message);
    return json(400, { erro: 'Requisição inválida.' });
  }

  const uid = typeof payload?.uid === 'string' ? payload.uid.trim() : '';

  if (!uid)              return json(400, { erro: 'uid é obrigatório.' });
  if (!RE_UID.test(uid)) {
    console.warn('[admin-relatorio] uid com formato inválido — tamanho:', uid.length);
    return json(400, { erro: 'uid inválido.' });
  }

  /* ── 4. PORTÃO DE ADMIN ──
         Consulta feita com a service role DE PROPÓSITO: a RLS de
         `profiles` não deixaria ninguém ler a flag de outra pessoa, e
         aqui a leitura É a própria checagem de autorização.
         Sem linha, `is_admin` falso/ausente, ou erro → ninguém entra.
         A resposta ao client é sempre a mesma mensagem, sem dizer qual
         dos casos aconteceu (quem tentou fica registrado só no log). */
  try {
    const linhas = await buscarJson(
      `${supaBase}/rest/v1/profiles?uid=eq.${encodeURIComponent(uid)}&select=is_admin`,
      supaHeaders(SUPABASE_SERVICE_ROLE_KEY),
      'profiles (checagem de admin)'
    );

    if (!Array.isArray(linhas) || linhas.length === 0) {
      console.warn('[admin-relatorio] ACESSO NEGADO — uid sem perfil:', uid);
      return json(403, { erro: 'Acesso restrito ao administrador.' });
    }
    if (linhas[0]?.is_admin !== true) {
      console.warn('[admin-relatorio] ACESSO NEGADO — uid não é admin:', uid);
      return json(403, { erro: 'Acesso restrito ao administrador.' });
    }

    console.log('[admin-relatorio] acesso liberado para admin — uid:', uid);
  } catch (e) {
    console.error('[admin-relatorio] erro ao checar is_admin — uid:', uid, e);
    /* Não deu pra confirmar que é admin → não entrega dado nenhum.
       502 (e não 403) porque é falha de infra, não de autorização. */
    return json(502, { erro: 'Não foi possível carregar o relatório agora. Tente novamente.' });
  }

  /* ── 5. As 3 buscas, em paralelo (nenhuma depende da outra) ── */
  let perfis, assinaturas, usuariosAuth;
  try {
    [perfis, assinaturas, usuariosAuth] = await Promise.all([
      buscarJson(
        `${supaBase}/rest/v1/profiles?select=uid,nome,email,is_admin`,
        supaHeaders(SUPABASE_SERVICE_ROLE_KEY),
        'profiles (lista)'
      ),
      buscarJson(
        `${supaBase}/rest/v1/assinaturas?select=uid,status,plano`,
        supaHeaders(SUPABASE_SERVICE_ROLE_KEY),
        'assinaturas (lista)'
      ),
      listarUsuariosAuth(supaBase, SUPABASE_SERVICE_ROLE_KEY)
    ]);
  } catch (e) {
    console.error('[admin-relatorio] falha ao buscar dados — uid do admin:', uid, e);
    return json(502, { erro: 'Não foi possível carregar o relatório agora. Tente novamente.' });
  }

  console.log('[admin-relatorio] dados carregados — perfis:', (perfis || []).length,
              'assinaturas:', (assinaturas || []).length,
              'usuarios auth:', (usuariosAuth || []).length);

  /* ── 6. Junção por uid ──
         A lista do GoTrue é a fonte primária: ela é quem tem as datas
         (created_at/last_sign_in_at) e quem define "existe um usuário".
         `profiles` entra só com nome/e-mail, `assinaturas` com o plano. */
  const perfilPorUid = new Map();
  (Array.isArray(perfis) ? perfis : []).forEach(p => {
    if (p && p.uid) perfilPorUid.set(String(p.uid), p);
  });

  const assinPorUid = new Map();
  (Array.isArray(assinaturas) ? assinaturas : []).forEach(a => {
    if (a && a.uid) assinPorUid.set(String(a.uid), a);
  });

  const agora = Date.now();

  const usuarios = (Array.isArray(usuariosAuth) ? usuariosAuth : []).map(u => {
    const id     = String(u?.id || '');
    const perfil = perfilPorUid.get(id) || null;
    const assin  = assinPorUid.get(id)  || null;

    const dataCadastro = u?.created_at || null;
    const ultimoAcesso = u?.last_sign_in_at || null;

    const diasCadastro = diasDesde(dataCadastro, agora);

    /* Nunca logou (`last_sign_in_at` null) conta como "sem acessar desde
       o cadastro" — é o número honesto: cadastrou e nunca voltou. */
    const diasSemAcesso = diasDesde(ultimoAcesso || dataCadastro, agora);

    const plano = planoEfetivoDe(assin);

    return {
      uid: id,
      nome: (perfil?.nome || '').trim(),
      email: (perfil?.email || u?.email || '').trim(),
      isAdmin: perfil?.is_admin === true,
      dataCadastro,
      ultimoAcesso,
      nuncaAcessou: !ultimoAcesso,
      diasCadastro,
      diasSemAcesso,
      planoEfetivo: plano,
      statusAssinatura: assin?.status || null,
      /* Só destaque visual. A exclusão é sempre manual, uma a uma. */
      elegivelExclusao: plano === 'basico'
                        && diasSemAcesso !== null
                        && diasSemAcesso > DIAS_INATIVO_LIMITE
    };
  });

  /* Mais tempo sem acessar primeiro: quem precisa de atenção fica no topo. */
  usuarios.sort((a, b) => (b.diasSemAcesso ?? -1) - (a.diasSemAcesso ?? -1));

  /* ── 7. Resumo agregado ── */
  const porPlano = { basico: 0, plus: 0, premium: 0 };
  let mrr = 0, novos7dias = 0, novos30dias = 0, atrasados = 0, elegiveisExclusao = 0;

  usuarios.forEach(u => {
    if (porPlano[u.planoEfetivo] === undefined) porPlano[u.planoEfetivo] = 0;
    porPlano[u.planoEfetivo]++;

    /* MRR conta SÓ 'ativo'. 'cortesia' tem o plano liberado mas não paga
       nada — somá-la inflaria a receita com dinheiro que não existe. */
    if (u.statusAssinatura === 'ativo') {
      mrr += VALOR_PLANO[u.planoEfetivo] || 0;
    }
    if (u.statusAssinatura === 'atrasado') atrasados++;

    if (u.diasCadastro !== null) {
      if (u.diasCadastro <= 7)  novos7dias++;
      if (u.diasCadastro <= 30) novos30dias++;
    }

    if (u.elegivelExclusao) elegiveisExclusao++;
  });

  const resumo = {
    totalUsuarios: usuarios.length,
    porPlano,
    mrr: Math.round(mrr * 100) / 100,
    novos7dias,
    novos30dias,
    atrasados,
    elegiveisExclusao
  };

  console.log('[admin-relatorio] concluído — admin:', uid,
              'total:', resumo.totalUsuarios,
              'planos:', JSON.stringify(resumo.porPlano),
              'mrr:', resumo.mrr,
              'atrasados:', resumo.atrasados,
              'elegiveis:', resumo.elegiveisExclusao);

  return json(200, { ok: true, usuarios, resumo });
};
