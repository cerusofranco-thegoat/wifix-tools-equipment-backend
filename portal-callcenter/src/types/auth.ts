export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: 'AGENT' | 'SUPERVISOR';
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
}
