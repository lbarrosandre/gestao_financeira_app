/* ═══════════════════════════════════════════════════════════════════
   Bússola Finance — excluir-conta
   ───────────────────────────────────────────────────────────────────
   Exclusão definitiva da conta: apaga TODOS os dados do usuário,
   tabela por tabela, e por último remove o próprio usuário de
   autenticação (GoTrue).

   ── Por que apagar tabela por tabela? ──
   NÃO foi confirmado que existem FKs com ON DELETE CASCADE entre as
   tabelas de dados deste projeto. Confiar em cascade seria apostar em
   algo não verificado — e a consequência de errar é dado financeiro do
   usuário sobrevivendo a um pedido de exclusão. Então apagamos cada
   tabela explicitamente, na ordem filho → pai, pra que exista uma
   ordem correta MESMO SE houver FKs sem cascade:

     pagamentos_divida → dividas          (pagamento referencia dívida)
     bolso_movimentos  → bolsos           (movimento referencia bolso)
     planejamentos, lancamentos           (independentes)
     assinaturas       → profiles         (assinaturas.uid REFERENCES profiles.uid)
     profiles                             (por último: todo mundo aponta pra ele)

   ── Tolerância a falha ──
   Se uma tabela falhar, NÃO interrompemos: seguimos pras próximas e
   coletamos os nomes que falharam em `tabelasComErro`. O objetivo é
   apagar o MÁXIMO possível — parar na primeira falha deixaria mais
   dado pra trás, que é justamente o que não queremos.

   ── Comportamento esperado (para validação por leitura de código) ──
     • uid ausente/mal formado ............ 400, nada apagado
     • uid sem linha em `profiles` ........ 403, nada apagado
     • tudo certo ......................... 200 { ok:true, tabelasComErro:[], avisoAuthNaoRemovido:false }
     • alguma tabela falhou ............... 200 { ok:true, tabelasComErro:['x'], ... }
     • só o passo de auth falhou .......... 200 { ok:true, avisoAuthNaoRemovido:true }
   O passo de auth NUNCA vira erro fatal — ver comentário longo no passo 5.

   CommonJS puro, sem dependências npm: usa o `fetch` nativo do
   runtime Node 18+ da Netlify e chama o Supabase via REST.

   Variáveis de ambiente exigidas (já configuradas — nenhuma nova):
     - SUPABASE_URL
     - SUPABASE_SERVICE_ROLE_KEY

   NENHUM desses valores pode ser exposto no client — eles só existem aqui.
   ═══════════════════════════════════════════════════════════════════ */

/* Mesmo racional de `cancelar-assinatura.js`: o schema usa `uid TEXT`
   (NÃO uuid) em todas as tabelas de dados do usuário, então não exigimos
   formato uuid — só uma string "razoável". A validação de verdade é a
   consulta a `profiles` no passo 3. */
const RE_UID = /^[A-Za-z0-9._:@-]{8,128}$/;

/* Ordem filho → pai. NÃO reordene sem reler o comentário do cabeçalho:
   se houver FK sem cascade, apagar `profiles` antes das outras falharia. */
const TABELAS = [
  'pagamentos_divida',
  'dividas',
  'bolso_movimentos',
  'bolsos',
  'planejamentos',
  'lancamentos',
  'assinaturas',
  'profiles'
];

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
    console.warn('[excluir-conta] método rejeitado:', event.httpMethod);
    return json(405, { erro: 'Método não permitido.' });
  }

  /* ── Config obrigatória ── */
  const SUPABASE_URL              = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[excluir-conta] variáveis de ambiente ausentes:', {
      SUPABASE_URL: !!SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!SUPABASE_SERVICE_ROLE_KEY
    });
    return json(500, { erro: 'Serviço indisponível no momento.' });
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
    console.error('[excluir-conta] body inválido (JSON):', e.message);
    return json(400, { erro: 'Requisição inválida.' });
  }

  const uid = typeof payload?.uid === 'string' ? payload.uid.trim() : '';

  if (!uid)              return json(400, { erro: 'uid é obrigatório.' });
  if (!RE_UID.test(uid)) {
    console.warn('[excluir-conta] uid com formato inválido — tamanho:', uid.length);
    return json(400, { erro: 'uid inválido.' });
  }

  console.log('[excluir-conta] início — uid:', uid);

  /* ── 3. Confirma que o uid é um usuário real ANTES de apagar qualquer
         coisa. Mesmo padrão comprovado de `criar-assinatura.js`/
         `cancelar-assinatura.js`: consulta `profiles` via PostgREST.
         Falhou aqui → 403 e NADA é apagado (passo 5 do spec). ── */
  try {
    const rUser = await fetch(
      `${supaBase}/rest/v1/profiles?uid=eq.${encodeURIComponent(uid)}&select=uid`,
      { method: 'GET', headers: supaHeaders(SUPABASE_SERVICE_ROLE_KEY) }
    );

    if (!rUser.ok) {
      const txt = await rUser.text().catch(() => '');
      console.error('[excluir-conta] falha ao consultar profiles — uid:', uid,
                    'status:', rUser.status, 'resp:', txt);
      /* Não dá pra validar → não apaga. Erro de infra, não de autorização. */
      return json(502, { erro: 'Não foi possível validar sua conta agora. Tente novamente.' });
    }

    const linhas = await rUser.json().catch(() => []);
    if (!Array.isArray(linhas) || linhas.length === 0) {
      console.warn('[excluir-conta] uid sem perfil correspondente — uid:', uid, '(nada foi apagado)');
      return json(403, { erro: 'Usuário não autorizado.' });
    }
    console.log('[excluir-conta] usuário validado (profiles) — uid:', uid);
  } catch (e) {
    console.error('[excluir-conta] erro ao validar usuário no Supabase — uid:', uid, e);
    return json(502, { erro: 'Não foi possível validar sua conta agora. Tente novamente.' });
  }

  /* ── 4. Apaga os DADOS, tabela por tabela, sem parar na primeira falha ──
         Sequencial (for/await, não Promise.all) de propósito: a ordem
         filho → pai só significa alguma coisa se for respeitada de fato. */
  const tabelasComErro = [];

  for (const tabela of TABELAS) {
    try {
      const rDel = await fetch(
        `${supaBase}/rest/v1/${tabela}?uid=eq.${encodeURIComponent(uid)}`,
        {
          method: 'DELETE',
          headers: supaHeaders(SUPABASE_SERVICE_ROLE_KEY, { Prefer: 'return=minimal' })
        }
      );

      if (!rDel.ok) {
        const txt = await rDel.text().catch(() => '');
        console.error('[excluir-conta] FALHA ao apagar tabela:', tabela, '— uid:', uid,
                      'status:', rDel.status, 'resp:', txt);
        tabelasComErro.push(tabela);
        continue; /* segue pras próximas: queremos apagar o máximo possível */
      }

      console.log('[excluir-conta] tabela apagada:', tabela, '— uid:', uid,
                  'status HTTP:', rDel.status);
    } catch (e) {
      console.error('[excluir-conta] erro de rede ao apagar tabela:', tabela, '— uid:', uid, e);
      tabelasComErro.push(tabela);
    }
  }

  if (tabelasComErro.length > 0) {
    console.error('[excluir-conta] tabelas que NÃO puderam ser apagadas — uid:', uid,
                  'tabelas:', tabelasComErro.join(', '),
                  '(precisam de limpeza manual)');
  } else {
    console.log('[excluir-conta] todos os dados apagados com sucesso — uid:', uid);
  }

  /* ── 5. Por último: remove o usuário de AUTENTICAÇÃO (GoTrue admin API) ──

         ⚠️ ATENÇÃO — este endpoint específico já deu problema neste projeto.
         Numa tentativa anterior ele devolveu `PGRST125`, que é um código de
         erro do PostgREST, NÃO do GoTrue — sintoma clássico de a requisição
         ter sido roteada pro PostgREST em vez do auth. A causa provável
         (descoberta depois) era a SUPABASE_SERVICE_ROLE_KEY estar com o
         valor ERRADO — a chave `anon` colada por engano. A chave já foi
         corrigida, mas ESTA CHAMADA AINDA NÃO FOI TESTADA em produção.
         Por isso logamos status E corpo completos da resposta: se voltar a
         falhar, o log tem que ser suficiente pra diagnosticar sozinho.

         ⚠️ E MAIS IMPORTANTE: falha aqui NÃO vira erro pro usuário.
         Os DADOS já foram apagados no passo 4 — que é o que importa do
         ponto de vista de privacidade. Devolver 500 aqui faria a pessoa
         achar que NADA foi apagado, quando na verdade tudo já foi. Então
         devolvemos 200 com `avisoAuthNaoRemovido:true`, e sobra no auth
         apenas um usuário órfão sem dado nenhum, removível na mão pelo
         painel do Supabase. */
  let avisoAuthNaoRemovido = false;

  try {
    const rAuth = await fetch(
      `${supaBase}/auth/v1/admin/users/${encodeURIComponent(uid)}`,
      {
        method: 'DELETE',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    );

    const txtAuth = await rAuth.text().catch(() => '');

    if (!rAuth.ok) {
      avisoAuthNaoRemovido = true;
      console.error('[excluir-conta] FALHA ao remover usuário do auth — uid:', uid,
                    'status:', rAuth.status,
                    'resp (corpo completo):', txtAuth,
                    '| Os DADOS já foram apagados. Se o código for PGRST125,',
                    'a requisição caiu no PostgREST em vez do GoTrue — conferir',
                    'se SUPABASE_SERVICE_ROLE_KEY é mesmo a service_role (e não a anon).');
    } else {
      console.log('[excluir-conta] usuário removido do auth — uid:', uid,
                  'status HTTP:', rAuth.status,
                  'resp:', txtAuth || '(vazio)');
    }
  } catch (e) {
    avisoAuthNaoRemovido = true;
    console.error('[excluir-conta] erro de rede ao remover usuário do auth — uid:', uid, e,
                  '| Os DADOS já foram apagados.');
  }

  /* ── 6. Resposta final: sempre 200 se chegou até aqui (dados apagados) ── */
  console.log('[excluir-conta] concluído — uid:', uid,
              'tabelasComErro:', tabelasComErro.length ? tabelasComErro.join(', ') : '(nenhuma)',
              'avisoAuthNaoRemovido:', avisoAuthNaoRemovido);

  return json(200, {
    ok: true,
    tabelasComErro,
    avisoAuthNaoRemovido
  });
};
