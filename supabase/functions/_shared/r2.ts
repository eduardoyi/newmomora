import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from 'npm:@aws-sdk/client-s3@3';
import { getSignedUrl } from 'npm:@aws-sdk/s3-request-presigner@3';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucket: string;
}

const DEFAULT_UPLOAD_EXPIRES_IN = 900;
const DEFAULT_DOWNLOAD_EXPIRES_IN = 3600;

export function getR2Config(): R2Config {
  const accountId = Deno.env.get('R2_ACCOUNT_ID');
  const accessKeyId = Deno.env.get('R2_ACCESS_KEY_ID');
  const secretAccessKey = Deno.env.get('R2_SECRET_ACCESS_KEY');
  const endpoint = Deno.env.get('R2_ENDPOINT');
  const bucket = Deno.env.get('R2_BUCKET');

  if (!accountId || !accessKeyId || !secretAccessKey || !endpoint || !bucket) {
    throw new Error('Missing R2 environment variables');
  }

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    endpoint,
    bucket,
  };
}

export function createR2Client(config: R2Config): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

export async function createPresignedPutUrl(
  objectKey: string,
  contentType: string,
  expiresIn = DEFAULT_UPLOAD_EXPIRES_IN,
): Promise<string> {
  const config = getR2Config();
  const client = createR2Client(config);

  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: objectKey,
    ContentType: contentType,
  });

  return getSignedUrl(client, command, { expiresIn });
}

export async function createPresignedGetUrls(
  objectKeys: string[],
  expiresIn = DEFAULT_DOWNLOAD_EXPIRES_IN,
): Promise<Record<string, string>> {
  const config = getR2Config();
  const client = createR2Client(config);
  const urls: Record<string, string> = {};

  for (const objectKey of objectKeys) {
    const command = new GetObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
    });

    urls[objectKey] = await getSignedUrl(client, command, { expiresIn });
  }

  return urls;
}

export const R2_URL_EXPIRY = {
  upload: DEFAULT_UPLOAD_EXPIRES_IN,
  download: DEFAULT_DOWNLOAD_EXPIRES_IN,
} as const;

export async function getObjectBytes(objectKey: string): Promise<Uint8Array> {
  const urls = await createPresignedGetUrls([objectKey], 300);
  const url = urls[objectKey];

  if (!url) {
    throw new Error('Failed to create presigned download URL');
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`R2 fetch failed with status ${response.status}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

export async function readObjectBodyToBytes(body: unknown): Promise<Uint8Array> {
  if (typeof body === 'object' && body !== null && 'transformToWebStream' in body) {
    const webStream = (body as { transformToWebStream: () => ReadableStream<Uint8Array> })
      .transformToWebStream();
    const reader = webStream.getReader();
    const chunks: Uint8Array[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (value) {
        chunks.push(value);
      }
    }

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;

    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    return merged;
  }

  if (typeof body === 'object' && body !== null && 'transformToByteArray' in body) {
    return await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
  }

  throw new Error('Unsupported object body stream');
}

export async function putObjectBytes(
  objectKey: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  const config = getR2Config();
  const client = createR2Client(config);

  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export async function deleteObject(objectKey: string): Promise<void> {
  const config = getR2Config();
  const client = createR2Client(config);

  await client.send(
    new DeleteObjectCommand({
      Bucket: config.bucket,
      Key: objectKey,
    }),
  );
}

export async function listObjectKeys(prefix: string): Promise<string[]> {
  const config = getR2Config();
  const client = createR2Client(config);
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    for (const item of response.Contents ?? []) {
      if (item.Key) {
        keys.push(item.Key);
      }
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return keys;
}
