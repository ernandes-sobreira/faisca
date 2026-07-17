// FAÍSCA · Worker Cloudflare
// Guarda sua chave da API e repassa as chamadas do app com limites de uso.
//
// CONFIGURAÇÃO (uma vez só):
// 1. Settings > Variables and Secrets > Add > tipo "Secret"
//    Nome: ANTHROPIC_API_KEY   Valor: sua chave sk-ant-...
// 2. (Recomendado) Storage & Databases > KV > Create namespace, nome "FAISCA_LIMITES".
//    Depois, no worker: Settings > Bindings > Add > KV Namespace,
//    Variable name: LIMITES, namespace: FAISCA_LIMITES.
//    Sem o KV o worker funciona, mas sem limite por aluno (fica só o seu limite de gasto no console).

const LIMITE_POR_ALUNO_DIA = 40;    // mensagens por IP por dia
const LIMITE_GLOBAL_DIA = 2000;     // teto de mensagens do app inteiro por dia
const MODELO = "claude-sonnet-4-6";
const MAX_TOKENS = 1200;

// Se quiser travar o acesso só ao seu site, coloque o domínio aqui.
// Ex.: "https://ernandes.github.io". Deixe "*" para liberar geral durante os testes.
const ORIGEM_PERMITIDA = "*";

const CORS = {
  "Access-Control-Allow-Origin": ORIGEM_PERMITIDA,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function resposta(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }
    if (request.method !== "POST") {
      return resposta({ error: { message: "Use POST." } }, 405);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return resposta({ error: { message: "Chave não configurada no servidor." } }, 500);
    }

    // ---- Limites de uso (se o KV estiver configurado) ----
    if (env.LIMITES) {
      const hoje = new Date().toISOString().slice(0, 10);
      const ip = request.headers.get("CF-Connecting-IP") || "desconhecido";
      const chaveAluno = `aluno:${ip}:${hoje}`;
      const chaveGlobal = `global:${hoje}`;

      const [usoAluno, usoGlobal] = await Promise.all([
        env.LIMITES.get(chaveAluno),
        env.LIMITES.get(chaveGlobal),
      ]);
      const nAluno = parseInt(usoAluno || "0", 10);
      const nGlobal = parseInt(usoGlobal || "0", 10);

      if (nGlobal >= LIMITE_GLOBAL_DIA) {
        return resposta({ error: { message: "O Faísca atingiu o limite de uso de hoje. Volte amanhã." } }, 429);
      }
      if (nAluno >= LIMITE_POR_ALUNO_DIA) {
        return resposta({ error: { message: "Você atingiu suas " + LIMITE_POR_ALUNO_DIA + " mensagens de hoje. Boa hora para escrever sua resposta com o que você já construiu. Amanhã tem mais." } }, 429);
      }

      // registra o uso (expira em 2 dias para não acumular lixo)
      await Promise.all([
        env.LIMITES.put(chaveAluno, String(nAluno + 1), { expirationTtl: 172800 }),
        env.LIMITES.put(chaveGlobal, String(nGlobal + 1), { expirationTtl: 172800 }),
      ]);
    }

    // ---- Repassa a chamada para a Anthropic ----
    let corpo;
    try {
      corpo = await request.json();
    } catch {
      return resposta({ error: { message: "Corpo inválido." } }, 400);
    }

    // O servidor decide modelo e teto de tokens; o app só manda mensagens e system.
    const payload = {
      model: MODELO,
      max_tokens: MAX_TOKENS,
      system: typeof corpo.system === "string" ? corpo.system.slice(0, 20000) : undefined,
      messages: Array.isArray(corpo.messages) ? corpo.messages : [],
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
      headers: { "Content-Type": "application/json", ...CORS },
    });
  },
};
