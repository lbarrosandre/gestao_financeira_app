/* ═══════════════════════════════════════════════════════════════════
   Bússola Finance — enviar-reengajamento
   ───────────────────────────────────────────────────────────────────
   Dispara um e-mail de "sentimos sua falta" para uma lista de usuários
   escolhida pelo admin no Painel Admin.

   ── Quem decide quem recebe? O ADMIN, não esta function ──
   A lista chega PRONTA do client, em `destinatarios`. Esta function não
   consulta `profiles` procurando inativo, não aplica regra de corte, não
   descobre ninguém sozinha. Isso é de propósito: envio de e-mail em massa
   é ação irreversível (não dá pra "desenviar"), então o único caminho até
   aqui passa por uma pessoa que olhou a lista e confirmou no diálogo.
   Uma function que montasse a própria lista viraria, com uma chamada
   errada, uma campanha pra base inteira sem ninguém ter revisado nada.

   O papel daqui é: (1) provar que quem pediu é admin, (2) recusar lista
   absurda, (3) entregar, (4) contar quem falhou.

   ── O portão de admin ──
   Mesmo padrão de `admin-relatorio.js`: consulta `profiles.is_admin` do
   `uidAdmin` com a SERVICE ROLE (a RLS não deixaria ninguém ler a flag de
   outra pessoa, e aqui essa leitura É a autorização). Sem linha, flag
   diferente de `true`, ou erro → 403 e NENHUM e-mail sai. Flag do client
   não vale nada: quem forçar `window._souAdmin = true` no console chega
   até esta chamada e leva 403.

   ── Envio sequencial, tolerante a falha por item ──
   Um `for` com await, não `Promise.all`. Dois motivos:
     • O Resend tem limite de taxa. Disparar 200 requisições em paralelo é
       o jeito mais rápido de tomar 429 em quase todas elas.
     • Falha em um destinatário (endereço morto, bounce duro) não pode
       cancelar os outros — mesmo racional do loop de tabelas em
       `excluir-conta.js`: seguimos e coletamos os que falharam.
   Entre um envio e outro há uma pausa curta (DELAY_MS) só pra ficar
   confortavelmente abaixo do limite de taxa do plano free.

   ── Comportamento esperado (para validação por leitura de código) ──
     • método != POST ..................... 405
     • env var faltando ................... 500
     • corpo não-JSON / uidAdmin vazio .... 400
     • destinatarios vazio ou > 500 ....... 400, nada enviado
     • uidAdmin sem perfil / não admin .... 403, nada enviado
     • falha ao checar is_admin ........... 502, nada enviado
     • tudo certo ......................... 200 { ok:true, enviados:N, falharam:[] }
     • alguns falharam .................... 200 { ok:true, enviados:N, falharam:['a@b.c'] }
   Repare que "alguns falharam" ainda é 200: os outros N saíram de verdade,
   e um 500 aqui faria o admin achar que pode reenviar tudo — duplicando
   e-mail pra quem já recebeu.

   CommonJS puro, sem dependências npm: usa o `fetch` nativo do
   runtime Node 18+ da Netlify e chama Supabase e Resend via REST.

   Variáveis de ambiente exigidas (já configuradas):
     - SUPABASE_URL
     - SUPABASE_SERVICE_ROLE_KEY
     - RESEND_API_KEY

   NENHUM desses valores pode ser exposto no client — eles só existem aqui.
   ═══════════════════════════════════════════════════════════════════ */

/* Mesmo racional de `admin-relatorio.js`: o schema usa `uid TEXT` (NÃO
   uuid), então não exigimos formato uuid — só uma string "razoável". A
   validação de verdade é a consulta a `profiles` no passo 5. */
const RE_UID = /^[A-Za-z0-9._:@-]{8,128}$/;

/* Não é validação de RFC (que é praticamente impossível por regex) — é só
   uma peneira pra não gastar uma requisição ao Resend com string vazia ou
   obviamente quebrada. Quem passar daqui e ainda assim for inválido cai
   em `falharam`, que é o lugar certo. */
const RE_EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

/* Teto de destinatários por chamada. Não é limite técnico do Resend: é
   trava contra o erro grosseiro de mandar pra base inteira sem querer.
   500 e-mails a ~350ms cada já são ~3min, perto do teto de tempo de uma
   Netlify Function — subir esse número exige repensar o envio (fila,
   background function), não só trocar a constante. */
const MAX_DESTINATARIOS = 500;

/* Pausa entre envios. Mantém a cadência bem abaixo do limite de taxa do
   plano free do Resend, sem transformar o envio numa eternidade. */
const DELAY_MS = 350;

/* Remetente verificado no Resend. `naoresponda@` porque esta caixa não é
   monitorada — o convite é pra pessoa voltar ao app, não pra responder. */
const EMAIL_REMETENTE = 'Bússola Finance <naoresponda@bussolafinance.com.br>';

const ASSUNTO = 'Sentimos sua falta por aqui 👋';

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

/* Escapa o que vai pro corpo HTML do e-mail. O nome vem do banco, mas foi
   digitado pelo próprio usuário lá no cadastro — colar isso cru no HTML
   deixaria alguém injetar markup no e-mail que OUTRA pessoa (o admin, ao
   testar) abre. Mesmo racional do escHtml() do client. */
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

/* Primeiro nome só: "Oi Ana," soa como gente, "Oi Ana Cláudia Ferreira
   dos Santos," soa como cobrança de banco. */
function primeiroNome(nome) {
  const limpo = String(nome || '').trim();
  if (!limpo) return '';
  return limpo.split(/\s+/)[0];
}

/* HTML self-contained: nada de <img> externo, nada de CSS remoto. Cliente
   de e-mail bloqueia imagem por padrão e um layout que dependa dela chega
   quebrado — aqui o texto sozinho já é a mensagem inteira.

   Sobre o TOM: é reengajamento, não campanha de venda. Nada de preço,
   plano, desconto ou prazo. E nenhuma cobrança pelo sumiço — a pessoa não
   deve satisfação a um app de finanças sobre por que passou dois meses
   fora, e insinuar o contrário é o jeito mais rápido de virar spam. */
function htmlReengajamento(nome) {
  const saudacao = nome ? `Oi ${escHtml(nome)},` : 'Oi!';

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#0F1115;padding:28px 16px">
  <div style="max-width:520px;margin:0 auto;background:#171A21;border:1px solid #262B36;border-radius:16px;padding:28px 24px">
    <div style="font-size:22px;font-weight:700;color:#F3F5F9;letter-spacing:-.5px;margin-bottom:18px">Bús<span style="color:#14B8A6">sola</span> Finance</div>
    <div style="font-size:16px;font-weight:700;color:#F3F5F9;margin-bottom:14px">${saudacao}</div>
    <p style="font-size:14px;line-height:1.7;color:#AEB6C4;margin:0 0 14px">Faz um tempo que a gente não te vê no Bússola. Sem cobrança nenhuma — a vida acontece e nem sempre dá pra acompanhar tudo.</p>
    <p style="font-size:14px;line-height:1.7;color:#AEB6C4;margin:0 0 14px">Só queríamos lembrar que sua conta continua lá, com seus dados do jeito que você deixou. Anotar o que entra e o que sai leva poucos minutos por semana, e é o que transforma "acho que dá" em "sei que dá".</p>
    <p style="font-size:14px;line-height:1.7;color:#AEB6C4;margin:0 0 22px">Dinheiro não é sobre números. É sobre dormir tranquilo sabendo que está tudo sob controle.</p>
    <div style="text-align:center;margin:0 0 8px">
      <a href="https://bussolafinance.com.br" style="display:inline-block;background:#14B8A6;color:#0F1115;font-size:14px;font-weight:700;text-decoration:none;padding:13px 26px;border-radius:10px">Voltar pro Bússola</a>
    </div>
    <div style="border-top:1px solid #262B36;margin-top:22px;padding-top:16px;font-size:12px;line-height:1.6;color:#6B7383">Você recebeu este e-mail porque tem uma conta no Bússola Finance. Não é preciso responder — esta caixa não é monitorada. Se preferir não receber mais nada, é só excluir a conta pelo menu do app.</div>
  </div>
</div>`;
}

exports.handler = async (event) => {
  /* ── 1. Só POST ── */
  if (event.httpMethod !== 'POST') {
    console.warn('[enviar-reengajamento] método rejeitado:', event.httpMethod);
    return json(405, { erro: 'Método não permitido.' });
  }

  /* ── 2. Config obrigatória ──
         RESEND_API_KEY entra aqui como OBRIGATÓRIA (diferente de
         `excluir-conta.js`, onde é opcional): lá o e-mail é cortesia em
         cima de uma exclusão que precisa acontecer de qualquer jeito;
         aqui o e-mail É a função inteira. Sem chave não há o que fazer,
         e devolver "ok, 0 enviados" seria mentir pro admin. */
  const SUPABASE_URL              = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const RESEND_API_KEY            = process.env.RESEND_API_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !RESEND_API_KEY) {
    console.error('[enviar-reengajamento] variáveis de ambiente ausentes:', {
      SUPABASE_URL: !!SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!SUPABASE_SERVICE_ROLE_KEY,
      RESEND_API_KEY: !!RESEND_API_KEY
    });
    return json(500, { erro: 'Serviço indisponível no momento.' });
  }

  const supaBase = String(SUPABASE_URL).replace(/\/+$/, '');

  /* ── 3. Corpo JSON: { uidAdmin, destinatarios } ── */
  let payload;
  try {
    const raw = event.isBase64Encoded && event.body
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : (event.body || '');
    payload = JSON.parse(raw);
  } catch (e) {
    console.error('[enviar-reengajamento] body inválido (JSON):', e.message);
    return json(400, { erro: 'Requisição inválida.' });
  }

  const uidAdmin = typeof payload?.uidAdmin === 'string' ? payload.uidAdmin.trim() : '';

  if (!uidAdmin)              return json(400, { erro: 'uidAdmin é obrigatório.' });
  if (!RE_UID.test(uidAdmin)) {
    console.warn('[enviar-reengajamento] uidAdmin com formato inválido — tamanho:', uidAdmin.length);
    return json(400, { erro: 'uidAdmin inválido.' });
  }

  /* ── 4. Trava da lista — ANTES do portão de admin ──
         Validar o tamanho primeiro é de graça e evita uma consulta ao
         banco pra uma requisição que ia ser recusada de qualquer jeito. */
  const destinatarios = Array.isArray(payload?.destinatarios) ? payload.destinatarios : [];

  if (destinatarios.length === 0) {
    console.warn('[enviar-reengajamento] lista vazia — uidAdmin:', uidAdmin);
    return json(400, { erro: 'Nenhum destinatário informado.' });
  }
  if (destinatarios.length > MAX_DESTINATARIOS) {
    console.warn('[enviar-reengajamento] lista grande demais:', destinatarios.length,
                 '— máximo:', MAX_DESTINATARIOS, '— uidAdmin:', uidAdmin, '(nada enviado)');
    return json(400, { erro: `Máximo de ${MAX_DESTINATARIOS} destinatários por envio.` });
  }

  /* ── 5. PORTÃO DE ADMIN ──
         Cópia fiel do passo 4 de `admin-relatorio.js`. Consulta com a
         service role DE PROPÓSITO: a RLS de `profiles` não deixaria
         ninguém ler a flag de outra pessoa, e aqui a leitura É a própria
         checagem de autorização. Sem linha, `is_admin` falso/ausente, ou
         erro → ninguém envia nada. A resposta ao client é sempre a mesma
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
      console.warn('[enviar-reengajamento] ACESSO NEGADO — uid sem perfil:', uidAdmin);
      return json(403, { erro: 'Acesso restrito ao administrador.' });
    }
    if (linhas[0]?.is_admin !== true) {
      console.warn('[enviar-reengajamento] ACESSO NEGADO — uid não é admin:', uidAdmin);
      return json(403, { erro: 'Acesso restrito ao administrador.' });
    }

    console.log('[enviar-reengajamento] acesso liberado para admin — uid:', uidAdmin,
                '— destinatários recebidos:', destinatarios.length);
  } catch (e) {
    console.error('[enviar-reengajamento] erro ao checar is_admin — uid:', uidAdmin, e);
    /* Não deu pra confirmar que é admin → não envia nada.
       502 (e não 403) porque é falha de infra, não de autorização. */
    return json(502, { erro: 'Não foi possível validar seu acesso agora. Tente novamente.' });
  }

  /* ── 6. Envio, um a um ──
         Endereço repetido é descartado: o client filtra, mas duas linhas
         com o mesmo e-mail no relatório (contas diferentes, mesma caixa)
         fariam a pessoa receber a mensagem duas vezes. */
  const enviadosPara = new Set();
  const falharam = [];
  let enviados = 0;

  for (let i = 0; i < destinatarios.length; i++) {
    const d     = destinatarios[i] || {};
    const email = typeof d.email === 'string' ? d.email.trim() : '';
    const nome  = primeiroNome(d.nome);

    if (!RE_EMAIL.test(email)) {
      console.warn('[enviar-reengajamento] destinatário sem e-mail utilizável — índice:', i,
                   'uid:', d.uid || '(sem uid)');
      falharam.push(email || `(sem e-mail: ${d.uid || 'desconhecido'})`);
      continue;
    }
    if (enviadosPara.has(email.toLowerCase())) {
      console.warn('[enviar-reengajamento] e-mail repetido na lista, pulando:', email);
      continue;
    }

    try {
      const rMail = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: EMAIL_REMETENTE,
          to: email,
          subject: ASSUNTO,
          html: htmlReengajamento(nome)
        })
      });

      if (!rMail.ok) {
        const txt = await rMail.text().catch(() => '');
        console.error('[enviar-reengajamento] FALHA no envio —', email,
                      'status:', rMail.status, 'resp:', txt);
        falharam.push(email);
      } else {
        enviados++;
        enviadosPara.add(email.toLowerCase());
        console.log('[enviar-reengajamento] enviado —', email,
                    `(${enviados}/${destinatarios.length})`);
      }
    } catch (e) {
      console.error('[enviar-reengajamento] erro de rede no envio —', email, e);
      falharam.push(email);
    }

    /* Nada de pausa depois do último: só atrasaria a resposta. */
    if (i < destinatarios.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  console.log('[enviar-reengajamento] concluído — admin:', uidAdmin,
              'enviados:', enviados,
              'falharam:', falharam.length ? falharam.join(', ') : '(nenhum)');

  return json(200, { ok: true, enviados, falharam });
};
