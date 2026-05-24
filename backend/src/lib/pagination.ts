import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type PaginationParams = z.infer<typeof paginationSchema>;

export interface PageInfo {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface PagedResponse<T> {
  page: PageInfo;
  data: T[];
}

export function toSkipTake(params: PaginationParams): { skip: number; take: number } {
  return { skip: (params.page - 1) * params.pageSize, take: params.pageSize };
}

export function toPageInfo(params: PaginationParams, totalItems: number): PageInfo {
  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / params.pageSize);
  return {
    page: params.page,
    pageSize: params.pageSize,
    totalItems,
    totalPages,
  };
}

export function toPagedResponse<T>(
  params: PaginationParams,
  totalItems: number,
  data: T[],
): PagedResponse<T> {
  return { page: toPageInfo(params, totalItems), data };
}
