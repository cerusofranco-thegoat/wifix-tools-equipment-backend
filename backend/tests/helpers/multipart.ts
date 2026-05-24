import { Buffer } from 'node:buffer';

export interface MultipartFile {
  name: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface MultipartPayload {
  body: Buffer;
  contentType: string;
}

export function buildMultipart(file: MultipartFile): MultipartPayload {
  const boundary = `----wifixtests${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n` +
      `Content-Type: ${file.contentType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    body: Buffer.concat([head, file.data, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
