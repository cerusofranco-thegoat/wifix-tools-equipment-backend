import bcrypt from 'bcrypt';
import { ApiError } from '../../middleware/error-handler.js';
import { signAuthToken, type UserRole } from '../../auth/jwt.js';
import { authRepository } from './auth.repository.js';

export interface PublicUserDto {
  id: string;
  email: string;
  name: string;
  role: UserRole;
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

/**
 * El campo `role` se añade al modelo User en la migración `add_assistance_module`.
 * Hasta que se aplique la migración y se regenere el cliente Prisma, el tipo
 * devuelto por `findUnique` no incluirá `role`. El cast defensivo a `unknown`
 * garantiza que el código compila y, en tiempo de ejecución, lee el valor
 * real de la DB (que tiene el DEFAULT 'TECHNICIAN').
 */
type UserFromDb = Awaited<ReturnType<typeof authRepository.findByEmail>>;

function getRoleFromUser(user: NonNullable<UserFromDb>): UserRole {
  const raw = (user as unknown as Record<string, unknown>).role;
  if (raw === 'AGENT' || raw === 'SUPERVISOR') return raw;
  return 'TECHNICIAN';
}

function toPublicUser(user: NonNullable<UserFromDb>): PublicUserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: getRoleFromUser(user),
    active: user.active,
  };
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
    const role = getRoleFromUser(user);
    const token = await signAuthToken({ sub: user.id, email: user.email, name: user.name, role });
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
