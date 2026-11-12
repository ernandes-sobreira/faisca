// FAÍSCA · Worker Cloudflare (versão 5: acesso verificado)
// Guarda a chave da API e só atende quem prova quem é:
//  - aluno: entrou por uma aula que existe e está aberta
//  - professor: conta Google que consta na lista de professores autorizados
//  - tema livre: qualquer visitante, com limite diário baixo
//
// CONFIGURAÇÃO (uma vez só):
// 1. Settings > Variables and Secrets > Add > tipo "Secret"
//    Nome: ANTHROPIC_API_KEY   Valor: sua chave sk-ant-...
// 2. Storage & Databases > KV > Create namespace, nome "FAISCA_LIMITES".
//    Depois, no worker: Settings > Bindings > Add > KV Namespace,
//    Variable name: LIMITES, namespace: FAISCA_LIMITES.
//    Sem o KV o worker funciona, mas sem limite diário.

const PROJETO = "faisca-56bd5";                 // ID do projeto Firebase
const MODELO = "claude-sonnet-4-6";             // confira no console da Anthropic se este modelo segue ativo
const LIMITE_DIA = { aluno: 80, prof: 60, livre: 15 };  // mensagens por pessoa por dia
const LIMITE_GLOBAL_DIA = 3000;                 // teto do app inteiro por dia
const MAX_TOKENS_TETO = 1500;
const LIMITE_MATERIAL = 330000;                 // caracteres (plano de ensino + material da aula)
const LIMITE_MENSAGENS = 80;
const ORIGENS_PERMITIDAS = ["https://ernandes-sobreira.github.io"];

const CHAVES_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJETO}/databases/(default)/documents/`;
let chavesCache = { ate: 0, chaves: [] };
const permitidoCache = new Map();               // "aula:CODIGO" ou "prof:email" -> validade em ms

function cors(request) {
  const origem = request.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGENS_PERMITIDAS.includes(origem) ? origem : ORIGENS_PERMITIDAS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}
function resposta(request, obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors(request) } });
}
const erro = (request, mensagem, status) => resposta(request, { error: { message: mensagem } }, status);

function b64urlParaBytes(s) {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}
const b64urlParaJSON = s => JSON.parse(new TextDecoder().decode(b64urlParaBytes(s)));

// Confere a assinatura e os dados do token de login do Firebase. Devolve os dados ou null.
async function verificarToken(token, agora = Date.now()) {
  if (typeof token !== "string") return null;
  const partes = token.split(".");
  if (partes.length !== 3) return null;
  let cab, dados;
  try { cab = b64urlParaJSON(partes[0]); dados = b64urlParaJSON(partes[1]); } catch { return null; }
  if (cab.alg !== "RS256" || !cab.kid) return null;
  const seg = Math.floor(agora / 1000);
  if (dados.aud !== PROJETO || dados.iss !== "https://securetoken.google.com/" + PROJETO) return null;
  if (!dados.sub || typeof dados.exp !== "number" || dados.exp < seg || (dados.iat || 0) > seg + 300) return null;
  if (chavesCache.ate < agora || !chavesCache.chaves.some(k => k.kid === cab.kid)) {
    const r = await fetch(CHAVES_URL);
    if (!r.ok) return null;
    chavesCache = { ate: agora + 3600000, chaves: (await r.json()).keys || [] };
  }
  const jwk = chavesCache.chaves.find(k => k.kid === cab.kid);
  if (!jwk) return null;
  const chave = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", chave, b64urlParaBytes(partes[2]), new TextEncoder().encode(partes[0] + "." + partes[1]));
  return ok ? dados : null;
}

// Pergunta ao Firestore, com o token da própria pessoa, se o documento existe (as regras decidem quem pode ler).
async function documento(caminho, token) {
  const r = await fetch(FIRESTORE + caminho, { headers: { Authorization: "Bearer " + token } });
  return r.ok ? await r.json() : null;
}
async function autorizar(tipo, corpo, dados, token, agora) {
  const provedor = (dados.firebase || {}).sign_in_provider;
  if (tipo === "livre") return null;
  if (tipo === "prof") {
    if (provedor === "anonymous" || !dados.email || dados.email_verified !== true) return "Entre com sua conta Google.";
    const chave = "prof:" + dados.email;
    if ((permitidoCache.get(chave) || 0) > agora) return null;
    if (!(await documento("professores/" + encodeURIComponent(dados.email), token))) return "Sua conta não está na lista de professores autorizados.";
    permitidoCache.set(chave, agora + 300000);
    return null;
  }
  if (tipo === "aluno") {
    const codigo = typeof corpo.aula === "string" ? corpo.aula : "";
    if (!/^[A-Z0-9]{6}$/.test(codigo)) return "Aula inválida.";
    const chave = "aula:" + codigo;
    if ((permitidoCache.get(chave) || 0) > agora) return null;
    const doc = await documento("aulas/" + codigo, token);
    if (!doc) return "Aula não encontrada.";
    if (doc.fields && doc.fields.aberta && doc.fields.aberta.booleanValue === false) return "Esta aula foi encerrada pelo professor.";
    permitidoCache.set(chave, agora + 300000);
    return null;
  }
  return "Pedido inválido.";
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(request) });
    if (request.method !== "POST") return erro(request, "Use POST.", 405);
    if (!ORIGENS_PERMITIDAS.includes(request.headers.get("Origin") || "")) return erro(request, "Origem não autorizada.", 403);
    if (!env.ANTHROPIC_API_KEY) return erro(request, "Chave não configurada no servidor.", 500);

    let corpo;
    try { corpo = await request.json(); } catch { return erro(request, "Corpo inválido.", 400); }

    // ---- Quem está pedindo ----
    const agora = Date.now();
    const dados = await verificarToken(corpo.token, agora);
    if (!dados) return erro(request, "Sessão expirada. Recarregue a página.", 401);
    const tipo = ["aluno", "prof", "livre"].includes(corpo.tipo) ? corpo.tipo : "";
    const negado = await autorizar(tipo, corpo, dados, corpo.token, agora);
    if (negado) return erro(request, negado, 403);

    // ---- Limites diários, por pessoa verificada e do app inteiro ----
    if (env.LIMITES) {
      const hoje = new Date(agora).toISOString().slice(0, 10);
      const chavePessoa = `uso:${tipo}:${dados.sub}:${hoje}`;
      const chaveGlobal = `global:${hoje}`;
      const [a, g] = await Promise.all([env.LIMITES.get(chavePessoa), env.LIMITES.get(chaveGlobal)]);
      const nPessoa = parseInt(a || "0", 10), nGlobal = parseInt(g || "0", 10);
      if (nGlobal >= LIMITE_GLOBAL_DIA) return erro(request, "O Faísca atingiu o limite de uso de hoje. Volte amanhã.", 429);
      if (nPessoa >= LIMITE_DIA[tipo]) return erro(request, "Você atingiu o limite de mensagens de hoje.", 429);
      await Promise.all([
        env.LIMITES.put(chavePessoa, String(nPessoa + 1), { expirationTtl: 172800 }),
        env.LIMITES.put(chaveGlobal, String(nGlobal + 1), { expirationTtl: 172800 }),
      ]);
    }

    // ---- Monta a chamada. O servidor decide modelo e tetos. ----
    const mensagens = Array.isArray(corpo.messages) ? corpo.messages.slice(-LIMITE_MENSAGENS) : [];
    if (!mensagens.length) return erro(request, "Sem mensagens.", 400);
    const system = [];
    // A referência vai primeiro e marcada para cache: nas mensagens seguintes da mesma aula,
    // esse trecho é cobrado como leitura de cache, bem mais barata que entrada normal.
    if (typeof corpo.material === "string" && corpo.material.trim()) {
      system.push({
        type: "text",
        text: "REFERÊNCIA DA DISCIPLINA (fonte primária, páginas marcadas como [PÁGINA n]):\n\n" + corpo.material.slice(0, LIMITE_MATERIAL),
        cache_control: { type: "ephemeral" },
      });
    }
    if (typeof corpo.system === "string" && corpo.system.trim()) system.push({ type: "text", text: corpo.system.slice(0, 20000) });

    const pedido = parseInt(corpo.max_tokens, 10);
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODELO,
        max_tokens: Number.isFinite(pedido) ? Math.min(Math.max(pedido, 100), MAX_TOKENS_TETO) : 700,
        system,
        messages: mensagens,
      }),
    });
    return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json", ...cors(request) } });
  },
};
