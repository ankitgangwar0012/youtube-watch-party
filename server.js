import "dotenv/config";
import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import pg from "pg";

const { Pool } = pg;
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === "true" || process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : undefined
    })
  : null;

const app = express();
const server = http.createServer(app);

// const io = new Server(server, {
//   transports: ["websocket"],
//   maxHttpBufferSize: 16 * 1024
// });
const io = new Server(server, {
  transports: ["websocket"],

  cors: {
    origin: process.env.CLIENT_URL,
    methods: ["GET", "POST"]
  },

  maxHttpBufferSize: 16 * 1024
});



const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rooms = new Map();

const DEFAULT_VIDEO = "M7lc1UVf-VE";
const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;
const ROOM_ID = /^[A-F0-9]{8}$/;
const MAX_PARTICIPANTS = 100;
const MAX_REQUESTS = 30;
const MAX_CHAT_MESSAGES = 100;
const MAX_CHAT_LENGTH = 500;

class Room {
  constructor(id, savedState = null, hostSessionToken = null) {
    this.id = id;
    this.members = new Map();
    this.requests = new Map();
    this.chatMessages = [];
    this.hostSessionToken = hostSessionToken;

    this.state = savedState ? {
      videoId: savedState.videoId || DEFAULT_VIDEO,
      playing: Boolean(savedState.playing),
      position: Math.max(0, Number(savedState.position) || 0),
      updatedAt: savedState.updatedAt ? new Date(savedState.updatedAt).getTime() : Date.now()
    } : {
      videoId: DEFAULT_VIDEO,
      playing: false,
      position: 0,
      updatedAt: Date.now()
    };
  }

  currentPosition() {
    const elapsed = this.state.playing
      ? (Date.now() - this.state.updatedAt) / 1000
      : 0;

    return Math.max(0, this.state.position + elapsed);
  }

  snapshot() {
    return {
      roomId: this.id,
      members: [...this.members.values()],
      requests: [...this.requests.values()],
      chatMessages: this.chatMessages,
      state: {
        videoId: this.state.videoId,
        playing: this.state.playing,
        currentTime: this.currentPosition()
      }
    };
  }

  broadcast() {
    io.to(this.id).emit("snapshot", this.snapshot());
  }

  apply(action) {
    const position = this.currentPosition();

    switch (action.type) {
      case "play":
        this.state.position = position;
        this.state.playing = true;
        break;

      case "pause":
        this.state.position = position;
        this.state.playing = false;
        break;

      case "seek":
        this.state.position = action.time;
        break;

      case "change_video":
        this.state.videoId = action.videoId;
        this.state.position = 0;
        this.state.playing = false;
        break;
    }

    this.state.updatedAt = Date.now();
    persistRoomState(this).catch((error) => console.error("Could not persist room state:", error.message));
  }
}

async function initializeDatabase() {
  if (!pool) {
    console.warn("DATABASE_URL is not set; using in-memory rooms for local development.");
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS watch_rooms (
      room_id VARCHAR(8) PRIMARY KEY,
      video_id VARCHAR(11) NOT NULL,
      playing BOOLEAN NOT NULL DEFAULT FALSE,
      position DOUBLE PRECISION NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      host_session_token VARCHAR(100),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS user_sessions (
      session_token VARCHAR(100) PRIMARY KEY,
      username VARCHAR(30) NOT NULL,
      room_id VARCHAR(8) REFERENCES watch_rooms(room_id) ON DELETE SET NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'participant',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id VARCHAR(100) PRIMARY KEY,
      room_id VARCHAR(8) NOT NULL REFERENCES watch_rooms(room_id) ON DELETE CASCADE,
      session_token VARCHAR(100),
      username VARCHAR(30) NOT NULL,
      message VARCHAR(500) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_room_created
      ON chat_messages(room_id, created_at DESC);
  `);

  const result = await pool.query("SELECT room_id, video_id, playing, position, updated_at, host_session_token FROM watch_rooms");
  for (const row of result.rows) {
    const room = new Room(row.room_id, row, row.host_session_token);
    const messages = await pool.query(
      "SELECT id, session_token, username, message, created_at FROM (SELECT id, session_token, username, message, created_at FROM chat_messages WHERE room_id = $1 ORDER BY created_at DESC LIMIT $2) recent ORDER BY created_at ASC",
      [row.room_id, MAX_CHAT_MESSAGES]
    );
    room.chatMessages = messages.rows.map((message) => ({
      id: message.id,
      userId: message.session_token,
      username: message.username,
      message: message.message,
      createdAt: new Date(message.created_at).toISOString()
    }));
    rooms.set(room.id, room);
  }
  console.log(`PostgreSQL connected; restored ${rooms.size} room(s).`);
}

async function persistRoom(room) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO watch_rooms (room_id, video_id, playing, position, updated_at, host_session_token)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (room_id) DO UPDATE SET video_id = EXCLUDED.video_id,
       playing = EXCLUDED.playing, position = EXCLUDED.position,
       updated_at = EXCLUDED.updated_at, host_session_token = EXCLUDED.host_session_token`,
    [room.id, room.state.videoId, room.state.playing, room.currentPosition(), new Date(room.state.updatedAt), room.hostSessionToken]
  );
}

async function persistRoomState(room) {
  if (!pool) return;
  await pool.query(
    "UPDATE watch_rooms SET video_id = $2, playing = $3, position = $4, updated_at = $5, host_session_token = $6 WHERE room_id = $1",
    [room.id, room.state.videoId, room.state.playing, room.currentPosition(), new Date(room.state.updatedAt), room.hostSessionToken]
  );
}

async function saveSession(token, username, roomId, role) {
  if (!pool || !token) return;
  await pool.query(
    `INSERT INTO user_sessions (session_token, username, room_id, role, last_seen_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (session_token) DO UPDATE SET username = EXCLUDED.username,
       room_id = EXCLUDED.room_id, role = EXCLUDED.role, last_seen_at = NOW()`,
    [token, username, roomId, role]
  );
}

async function clearSessionRoom(token) {
  if (pool && token) {
    await pool.query("UPDATE user_sessions SET room_id = NULL, last_seen_at = NOW() WHERE session_token = $1", [token]);
  }
}

async function loadChatMessages(room) {
  if (!pool) return;
  const result = await pool.query(
    "SELECT id, session_token, username, message, created_at FROM (SELECT id, session_token, username, message, created_at FROM chat_messages WHERE room_id = $1 ORDER BY created_at DESC LIMIT $2) recent ORDER BY created_at ASC",
    [room.id, MAX_CHAT_MESSAGES]
  );
  room.chatMessages = result.rows.map((row) => ({
    id: row.id, userId: row.session_token, username: row.username,
    message: row.message, createdAt: new Date(row.created_at).toISOString()
  }));
}

function cleanSessionToken(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9-]{20,100}$/.test(value)) {
    throw new Error("Session token is invalid. Refresh the page and try again.");
  }
  return value;
}

function newRoomId() {
  let id;

  do {
    id = crypto.randomBytes(4).toString("hex").toUpperCase();
  } while (rooms.has(id));

  return id;
}

function cleanUsername(value) {
  if (typeof value !== "string") {
    throw new Error("Enter a username.");
  }

  const name = value.trim();

  if (name.length < 1 || name.length > 30) {
    throw new Error("Username must contain 1–30 characters.");
  }

  return name;
}

function validateAction(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid action.");
  }

  switch (input.type) {
    case "play":
    case "pause":
      return { type: input.type };

    case "seek": {
      const time = input.time;

      if (
        typeof time !== "number" ||
        !Number.isFinite(time) ||
        time < 0 ||
        time > 86400
      ) {
        throw new Error("Invalid seek position.");
      }

      return { type: "seek", time };
    }

    case "change_video":
      if (
        typeof input.videoId !== "string" ||
        !VIDEO_ID.test(input.videoId)
      ) {
        throw new Error("Invalid YouTube video ID.");
      }

      return {
        type: "change_video",
        videoId: input.videoId
      };

    default:
      throw new Error("Unknown playback action.");
  }
}

function getMembership(socket) {
  const room = rooms.get(socket.data.roomId);
  const member = room?.members.get(socket.id);

  if (!room || !member) {
    throw new Error("You are not in a room.");
  }

  return { room, member };
}

function requireHost(member) {
  if (member.role !== "host") {
    throw new Error("Only the host can do that.");
  }
}

function canControl(member) {
  return member.role === "host" || member.role === "moderator";
}

function handler(socket, event, callback) {
  socket.on(event, (payload, acknowledge) => {
    const reply = typeof acknowledge === "function" ? acknowledge : () => {};

    Promise.resolve()
      .then(() => callback(payload ?? {}))
      .then((result) => reply({ ok: true, ...(result || {}) }))
      .catch((error) => {
        reply({
          ok: false,
          error: error instanceof Error ? error.message : "Unexpected error."
        });
      });
  });
}

async function leaveRoom(socket, { disconnected = false } = {}) {
  const room = rooms.get(socket.data.roomId);
  const member = room?.members.get(socket.id);

  if (!room || !member) {
    socket.data.roomId = null;
    return;
  }

  if (member.role === "host") {
    // A room belongs to its current host. If the host leaves explicitly or
    // disconnects (including closing the tab), close the room for everyone.
    io.to(room.id).emit(
      "room_closed",
      "The host left. This room has closed."
    );

    const memberSessions = [...room.members.values()].map((roomMember) => roomMember.sessionToken);

    for (const memberId of room.members.keys()) {
      const participantSocket = io.sockets.sockets.get(memberId);

      if (participantSocket) {
        participantSocket.data.roomId = null;
        participantSocket.leave(room.id);
      }
    }

    room.members.clear();
    room.requests.clear();
    rooms.delete(room.id);

    if (pool) {
      await pool.query("DELETE FROM watch_rooms WHERE room_id = $1", [room.id]);
      for (const sessionToken of memberSessions) {
        await clearSessionRoom(sessionToken);
      }
    }

    socket.data.roomId = null;
    return;
  }

  room.members.delete(socket.id);
  await clearSessionRoom(member.sessionToken);

  for (const [requestId, request] of room.requests) {
    if (request.userId === socket.id) {
      room.requests.delete(requestId);
    }
  }

  socket.leave(room.id);
  socket.data.roomId = null;
  room.broadcast();
}

io.on("connection", (socket) => {
  handler(socket, "create_room", async ({ username, sessionToken }) => {
    if (socket.data.roomId) {
      throw new Error("Leave your current room first.");
    }

    const name = cleanUsername(username);
    const token = cleanSessionToken(sessionToken || socket.handshake.auth?.sessionToken);
    const id = newRoomId();
    const room = new Room(id, null, token);

    room.members.set(socket.id, {
      id: socket.id,
      username: name,
      role: "host",
      sessionToken: token
    });

    rooms.set(id, room);
    await persistRoom(room);
    await saveSession(token, name, id, "host");
    socket.data.roomId = id;
    socket.data.sessionToken = token;
    socket.join(id);

    return { snapshot: room.snapshot(), userId: socket.id, sessionToken: token };
  });

  handler(socket, "join_room", async ({ roomId, username, sessionToken }) => {
    if (socket.data.roomId) {
      throw new Error("Leave your current room first.");
    }

    const id = typeof roomId === "string"
      ? roomId.trim().toUpperCase()
      : "";

    if (!ROOM_ID.test(id)) {
      throw new Error("Enter a valid room code.");
    }

    const room = rooms.get(id);

    if (!room) {
      throw new Error("Room not found.");
    }

    if (room.members.size >= MAX_PARTICIPANTS) {
      throw new Error("This room is full.");
    }

    const name = cleanUsername(username);
    const token = cleanSessionToken(sessionToken || socket.handshake.auth?.sessionToken);
    const existingSession = pool
      ? await pool.query("SELECT role, username FROM user_sessions WHERE session_token = $1", [token])
      : { rows: [] };
    let role = existingSession.rows[0]?.role || "participant";
    if (room.hostSessionToken && token === room.hostSessionToken) role = "host";
    if (!room.hostSessionToken) {
      role = "host";
      room.hostSessionToken = token;
    }
    if (role === "host" && token !== room.hostSessionToken) role = "participant";

    room.members.set(socket.id, {
      id: socket.id,
      username: name,
      role,
      sessionToken: token
    });

    socket.data.roomId = id;
    socket.data.sessionToken = token;
    socket.join(id);
    await saveSession(token, name, id, role);
    await loadChatMessages(room);
    room.broadcast();

    return { snapshot: room.snapshot(), userId: socket.id, sessionToken: token };
  });

  handler(socket, "leave_room", async () => {
    await leaveRoom(socket);
    return {};
  });

  handler(socket, "playback", ({ action }) => {
    const { room, member } = getMembership(socket);

    if (!canControl(member)) {
      throw new Error("Only the host or a moderator can control playback.");
    }

    room.apply(validateAction(action));
    room.broadcast();

    return {};
  });

  handler(socket, "request_action", ({ action }) => {
    const { room, member } = getMembership(socket);

    if (member.role !== "participant") {
      throw new Error("Controllers can perform actions directly.");
    }

    if (room.requests.size >= MAX_REQUESTS) {
      throw new Error("Too many pending requests.");
    }

    const id = crypto.randomUUID();

    room.requests.set(id, {
      id,
      userId: member.id,
      username: member.username,
      action: validateAction(action)
    });

    room.broadcast();
    return {};
  });

  handler(socket, "decide_request", ({ requestId, approve }) => {
    const { room, member } = getMembership(socket);

    if (!canControl(member)) {
      throw new Error("Only the host or a moderator can review requests.");
    }

    if (typeof approve !== "boolean") {
      throw new Error("Invalid decision.");
    }

    const request = room.requests.get(requestId);

    if (!request) {
      throw new Error("Request no longer exists.");
    }

    room.requests.delete(requestId);

    if (approve) {
      room.apply(request.action);
    }

    room.broadcast();
    return {};
  });

  handler(socket, "assign_role", async ({ userId, role }) => {
    const { room, member } = getMembership(socket);
    requireHost(member);

    const target = room.members.get(userId);

    if (!target || target.role === "host") {
      throw new Error("Invalid participant.");
    }

    if (role !== "participant" && role !== "moderator") {
      throw new Error("Invalid role.");
    }

    target.role = role;
    await saveSession(target.sessionToken, target.username, room.id, role);
    room.broadcast();

    return {};
  });

  handler(socket, "transfer_host", async ({ userId }) => {
    const { room, member } = getMembership(socket);
    requireHost(member);
    const target = room.members.get(userId);
    if (!target || target.id === member.id) throw new Error("Choose another participant to transfer host to.");

    member.role = "participant";
    target.role = "host";
    room.hostSessionToken = target.sessionToken;
    await saveSession(member.sessionToken, member.username, room.id, member.role);
    await saveSession(target.sessionToken, target.username, room.id, target.role);
    await persistRoom(room);
    room.broadcast();
    return {};
  });

  handler(socket, "send_chat_message", async ({ message }) => {
    const { room, member } = getMembership(socket);
    if (typeof message !== "string") throw new Error("Message must be text.");
    const cleanMessage = message.trim();
    if (!cleanMessage) throw new Error("Write a message first.");
    if (cleanMessage.length > MAX_CHAT_LENGTH) throw new Error(`Messages can contain up to ${MAX_CHAT_LENGTH} characters.`);

    const chatMessage = {
      id: crypto.randomUUID(),
      userId: member.id,
      sessionToken: member.sessionToken,
      username: member.username,
      message: cleanMessage,
      createdAt: new Date().toISOString()
    };
    room.chatMessages.push({
      id: chatMessage.id, userId: chatMessage.userId, username: chatMessage.username,
      message: chatMessage.message, createdAt: chatMessage.createdAt
    });
    room.chatMessages = room.chatMessages.slice(-MAX_CHAT_MESSAGES);
    if (pool) {
      await pool.query(
        "INSERT INTO chat_messages (id, room_id, session_token, username, message, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [chatMessage.id, room.id, member.sessionToken, member.username, cleanMessage, chatMessage.createdAt]
      );
    }
    room.broadcast();
    return {};
  });

  handler(socket, "remove_participant", async ({ userId }) => {
    const { room, member } = getMembership(socket);
    requireHost(member);

    const target = room.members.get(userId);

    if (!target || target.role === "host") {
      throw new Error("Invalid participant.");
    }

    const targetSocket = io.sockets.sockets.get(userId);

    if (targetSocket) {
      targetSocket.emit("removed", "The host removed you from the room.");
      targetSocket.leave(room.id);
      targetSocket.data.roomId = null;
    }

    room.members.delete(userId);
    await clearSessionRoom(target.sessionToken);

    for (const [requestId, request] of room.requests) {
      if (request.userId === userId) {
        room.requests.delete(requestId);
      }
    }

    room.broadcast();
    return {};
  });

  socket.on("disconnect", () => { leaveRoom(socket, { disconnected: true }).catch((error) => console.error("Disconnect cleanup failed:", error.message)); });
});

// Periodic snapshots correct drift and help clients recover from buffering.
setInterval(() => {
  for (const room of rooms.values()) {
    room.broadcast();
    persistRoomState(room).catch((error) => console.error("Room persistence failed:", error.message));
  }
}, 10000);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "dist")));

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

const port = Number(process.env.PORT) || 3000;

initializeDatabase()
  .then(() => {
    server.listen(port, "0.0.0.0", () => {
      console.log(`Watch Party listening on port ${port}`);
    });
  })
  .catch((error) => {
    console.error("Database initialization failed:", error.message);
    process.exit(1);
  });