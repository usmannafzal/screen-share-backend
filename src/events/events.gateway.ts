import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

@WebSocketGateway({
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EventsGateway.name);
  private rooms: Map<string, Set<string>> = new Map();
  private readonly MAX_PARTICIPANTS = 2; // Limit to 2 participants for screen sharing

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    this.cleanupClient(client.id);
  }

  private cleanupClient(clientId: string) {
    this.rooms.forEach((participants, roomId) => {
      if (participants.has(clientId)) {
        participants.delete(clientId);
        if (participants.size === 0) {
          this.rooms.delete(roomId);
          this.logger.log(`Room ${roomId} deleted as it became empty`);
        } else {
          // Notify remaining participants about the disconnection
          participants.forEach((peerId) => {
            this.server
              .to(peerId)
              .emit('peer-disconnected', { peerId: clientId });
          });
        }
      }
    });
  }

  @SubscribeMessage('join-room')
  handleJoinRoom(client: Socket, roomId: string) {
    try {
      if (!roomId || typeof roomId !== 'string') {
        throw new Error('Invalid room ID');
      }

      const participants = this.rooms.get(roomId) || new Set();

      if (participants.size >= this.MAX_PARTICIPANTS) {
        throw new Error('Room is full');
      }

      client.join(roomId);
      participants.add(client.id);
      this.rooms.set(roomId, participants);

      this.logger.log(`Client ${client.id} joined room ${roomId}`);
      this.logger.log(
        `Room ${roomId} now has ${participants.size} participants`,
      );
      client.emit('room-joined', { success: true, roomId });

      // Notify other participants about new user
      participants.forEach((peerId) => {
        if (peerId !== client.id) {
          this.server.to(peerId).emit('new-peer', { peerId: client.id });
          // Also notify the new client about existing peers
          client.emit('new-peer', { peerId });
        }
      });
    } catch (error) {
      this.logger.error(`Join room error: ${error.message}`);
      client.emit('room-error', { error: error.message });
    }
  }

  @SubscribeMessage('offer')
  handleOffer(
    client: Socket,
    payload: {
      roomId: string;
      offer: RTCSessionDescriptionInit;
      targetPeerId: string;
    },
  ) {
    try {
      if (!this.validateRoomParticipant(client.id, payload.roomId)) {
        throw new Error('Not a room participant');
      }
      this.server.to(payload.targetPeerId).emit('offer', {
        offer: payload.offer,
        senderId: client.id,
      });
      this.logger.log(
        `Offer sent from ${client.id} to ${payload.targetPeerId}`,
      );
    } catch (error) {
      this.logger.error(`Offer error: ${error.message}`);
      client.emit('signaling-error', { error: error.message });
    }
  }

  @SubscribeMessage('answer')
  handleAnswer(
    client: Socket,
    payload: {
      roomId: string;
      answer: RTCSessionDescriptionInit;
      targetPeerId: string;
    },
  ) {
    try {
      if (!this.validateRoomParticipant(client.id, payload.roomId)) {
        throw new Error('Not a room participant');
      }
      this.server.to(payload.targetPeerId).emit('answer', {
        answer: payload.answer,
        senderId: client.id,
      });
      this.logger.log(
        `Answer sent from ${client.id} to ${payload.targetPeerId}`,
      );
    } catch (error) {
      this.logger.error(`Answer error: ${error.message}`);
      client.emit('signaling-error', { error: error.message });
    }
  }

  @SubscribeMessage('ice-candidate')
  handleIceCandidate(
    client: Socket,
    payload: {
      roomId: string;
      candidate: RTCIceCandidate;
      targetPeerId: string;
    },
  ) {
    try {
      if (!this.validateRoomParticipant(client.id, payload.roomId)) {
        throw new Error('Not a room participant');
      }
      this.server.to(payload.targetPeerId).emit('ice-candidate', {
        candidate: payload.candidate,
        senderId: client.id,
      });
      this.logger.log(
        `ICE candidate sent from ${client.id} to ${payload.targetPeerId}`,
      );
    } catch (error) {
      this.logger.error(`ICE candidate error: ${error.message}`);
      client.emit('signaling-error', { error: error.message });
    }
  }

  private validateRoomParticipant(clientId: string, roomId: string): boolean {
    const participants = this.rooms.get(roomId);
    return participants ? participants.has(clientId) : false;
  }
}
