import type { MediaFile } from '@prisma/client';

export interface MediaFileDto {
  id: string;
  url: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

export function toMediaFileDto(m: MediaFile): MediaFileDto {
  return {
    id: m.id,
    url: m.url,
    contentType: m.contentType,
    sizeBytes: m.sizeBytes,
    createdAt: m.createdAt.toISOString(),
  };
}
