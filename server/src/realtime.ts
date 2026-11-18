import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';

export type Topic = 'beds' | 'suggestions' | 'questions' | 'requests' | 'feed';
let io: Server | null = null;

export function initRealtime(http: HttpServer, origin: string) {
  io = new Server(http, { cors: { origin } });
}
// Sockets only say WHAT changed. Clients refetch through the authenticated REST API,
// so no patient data ever travels over the socket.
export const emit = (...topics: Topic[]) => topics.forEach((t) => io?.emit('changed', t));
