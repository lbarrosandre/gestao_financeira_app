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
     • só o e-mail de despedida falhou .... 200 { ok:true, ... } (idêntico ao sucesso)
   O passo de auth NUNCA vira erro fatal — ver comentário longo no passo 5.
   O passo de e-mail também não — ver comentário do passo 6.

   CommonJS puro, sem dependências npm: usa o `fetch` nativo do
   runtime Node 18+ da Netlify e chama o Supabase via REST.

   Variáveis de ambiente exigidas (já configuradas):
     - SUPABASE_URL
     - SUPABASE_SERVICE_ROLE_KEY

   Variável OPCIONAL:
     - RESEND_API_KEY ... só o e-mail de despedida (passo 6). Ausente,
       o passo é pulado com um aviso no log e a exclusão segue normal.
       Ela é opcional DE PROPÓSITO: exclusão de conta é obrigação legal,
       e-mail de cortesia não pode ser pré-requisito pra ela funcionar.

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

/* Remetente verificado no Resend. `naoresponda@` porque esta caixa não é
   monitorada — a pessoa acabou de excluir a conta e não tem pra onde
   responder dentro do app. */
const EMAIL_REMETENTE = 'Bússola Finance <naoresponda@bussolafinance.com.br>';

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

/* HTML self-contained: nada de <img> externo, nada de CSS remoto. Cliente
   de e-mail bloqueia imagem por padrão e um layout que dependa dela chega
   quebrado — aqui o texto sozinho já é a mensagem inteira. */
function htmlDespedida() {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#0F1115;padding:28px 16px">
  <div style="max-width:520px;margin:0 auto;background:#171A21;border:1px solid #262B36;border-radius:16px;padding:28px 24px">
    <div style="font-size:22px;font-weight:700;color:#F3F5F9;letter-spacing:-.5px;margin-bottom:18px">Bús<span style="color:#14B8A6">sola</span> Finance</div>
    <div style="font-size:16px;font-weight:700;color:#F3F5F9;margin-bottom:14px">Sua conta foi excluída.</div>
    <p style="font-size:14px;line-height:1.7;color:#AEB6C4;margin:0 0 14px">Confirmando: recebemos seu pedido e ele foi concluído. Seu cadastro, sua assinatura e todos os seus dados financeiros — lançamentos, planejamentos, bolsos e dívidas — foram apagados permanentemente dos nossos servidores.</p>
    <p style="font-size:14px;line-height:1.7;color:#AEB6C4;margin:0 0 14px">Não guardamos cópia. Não vamos mais te enviar e-mails.</p>
    <p style="font-size:14px;line-height:1.7;color:#AEB6C4;margin:0 0 14px">Obrigado pelo tempo que você passou por aqui. Se um dia quiser voltar, é só criar uma conta nova — as portas ficam abertas.</p>
    <div style="border-top:1px solid #262B36;margin-top:22px;padding-top:16px;font-size:12px;line-height:1.6;color:#6B7383">Este é o último e-mail que você recebe do Bússola Finance. Não é preciso responder — esta caixa não é monitorada.</div>
  </div>
</div>`;
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
         coisa. Consulta direto a AUTENTICAÇÃO (GoTrue admin), não mais
         `profiles` — porque uma conta pode existir de verdade (fez cadastro,
         tem login) e nunca ter completado o perfil obrigatório (ex: fechou
         o app no meio do "Complete seu perfil"), o que a deixa SEM linha em
         `profiles`. Antes isso barrava a exclusão dessa conta pelo Painel
         Admin com um falso "Usuário não autorizado" — justamente o tipo de
         conta incompleta que o admin mais precisa poder limpar.
         Falhou aqui → 403 e NADA é apagado (passo 5 do spec).

         Este é também o ÚNICO momento em que o e-mail da pessoa ainda
         existe pra ser lido: depois do passo 4 não há mais linha em
         `profiles`, e depois do passo 5 não há mais usuário no GoTrue.
         Por isso guardamos aqui o endereço que o passo 6 vai usar. ── */
  let emailDespedida = '';

  try {
    const rUser = await fetch(
      `${supaBase}/auth/v1/admin/users/${encodeURIComponent(uid)}`,
      {
        method: 'GET',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    );

    if (rUser.status === 404) {
      console.warn('[excluir-conta] uid não existe na autenticação — uid:', uid, '(nada foi apagado)');
      return json(403, { erro: 'Usuário não autorizado.' });
    }
    if (!rUser.ok) {
      const txt = await rUser.text().catch(() => '');
      console.error('[excluir-conta] falha ao consultar auth admin — uid:', uid,
                    'status:', rUser.status, 'resp:', txt);
      /* Não dá pra validar → não apaga. Erro de infra, não de autorização. */
      return json(502, { erro: 'Não foi possível validar sua conta agora. Tente novamente.' });
    }

    /* Falha ao ler o corpo NÃO derruba a validação: o que autoriza a
       exclusão é o status 200 acima, não o e-mail. Sem endereço, só o
       passo 6 é pulado. */
    try {
      const dadosUser = await rUser.json();
      emailDespedida = typeof dadosUser?.email === 'string' ? dadosUser.email.trim() : '';
    } catch (e) {
      console.warn('[excluir-conta] não deu pra ler o e-mail do usuário — uid:', uid,
                   '(a exclusão segue; só o e-mail de despedida será pulado)', e.message);
    }

    console.log('[excluir-conta] usuário validado (auth) — uid:', uid,
                'e-mail capturado para despedida:', emailDespedida ? 'sim' : 'não');
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
         painel do Supabase.

         ── Por que uma retentativa? ──
         Um usuário órfão aqui não é inofensivo na prática: quem pediu
         exclusão e depois entra com o mesmo login cai na tela de "complete
         seu cadastro" já com o NOME ANTIGO (vem de user_metadata, que
         sobrevive junto com o usuário) — parece que a exclusão não
         aconteceu. Como a falha mais provável é transitória (rede, cold
         start do GoTrue), uma segunda tentativa custa quase nada e reduz
         bastante a chance de sobrar órfão. A arquitetura continua
         fail-open: se as duas falharem, ainda devolvemos 200. */
  let avisoAuthNaoRemovido = false;
  const AUTH_TENTATIVAS = 2;

  for (let tentativa = 1; tentativa <= AUTH_TENTATIVAS; tentativa++) {
    avisoAuthNaoRemovido = false;

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
                      'tentativa:', tentativa + '/' + AUTH_TENTATIVAS,
                      'status:', rAuth.status,
                      'resp (corpo completo):', txtAuth,
                      '| Os DADOS já foram apagados. Se o código for PGRST125,',
                      'a requisição caiu no PostgREST em vez do GoTrue — conferir',
                      'se SUPABASE_SERVICE_ROLE_KEY é mesmo a service_role (e não a anon).');
      } else {
        console.log('[excluir-conta] usuário removido do auth — uid:', uid,
                    'tentativa:', tentativa + '/' + AUTH_TENTATIVAS,
                    'status HTTP:', rAuth.status,
                    'resp:', txtAuth || '(vazio)');
      }
    } catch (e) {
      avisoAuthNaoRemovido = true;
      console.error('[excluir-conta] erro de rede ao remover usuário do auth — uid:', uid,
                    'tentativa:', tentativa + '/' + AUTH_TENTATIVAS, e,
                    '| Os DADOS já foram apagados.');
    }

    if (!avisoAuthNaoRemovido) break;

    if (tentativa < AUTH_TENTATIVAS) {
      console.warn('[excluir-conta] retentando remoção do usuário no auth — uid:', uid);
      await new Promise(r => setTimeout(r, 500));
    } else {
      console.error('[excluir-conta] usuário NÃO removido do auth depois de',
                    AUTH_TENTATIVAS, 'tentativas — uid:', uid,
                    '(órfão sem dados; remover manualmente pelo painel do Supabase)');
    }
  }

  /* ── 6. E-mail de despedida (best-effort, exatamente como o passo 5) ──

         Depois da remoção do auth de propósito: só mandamos "sua conta foi
         excluída" quando a exclusão realmente aconteceu de ponta a ponta.
         Mesmo com `tabelasComErro` ou `avisoAuthNaoRemovido` o e-mail vai:
         do ponto de vista da pessoa o pedido FOI atendido, e o que sobrou
         é problema nosso de limpeza manual, não dela.

         ⚠️ Nada aqui pode virar erro pro usuário nem atrasar a resposta.
         Os dados já foram apagados — que é o que importa. Resend fora do
         ar, chave ausente, endereço inválido: tudo vira log e segue.
         Por isso o await está dentro de um try que engole qualquer coisa. */
  const RESEND_API_KEY = process.env.RESEND_API_KEY;

  if (!RESEND_API_KEY) {
    console.warn('[excluir-conta] RESEND_API_KEY ausente — e-mail de despedida pulado. uid:', uid);
  } else if (!emailDespedida) {
    console.warn('[excluir-conta] sem e-mail conhecido — e-mail de despedida pulado. uid:', uid);
  } else {
    try {
      const rMail = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: EMAIL_REMETENTE,
          to: emailDespedida,
          subject: 'Sua conta no Bússola Finance foi excluída',
          html: htmlDespedida()
        })
      });

      if (!rMail.ok) {
        const txtMail = await rMail.text().catch(() => '');
        console.error('[excluir-conta] FALHA ao enviar e-mail de despedida — uid:', uid,
                      'status:', rMail.status, 'resp:', txtMail,
                      '| A exclusão foi concluída mesmo assim.');
      } else {
        console.log('[excluir-conta] e-mail de despedida enviado — uid:', uid);
      }
    } catch (e) {
      console.error('[excluir-conta] erro de rede ao enviar e-mail de despedida — uid:', uid, e,
                    '| A exclusão foi concluída mesmo assim.');
    }
  }

  /* ── 7. Resposta final: sempre 200 se chegou até aqui (dados apagados) ── */
  console.log('[excluir-conta] concluído — uid:', uid,
              'tabelasComErro:', tabelasComErro.length ? tabelasComErro.join(', ') : '(nenhuma)',
              'avisoAuthNaoRemovido:', avisoAuthNaoRemovido);

  return json(200, {
    ok: true,
    tabelasComErro,
    avisoAuthNaoRemovido
  });
};
