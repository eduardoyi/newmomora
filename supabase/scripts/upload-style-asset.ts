import { PutObjectCommand, S3Client } from 'npm:@aws-sdk/client-s3@3';

const objectKey = '_assets/styles/default.png';
const filePath = new URL('../../assets/styles/default.png', import.meta.url);
const bundledPath = new URL('../functions/_shared/assets/default-style.png', import.meta.url);

const endpoint = Deno.env.get('R2_ENDPOINT');
const accessKeyId = Deno.env.get('R2_ACCESS_KEY_ID');
const secretAccessKey = Deno.env.get('R2_SECRET_ACCESS_KEY');
const bucket = Deno.env.get('R2_BUCKET');

if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
  console.error('Missing R2 env vars. Run with --env-file=supabase/.env.local');
  Deno.exit(1);
}

const client = new S3Client({
  region: 'auto',
  endpoint,
  credentials: { accessKeyId, secretAccessKey },
});

const body = await Deno.readFile(filePath);
await Deno.writeFile(bundledPath, body);

await client.send(
  new PutObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    Body: body,
    ContentType: 'image/png',
  }),
);

console.log(`Uploaded ${filePath.pathname} → s3://${bucket}/${objectKey} (${body.byteLength} bytes)`);
console.log(`Synced bundled asset → ${bundledPath.pathname}`);
