import { apiPost } from './client';
import type { LoginResponse } from '../../types/auth';

export function login(email: string, password: string): Promise<LoginResponse> {
  return apiPost<LoginResponse>('/herramientas/v1/auth/login', { email, password });
}
