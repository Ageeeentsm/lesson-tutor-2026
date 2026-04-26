// Vercel Serverless Function: proxies TTS requests to ElevenLabs.
// Requires ELEVENLABS_API_KEY in Vercel env vars.
export const config = { maxDuration: 60 };

const DEFAULT_VOICE_ID = 'CiGXiF6vr3ULNlgVfZ5z'; // Nigerian voice

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'ELEVENLABS_API_KEY is not configured in Vercel.' }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    );
  }

  let payload: any = {};
  try { payload = await req.json(); } catch {}
  const text = (payload?.text || '').toString().slice(0, 4000);
  if (!text) {
    return new Response(JSON.stringify({ error: 'Missing text' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
  }
  const voiceId = (payload?.voiceId || DEFAULT_VOICE_ID).toString();

  const upstream = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.4,
          use_speaker_boost: true,
        },
      }),
    }
  );

  if (!upstream.ok) {
    const errText = await upstream.text();
    return new Response(
      JSON.stringify({ error: 'ElevenLabs error', status: upstream.status, detail: errText }),
      { status: upstream.status, headers: { 'content-type': 'application/json' } }
    );
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'audio/mpeg',
      'cache-control': 'no-store',
    },
  });
}