import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config';

export type Role = 'manager' | 'ward' | 'requester';
export interface AuthUser { id: string; name: string; role: Role; wardId?: string }

declare global {
  namespace Express { interface Request { user?: AuthUser } }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const signToken = (u: AuthUser) => jwt.sign(u, config.jwtSecret, { expiresIn: '12h' });

export const requireAuth = (...roles: Role[]): RequestHandler => (req, _res, next) => {
  const token = req.headers.authorization?.replace(/^Bearer /, '');
  if (!token) throw new HttpError(401, 'Not signed in');
  try { req.user = jwt.verify(token, config.jwtSecret) as AuthUser; }
  catch { throw new HttpError(401, 'Session expired'); }
  if (roles.length && !roles.includes(req.user.role)) throw new HttpError(403, 'Not allowed for your role');
  next();
};
