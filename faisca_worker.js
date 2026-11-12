// FAÍSCA · Worker Cloudflare (versão 4: disciplina e aulas, limite por aluno, cache do plano e do material)
// Guarda sua chave da API e repassa as chamadas do app com limites de uso.
//
// CONFIGURAÇÃO (uma vez só):
// 1. Settings > Variables and Secrets > Add > tipo "Secret"
//    Nome: ANTHROPIC_API_KEY   Valor: sua chave sk-ant-...
// 2. Storage & Databases > KV > Create namespace, nome "FAISCA_LIMITES".
//    Depois, no worker: Settings > Bindings > Add > KV Namespace,
//    Variable name: LIMITES, namespace: FAISCA_LIMITES.
//    Sem o KV o worker funciona, mas sem limite por aluno.

const LIMITE_POR_ALUNO_DIA = 60;    // mensagens por aluno por dia (uma sessão usa de 10 a 20)
const LIMITE_GLOBAL_DIA = 3000;     // teto de mensagens do app inteiro por dia
const MODELO = "claude-sonnet-4-6"; // confira no console da Anthropic se este modelo segue ativo
const MAX_TOKENS_TETO = 1500;
const LIMITE_MATERIAL = 330000;     // caracteres (plano de ensino + material da aula)
const LIMITE_MENSAGENS = 80;

// Só o seu site pode chamar o worker. Para testar em outro endereço, acrescente-o à lista.
const ORIGENS_PERMITIDAS = ["https://ernandes-sobreira.github.io"];

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
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...cors(request) },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors(request) });
    }
    if (request.method !== "POST") {
      return resposta(request, { error: { message: "Use POST." } }, 405);
    }
    const origem = request.headers.get("Origin") || "";
    if (!ORIGENS_PERMITIDAS.includes(origem)) {
      return resposta(request, { error: { message: "Origem não autorizada." } }, 403);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return resposta(request, { error: { message: "Chave não configurada no servidor." } }, 500);
    }

    let corpo;
    try {
      corpo = await request.json();
    } catch {
      return resposta(request, { error: { message: "Corpo inválido." } }, 400);
    }

    // ---- Limites de uso: por aluno (não por IP, porque uma escola inteira sai pelo mesmo IP) ----
    if (env.LIMITES) {
      const hoje = new Date().toISOString().slice(0, 10);
      const ip = request.headers.get("CF-Connecting-IP") || "desconhecido";
      const aluno = typeof corpo.aluno === "string" && /^[\w:.-]{6,80}$/.test(corpo.aluno) ? corpo.aluno : "ip-" + ip;
      const chaveAluno = `aluno:${aluno}:${hoje}`;
      const chaveGlobal = `global:${hoje}`;

      const [usoAluno, usoGlobal] = await Promise.all([
        env.LIMITES.get(chaveAluno),
        env.LIMITES.get(chaveGlobal),
      ]);
      const nAluno = parseInt(usoAluno || "0", 10);
      const nGlobal = parseInt(usoGlobal || "0", 10);

      if (nGlobal >= LIMITE_GLOBAL_DIA) {
        return resposta(request, { error: { message: "O Faísca atingiu o limite de uso de hoje. Volte amanhã." } }, 429);
      }
      if (nAluno >= LIMITE_POR_ALUNO_DIA) {
        return resposta(request, { error: { message: "Você atingiu o limite de mensagens de hoje. Feche a sessão com o que você já construiu." } }, 429);
      }

      await Promise.all([
        env.LIMITES.put(chaveAluno, String(nAluno + 1), { expirationTtl: 172800 }),
        env.LIMITES.put(chaveGlobal, String(nGlobal + 1), { expirationTtl: 172800 }),
      ]);
    }

    // ---- Monta a chamada. O servidor decide modelo e tetos; o app manda system, material e mensagens. ----
    const mensagens = Array.isArray(corpo.messages) ? corpo.messages.slice(-LIMITE_MENSAGENS) : [];
    if (!mensagens.length) {
      return resposta(request, { error: { message: "Sem mensagens." } }, 400);
    }
    const system = [];
    // O material vai primeiro e marcado para cache: nas mensagens seguintes da mesma tarefa,
    // esse trecho é cobrado como leitura de cache, bem mais barata que entrada normal.
    if (typeof corpo.material === "string" && corpo.material.trim()) {
      system.push({
        type: "text",
        text: "REFERÊNCIA DA DISCIPLINA (fonte primária, páginas marcadas como [PÁGINA n]):\n\n" + corpo.material.slice(0, LIMITE_MATERIAL),
        cache_control: { type: "ephemeral" },
      });
    }
    if (typeof corpo.system === "string" && corpo.system.trim()) {
      system.push({ type: "text", text: corpo.system.slice(0, 20000) });
    }

    const pedido = parseInt(corpo.max_tokens, 10);
    const payload = {
      model: MODELO,
      max_tokens: Number.isFinite(pedido) ? Math.min(Math.max(pedido, 100), MAX_TOKENS_TETO) : 700,
      system,
      messages: mensagens,
    };

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });

    const data = await r.text();
    return new Response(data, {
      status: r.status,
      headers: { "Content-Type": "application/json", ...cors(request) },
    });
  },
};
