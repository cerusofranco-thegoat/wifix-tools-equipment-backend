import bcrypt from 'bcrypt';
import { ApiError } from '../../middleware/error-handler.js';
import { signAuthToken } from '../../auth/jwt.js';
import { authRepository } from './auth.repository.js';

export interface PublicUserDto {
  id: string;
  email: string;
  name: string;
  active: boolean;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface LoginResultDto {
  token: string;
  user: PublicUserDto;
}

function toPublicUser(user: {
  id: string;
  email: string;
  name: string;
  active: boolean;
}): PublicUserDto {
  return { id: user.id, email: user.email, name: user.name, active: user.active };
}

export const authService = {
  async login(input: LoginInput): Promise<LoginResultDto> {
    const user = await authRepository.findByEmail(input.email);
    if (!user || !user.active) {
      throw ApiError.unauthorized('Correo o contraseña inválidos.');
    }
    const ok = await bcrypt.compare(input.password, user.passwordHash);
    if (!ok) {
      throw ApiError.unauthorized('Correo o contraseña inválidos.');
    }
    const token = await signAuthToken({ sub: user.id, email: user.email, name: user.name });
    return { token, user: toPublicUser(user) };
  },

  async getById(id: string): Promise<PublicUserDto> {
    const user = await authRepository.findById(id);
    if (!user || !user.active) {
      throw ApiError.unauthorized('Usuario no encontrado o inactivo.');
    }
    return toPublicUser(user);
  },
};
