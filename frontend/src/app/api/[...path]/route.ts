import { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const HOP_BY_HOP = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

function backendOrigin() {
  return (
    process.env.API_URL ||
    process.env.BACKEND_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    'http://localhost:3001'
  ).replace(/\/$/, '');
}

function filterHeaders(source: Headers) {
  const out = new Headers();
  source.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out.set(key, value);
  });
  return out;
}

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const url = `${backendOrigin()}/api/${path.join('/')}${req.nextUrl.search}`;

  const headers = filterHeaders(req.headers);
  const init: RequestInit = {
    method: req.method,
    headers,
    cache: 'no-store',
    redirect: 'manual',
  };

  // Buffer the inbound body. Piping req.body with duplex:'half' aborts the
  // backend SSE response ("BodyStreamBuffer was aborted") once the POST ends.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const buf = await req.arrayBuffer();
    if (buf.byteLength > 0) init.body = buf;
  }

  let backendRes: Response;
  try {
    backendRes = await fetch(url, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Backend unavailable';
    return Response.json({ error: message }, { status: 502 });
  }

  const outHeaders = filterHeaders(backendRes.headers);
  outHeaders.set('Cache-Control', 'no-cache, no-transform');
  outHeaders.set('X-Accel-Buffering', 'no');
  if ((backendRes.headers.get('content-type') || '').includes('text/event-stream')) {
    outHeaders.set('Content-Type', 'text/event-stream; charset=utf-8');
    outHeaders.set('Connection', 'keep-alive');
    outHeaders.delete('content-encoding');
    outHeaders.delete('content-length');
  }

  return new Response(backendRes.body, {
    status: backendRes.status,
    statusText: backendRes.statusText,
    headers: outHeaders,
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
