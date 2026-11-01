# Watch Party 🎬

A real-time YouTube Watch Party web app that lets people watch videos together in a shared room. The host and moderators control playback, while participants can request actions. Rooms also include live chat and participant role management.

## Project Preview

👉Live Link : [https://youtube-watch-party-fxqx.onrender.com/](https://youtube-watch-party-fxqx.onrender.com/)


<img width="1080" alt="Image" src="https://github.com/user-attachments/assets/56ec4fa0-de51-440c-bc9b-9fd29b3b7305" />


<img width="480" alt="Image" src="https://github.com/user-attachments/assets/3e6fa8cb-6fe1-4a8e-badd-a63dac385284" />



## Features

- **Create a room** — Start a watch party and receive a unique room code.
- **Join with a room code** — Invite friends to join the same room.
- **Synchronized playback** — Keep video playback, pause, and seeking synchronized for everyone.
- **YouTube support** — Paste a YouTube URL or video ID to change the video.
- **Role-based permissions**
  - **Host:** Controls playback, manages participants, assigns moderators, and can transfer host ownership.
  - **Moderator:** Controls playback and reviews participant requests.
  - **Participant:** Watches the video, chats, and sends playback requests.
- **Real-time chat** — Send messages to everyone in the room.
- **Request queue** — Participants can request playback actions for host/moderator approval.
- **Participant management** — The host can remove participants.
- **Session persistence** — Session tokens are stored in the browser; PostgreSQL can persist room state, sessions, and chat history.
- **Health endpoint** — `GET /health` returns the server health status.

## Tech Stack

- **Frontend:** React, Vite, JavaScript, CSS
- **Real-time communication:** Socket.IO
- **Backend:** Node.js, Express
- **Database (optional for local development; used when configured):** PostgreSQL (`pg`)
- **Video player:** YouTube IFrame Player API

## Getting Started

### Prerequisites

Install the following:

- [Node.js](https://nodejs.org/) 20 or newer
- npm (included with Node.js)
- PostgreSQL, if you want persistent database storage

### 1. Clone the repository

```bash
git clone <YOUR_GITHUB_REPOSITORY_URL>
cd watch-party
```

Replace `<YOUR_GITHUB_REPOSITORY_URL>` with your repository's clone URL.

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Create a `.env` file in the project root. Example:

```env
# Optional: PostgreSQL connection string
DATABASE_URL=postgresql://USERNAME:PASSWORD@HOST:5432/DATABASE_NAME

# Optional: set true when PostgreSQL requires SSL
PGSSL=false

# Frontend origin used for Socket.IO CORS
CLIENT_URL=http://localhost:5173

# Optional; defaults to 3000
PORT=3000
```

If `DATABASE_URL` is not configured, the server uses in-memory room storage. Rooms and their state will not survive a server restart. Keep real credentials out of source control; do not commit your `.env` file.


## How to Use

1. Open the app and enter a username.
2. Select **Create Room** to start a party, or enter a room code to join an existing one.
3. Share the room code with friends.
4. The host or a moderator can paste a YouTube link/video ID and control playback.
5. Participants can use chat and submit playback requests for approval.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Run the server and Vite development server for development |
| `npm run build` | Create the production frontend build |
| `npm start` | Start the Node.js server |

## Author
**Ankit Gangwar**
👉[github.com/ankitgangwar0012](https://github.com/ankitgangwar0012)
---

Made with ❤️ for watching together.
