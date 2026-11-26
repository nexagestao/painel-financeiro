// Edge Function: resumo-ia
// Recebe os números de um report do Nexa (já agregados no navegador) e pede ao
// Claude um resumo executivo em pt-BR. A chave fica no secret ANTHROPIC_API_KEY
// do projeto — nunca no front. Só usuários logados chegam aqui (verify_jwt).
import Anthropic from "npm:@anthropic-ai/sdk";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const TIPOS: Record<string, string> = {
  dia: "report diário de caixa (saldo nos bancos, o que vence hoje, borderô do dia, próximos 7 dias e alertas)",
  fluxo: "previsão de fluxo de caixa até o fim do mês seguinte (visão semanal, menor saldo, dias negativos e maiores saídas)",
  bordero: "situação dos borderôs de pagamento (pago, liberado, aguardando liberação)",
  mensal: "prestação de contas mensal para a diretoria (DRE do mês x mês anterior e acumulado, caixa previsto x realizado, maiores despesas e pendências)",
};

const SYSTEM = `Você é o analista financeiro da Nexa Gestão, que faz a gestão financeira de associações de proteção veicular.
Escreva em português do Brasil, para a diretoria do cliente: tom direto, profissional e sem jargão.
Use apenas os números do JSON recebido — não invente valores, datas, causas nem fornecedores. Se algo não estiver no JSON, não mencione.
Valores em reais no formato R$ 12.345 (sem centavos, a não ser abaixo de R$ 100). Datas no formato dd/mm.
Estrutura:
1. Um parágrafo curto (2 a 3 frases) com a leitura geral da situação.
2. "Pontos de atenção:" com 2 a 4 tópicos (linhas começando com "- "), do mais importante para o menos.
3. "Recomendação:" com 1 ou 2 frases práticas de ação.
No máximo 180 palavras. Sem títulos com #, sem tabelas, sem emojis.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ erro: "Método não permitido" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ erro: "A chave da IA ainda não foi configurada no Supabase (secret ANTHROPIC_API_KEY)." }, 500);

  let body: { tipo?: string; empresa?: string; dados?: unknown };
  try { body = await req.json(); } catch { return json({ erro: "JSON inválido" }, 400); }
  const tipo = body.tipo && TIPOS[body.tipo] ? body.tipo : null;
  if (!tipo || !body.dados) return json({ erro: "Informe tipo e dados do report" }, 400);
  const dados = JSON.stringify(body.dados);
  if (dados.length > 60000) return json({ erro: "Report grande demais para resumir" }, 413);

  const client = new Anthropic({ apiKey });
  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [{
        role: "user",
        content: `Empresa: ${body.empresa ?? "cliente"}\nTipo de report: ${TIPOS[tipo]}\nData de hoje: ${new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}\n\nDados do report (JSON):\n${dados}`,
      }],
    });
    if (response.stop_reason === "refusal") return json({ erro: "A IA não conseguiu gerar o resumo deste report." }, 422);
    const texto = response.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim();
    if (!texto) return json({ erro: "Resposta vazia da IA" }, 502);
    return json({ texto });
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) return json({ erro: "Chave da IA inválida — confira o secret ANTHROPIC_API_KEY." }, 500);
    if (error instanceof Anthropic.RateLimitError) return json({ erro: "Muitas solicitações — tente de novo em instantes." }, 429);
    if (error instanceof Anthropic.APIError) return json({ erro: `Erro da IA (${error.status})` }, 502);
    console.error(error);
    return json({ erro: "Falha ao gerar o resumo" }, 500);
  }
});
