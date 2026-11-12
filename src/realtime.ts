// Canal temps réel : chaque client WebSocket reçoit les messages destinés à son rôle.

import type { WebSocket } from 'ws';

import type { Principal } from './types.ts';

type Audience = Principal['role'];

interface Client {
  socket: WebSocket;
  principal: Principal;
}

export class Hub {
  private clients = new Set<Client>();

  add(socket: WebSocket, principal: Principal) {
    const client = { socket, principal };
    this.clients.add(client);
    socket.on('close', () => this.clients.delete(client));
  }

  /** Envoie `{ type, data }` aux clients des rôles donnés. `data` peut dépendre du destinataire. */
  broadcast(type: string, data: object | ((p: Principal) => object | null), roles: Audience[]) {
    for (const { socket, principal } of this.clients) {
      if (!roles.includes(principal.role) || socket.readyState !== socket.OPEN) continue;
      const payload = typeof data === 'function' ? data(principal) : data;
      if (payload) socket.send(JSON.stringify({ type, data: payload }));
    }
  }

  /** Envoie un message à un terminal ; `false` s'il n'est pas connecté. */
  sendToTerminal(terminalId: string, type: string, data: object): boolean {
    let sent = false;
    for (const { socket, principal } of this.clients) {
      if (principal.role !== 'terminal' || principal.id !== terminalId || socket.readyState !== socket.OPEN) continue;
      socket.send(JSON.stringify({ type, data }));
      sent = true;
    }
    return sent;
  }

  /** Ping régulier pour garder les connexions ouvertes derrière le proxy. */
  ping() {
    for (const { socket } of this.clients) if (socket.readyState === socket.OPEN) socket.ping();
  }

  closeAll() {
    for (const { socket } of this.clients) socket.close(1001);
    this.clients.clear();
  }
}
