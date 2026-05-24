import { describe, it, expect } from 'vitest';
import {
  paginationSchema,
  toPageInfo,
  toSkipTake,
  toPagedResponse,
} from '../../src/lib/pagination.js';

describe('paginationSchema', () => {
  it('aplica defaults page=1 y pageSize=20', () => {
    const parsed = paginationSchema.parse({});
    expect(parsed).toEqual({ page: 1, pageSize: 20 });
  });

  it('coerce strings de query a enteros', () => {
    const parsed = paginationSchema.parse({ page: '3', pageSize: '50' });
    expect(parsed).toEqual({ page: 3, pageSize: 50 });
  });

  it('rechaza page < 1', () => {
    expect(() => paginationSchema.parse({ page: 0 })).toThrow();
  });

  it('rechaza pageSize > 100', () => {
    expect(() => paginationSchema.parse({ pageSize: 101 })).toThrow();
  });

  it('rechaza pageSize < 1', () => {
    expect(() => paginationSchema.parse({ pageSize: 0 })).toThrow();
  });
});

describe('toSkipTake', () => {
  it('calcula skip = (page-1)*pageSize', () => {
    expect(toSkipTake({ page: 1, pageSize: 20 })).toEqual({ skip: 0, take: 20 });
    expect(toSkipTake({ page: 3, pageSize: 20 })).toEqual({ skip: 40, take: 20 });
    expect(toSkipTake({ page: 5, pageSize: 50 })).toEqual({ skip: 200, take: 50 });
  });
});

describe('toPageInfo', () => {
  it('redondea hacia arriba el total de páginas', () => {
    expect(toPageInfo({ page: 1, pageSize: 20 }, 137)).toEqual({
      page: 1,
      pageSize: 20,
      totalItems: 137,
      totalPages: 7,
    });
  });

  it('totalPages = 0 cuando no hay items', () => {
    expect(toPageInfo({ page: 1, pageSize: 20 }, 0)).toEqual({
      page: 1,
      pageSize: 20,
      totalItems: 0,
      totalPages: 0,
    });
  });
});

describe('toPagedResponse', () => {
  it('combina page info y data', () => {
    const result = toPagedResponse({ page: 2, pageSize: 10 }, 25, [{ id: 'a' }]);
    expect(result.page.totalPages).toBe(3);
    expect(result.data).toEqual([{ id: 'a' }]);
  });
});
