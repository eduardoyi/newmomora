export function validateCronSecret(req: Request): boolean {
  const cronSecret = Deno.env.get('CRON_SECRET');

  if (!cronSecret) {
    return false;
  }

  const header = req.headers.get('x-cron-secret');
  return header === cronSecret;
}
