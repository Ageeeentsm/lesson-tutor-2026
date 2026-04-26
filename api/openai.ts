// Vercel Serverless Function: accepts an Anthropic-style request body
// (model, max_tokens, system, messages[]), translates to OpenAI Chat
// Completions, calls OpenAI, then translates the response BACK to
// Anthropic's shape. This way the rest of the app can stay unchanged
// and just point at /api/openai when /api/anthropic fails.
export const config = { maxDuration: 60 };

const OPENAI_TIMEOUT_MS = 50000;

function mapModel(claudeModel: string): string {
  if (!claudeModel) return 'gpt-4o-mini';
  const m = claudeModel.toLowerCase();
  if (m.includes('opus')) return 'gpt-4o';
  if (m.includes('sonnet')) return 'gpt-4o';
  if (m.includes('haiku')) return 'gpt-4o-mini';
  return 'gpt-4o-mini';
}

function flattenContent(content: any): any {
  // Anthropic allows string OR array of blocks. OpenAI wants string OR
  // array of {type:"text"|"image_url", ...}. Convert.
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  const out: any[] = [];
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'text') {
      out.push({ type: 'text', text: b.text || '' });
    } else if (b.type === 'image' && b.source?.type === 'base64') {
      out.push({
        type: 'image_url',
        image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
      });
    } else if (b.type === 'document') {
      // OpenAI vision can't take PDFs directly here — drop with a note.
      out.push({ type: 'text', text: '[document attached — text extraction not available on Server 2]' });
    } else if (b.type === 'image_url') {
      out.push(b);
    }
  }
  // If only one text block, return as plain string for compatibility.
  if (out.length === 1 && out[0].type === 'text') return out[0].text;
  return out;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'OPENAI_API_KEY is not configured in Vercel.', provider: 'openai' }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    );
  }

  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }

  const messages: any[] = [];
  if (body.system) messages.push({ role: 'system', content: String(body.system) });
  for (const m of (body.messages || [])) {
    messages.push({ role: m.role, content: flattenContent(m.content) });
  }

  const oaiBody: any = {
    model: mapModel(body.model),
    messages,
    max_tokens: Math.min(body.max_tokens || 1024, 4096),
  };
  if (typeof body.temperature === 'number') oaiBody.temperature = body.temperature;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  let upstream: Response;
  let raw = '';
  try {
    upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(oaiBody),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    raw = await upstream.text();
  } catch (err: any) {
    clearTimeout(timeoutId);
    const isAbort = err?.name === 'AbortError';
    return new Response(
      JSON.stringify({
        error: isAbort
          ? `OpenAI timed out after ${OPENAI_TIMEOUT_MS / 1000}s.`
          : `OpenAI request failed: ${err?.message || String(err)}`,
        provider: 'openai',
      }),
      { status: isAbort ? 504 : 502, headers: { 'content-type': 'application/json' } }
    );
  }
  if (!upstream.ok) {
    return new Response(
      JSON.stringify({ error: 'OpenAI upstream error', status: upstream.status, detail: raw, provider: 'openai' }),
      { status: upstream.status, headers: { 'content-type': 'application/json' } }
    );
  }

  let data: any = {};
  try { data = JSON.parse(raw); } catch {}
  const text = data?.choices?.[0]?.message?.content || '';

  // Translate to Anthropic shape so existing client code parses it unchanged.
  const anthropicShape = {
    id: data?.id || 'oai-' + Date.now(),
    type: 'message',
    role: 'assistant',
    model: oaiBody.model,
    content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text) }],
    stop_reason: data?.choices?.[0]?.finish_reason || 'end_turn',
    usage: {
      input_tokens: data?.usage?.prompt_tokens || 0,
      output_tokens: data?.usage?.completion_tokens || 0,
    },
    _provider: 'openai',
  };

  return new Response(JSON.stringify(anthropicShape), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}