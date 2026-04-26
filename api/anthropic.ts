// Vercel Serverless Function: proxies requests to Anthropic using the
// ANTHROPIC_API_KEY environment variable configured in Vercel.
// Runs on Node.js (not Edge) so we can use a longer maxDuration.
// Edge functions must start responding within ~25s, which Anthropic
// frequently exceeds — that's the source of the 504 you were seeing.
export const config = { maxDuration: 60 };

const ANTHROPIC_TIMEOUT_MS = 50000;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'ANTHROPIC_API_KEY is not configured in Vercel.', provider: 'anthropic' }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    );
  }

  const body = await req.text();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS);

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'application/json',
      },
    });
  } catch (err: any) {
    clearTimeout(timeoutId);
    const isAbort = err?.name === 'AbortError';
    return new Response(
      JSON.stringify({
        error: isAbort
          ? `Anthropic timed out after ${ANTHROPIC_TIMEOUT_MS / 1000}s.`
          : `Anthropic request failed: ${err?.message || String(err)}`,
        provider: 'anthropic',
      }),
      { status: isAbort ? 504 : 502, headers: { 'content-type': 'application/json' } }
    );
  }
}