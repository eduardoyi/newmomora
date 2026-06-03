import { corsHeaders } from './cors.ts';

export interface ApiErrorBody {
  error: string;
  code?: string;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}

export function errorResponse(
  error: string,
  status: number,
  code?: string,
): Response {
  const body: ApiErrorBody = { error };
  if (code) {
    body.code = code;
  }

  return jsonResponse(body, status);
}
