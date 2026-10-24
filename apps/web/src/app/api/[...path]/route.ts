import { type NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  return proxyRequest(req, path);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  return proxyRequest(req, path);
}

async function proxyRequest(req: NextRequest, pathParts: string[]) {
  const gatewayUrl = process.env['API_GATEWAY_URL'] || 'http://localhost:4000';
  const subPath = pathParts.join('/');
  const search = req.nextUrl.search;
  const targetUrl = `${gatewayUrl}/api/${subPath}${search}`;

  const headers = new Headers(req.headers);
  headers.delete('host');

  const body = req.method !== 'GET' && req.method !== 'HEAD' ? await req.text() : undefined;

  try {
    const res = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
      cache: 'no-store',
    });

    const data = await res.text();
    return new NextResponse(data, {
      status: res.status,
      headers: {
        'content-type': res.headers.get('content-type') || 'application/json',
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Gateway communication failure';
    return NextResponse.json(
      {
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: `API Gateway unreachable at ${gatewayUrl}: ${message}`,
        },
      },
      { status: 502 },
    );
  }
}
