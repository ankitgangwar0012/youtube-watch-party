import React, { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const SESSION_KEY = "watchtogether-session-token";
function getSessionToken() {
  let token = localStorage.getItem(SESSION_KEY);
  if (!token) {
    token = crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, token);
  }
  return token;
}
const socket = io({
  transports: ["websocket"],
  auth: { sessionToken: getSessionToken() }
});

let youtubePromise;

function loadYouTube() {
  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }

  if (!youtubePromise) {
    youtubePromise = new Promise((resolve, reject) => {
      window.onYouTubeIframeAPIReady = () => resolve(window.YT);

      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.onerror = () => reject(new Error("Could not load YouTube."));
      document.head.appendChild(script);
    });
  }

  return youtubePromise;
}

function extractVideoId(value) {
  const input = value.trim();

  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) {
    return input;
  }

  try {
    const url = new URL(input);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    let id = "";

    if (hostname === "youtu.be") {
      id = url.pathname.split("/").filter(Boolean)[0] || "";
    } else if (
      hostname === "youtube.com" ||
      hostname === "m.youtube.com" ||
      hostname === "youtube-nocookie.com"
    ) {
      const parts = url.pathname.split("/").filter(Boolean);

      if (url.pathname === "/watch") {
        id = url.searchParams.get("v") || "";
      } else if (
        parts[0] === "embed" ||
        parts[0] === "shorts" ||
        parts[0] === "live"
      ) {
        id = parts[1] || "";
      }
    }

    return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function formatTime(seconds) {
  const value = Math.max(0, Math.floor(seconds || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainingSeconds = value % 60;

  if (hours) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(
      remainingSeconds
    ).padStart(2, "0")}`;
  }

  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function describeAction(action) {
  switch (action.type) {
    case "play":
      return "Play the video";
    case "pause":
      return "Pause the video";
    case "seek":
      return `Seek to ${formatTime(action.time)}`;
    case "change_video":
      return `Change video to ${action.videoId}`;
    default:
      return "Unknown request";
  }
}

function Player({ state, onError, playerRef }) {
  const containerRef = useRef(null);
  const latestState = useRef(state);
  const loadedVideo = useRef(null);
  const readyRef = useRef(false);
  const onErrorRef = useRef(onError);

  latestState.current = state;
  onErrorRef.current = onError;

  function synchronize(nextState) {
    const player = playerRef.current;

    if (!readyRef.current || !player || !nextState) {
      return;
    }

    try {
      if (loadedVideo.current !== nextState.videoId) {
        loadedVideo.current = nextState.videoId;

        player.cueVideoById({
          videoId: nextState.videoId,
          startSeconds: nextState.currentTime
        });

        if (nextState.playing) {
          player.playVideo();
        }

        return;
      }

      const localTime = player.getCurrentTime() || 0;

      if (Math.abs(localTime - nextState.currentTime) > 1.5) {
        player.seekTo(nextState.currentTime, true);
      }

      const playerState = player.getPlayerState();

      if (nextState.playing) {
        if (playerState !== window.YT.PlayerState.PLAYING) {
          player.playVideo();
        }
      } else if (playerState === window.YT.PlayerState.PLAYING) {
        player.pauseVideo();
      }
    } catch {
      // The player can briefly be unavailable while the iframe initializes.
    }
  }

  const syncRef = useRef(synchronize);
  syncRef.current = synchronize;

  useEffect(() => {
    let cancelled = false;
    let player;

    loadYouTube()
      .then((YT) => {
        if (cancelled || !containerRef.current) return;

        const playerElement = document.createElement("div");
        containerRef.current.appendChild(playerElement);

        player = new YT.Player(playerElement, {
          videoId: latestState.current.videoId,
          playerVars: {
            controls: 0,
            playsinline: 1,
            rel: 0,
            origin: window.location.origin
          },
          events: {
            onReady: () => {
              if (cancelled) return;

              playerRef.current = player;
              loadedVideo.current = latestState.current.videoId;
              readyRef.current = true;
              syncRef.current(latestState.current);
            },
            onError: () => {
              onErrorRef.current(
                "YouTube could not play this video. It may not allow embedding."
              );
            }
          }
        });
      })
      .catch((error) => onErrorRef.current(error.message));

    return () => {
      cancelled = true;
      readyRef.current = false;
      playerRef.current = null;

      if (player?.destroy) {
        player.destroy();
      }
    };
  }, [playerRef]);

  useEffect(() => {
    syncRef.current(state);
  }, [state]);

  return (
    <div className="video-shell">
      <div className="video-frame" ref={containerRef} />
      <div
        className="video-overlay"
        aria-hidden="true"
        title="Use the room controls below the video"
      />
    </div>
  );
}

function App() {
  const [username, setUsername] = useState("");
  const [roomCode, setRoomCode] = useState(
    new URLSearchParams(window.location.search).get("room") || ""
  );
  const [snapshot, setSnapshot] = useState(null);
  const [userId, setUserId] = useState(null);
  const [connected, setConnected] = useState(socket.connected);
  const [notice, setNotice] = useState("");
  const [videoInput, setVideoInput] = useState("");
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [chatDraft, setChatDraft] = useState("");
  const chatEndRef = useRef(null);
  const playerRef = useRef(null);

  useEffect(() => {
    function handleConnect() {
      setConnected(true);
    }

    function handleDisconnect() {
      setConnected(false);
      setSnapshot(null);
      setUserId(null);
      setNotice("Connection lost. Rejoin or create a room.");
    }

    function handleSnapshot(nextSnapshot) {
      setSnapshot(nextSnapshot);
    }

    function handleExit(message) {
      setSnapshot(null);
      setUserId(null);
      setNotice(message);
    }

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("snapshot", handleSnapshot);
    socket.on("removed", handleExit);
    socket.on("room_closed", handleExit);

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("snapshot", handleSnapshot);
      socket.off("removed", handleExit);
      socket.off("room_closed", handleExit);
    };
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [snapshot?.chatMessages?.length]);


  useEffect(() => {
    const timer = setInterval(() => {
      const player = playerRef.current;

      if (!player?.getCurrentTime) return;

      try {
        setPosition(player.getCurrentTime() || 0);
        setDuration(player.getDuration() || 0);
      } catch {
        // Ignore player calls during initialization.
      }
    }, 500);

    return () => clearInterval(timer);
  }, []);

  function emit(event, payload, onSuccess) {
    if (!socket.connected) {
      setNotice("Not connected to the server.");
      return;
    }

    socket.timeout(5000).emit(event, payload, (error, response) => {
      if (error) {
        setNotice("The server did not respond. Please try again.");
        return;
      }

      if (!response?.ok) {
        setNotice(response?.error || "Something went wrong.");
        return;
      }

      setNotice("");
      onSuccess?.(response);
    });
  }

  function enterRoom(event) {
    const payload =
      event === "create_room"
        ? { username, sessionToken: getSessionToken() }
        : { username, roomId: roomCode, sessionToken: getSessionToken() };

    emit(event, payload, (response) => {
      setUserId(response.userId);
      if (response.sessionToken) localStorage.setItem(SESSION_KEY, response.sessionToken);
      setSnapshot(response.snapshot);
      setRoomCode(response.snapshot.roomId);

      const url = new URL(window.location.href);
      url.searchParams.set("room", response.snapshot.roomId);
      window.history.replaceState({}, "", url);
    });
  }

  function leaveRoom() {
    emit("leave_room", {}, () => {
      setSnapshot(null);
      setUserId(null);

      const url = new URL(window.location.href);
      url.searchParams.delete("room");
      window.history.replaceState({}, "", url);
    });
  }

  const me = snapshot?.members.find((member) => member.id === userId);
  const isHost = me?.role === "host";
  const canControl = isHost || me?.role === "moderator";


  function sendAction(action) {
    if (!me) return;

    const event = canControl ? "playback" : "request_action";

    emit(event, { action }, () => {
      if (!canControl) {
        setNotice("Request sent to the host and moderators.");
      }
    });
  }

  function sendChatMessage(event) {
    event.preventDefault();
    if (!chatDraft.trim()) return;
    emit("send_chat_message", { message: chatDraft }, () => setChatDraft(""));
  }

  function changeVideo(event) {
    event.preventDefault();

    const videoId = extractVideoId(videoInput);

    if (!videoId) {
      setNotice("Enter a valid YouTube URL or 11-character video ID.");
      return;
    }

    sendAction({ type: "change_video", videoId });
    setVideoInput("");
  }

  async function copyLink() {
    const url = new URL(window.location.origin);
    url.searchParams.set("room", snapshot.roomId);

    try {
      await navigator.clipboard.writeText(url.toString());
      setNotice("Invite link copied.");
    } catch {
      setNotice(`Share this link: ${url.toString()}`);
    }
  }

  function enablePlayback() {
    try {
      const player = playerRef.current;

      if (!player) {
        setNotice("The player is still loading.");
        return;
      }

      player.unMute();

      if (snapshot.state.playing) {
        player.playVideo();
      }

      setNotice("Playback enabled for this browser.");
    } catch {
      setNotice("Could not enable playback yet. Try again.");
    }
  }

  return (
    <main className="page">
      <header className="header">
        <a className="brand" href="/" aria-label="WatchTogether home">
          <span className="brand-mark">▶</span>
          <span>watch<span className="brand-accent">together</span></span>
        </a>
        <div className="header-right">
          <span className={`status ${connected ? "online" : ""}`}>
            <span className="status-dot" />
            {connected ? "Server connected" : "Connecting to server"}
          </span>
          <span className="header-caption">A little closer, wherever you are.</span>
        </div>
      </header>

      {notice && (
        <div className="notice" role="status">
          {notice}
          <button
            className="notice-close"
            onClick={() => setNotice("")}
            aria-label="Dismiss message"
          >
            ×
          </button>
        </div>
      )}

      {!snapshot ? (
        <div>
        <section className="lobby-wrap">
          <div className="hero-copy">
            <div className="eyebrow"><span className="eyebrow-line" /> YOUR PEOPLE. YOUR SCREEN. YOUR MOMENT.</div>
            <h1>Good videos are<br /><span>better together.</span></h1>
            <p className="hero-description">Press play at the same time, share your reactions, and make every watch feel like you're in the same room.</p>
            <div className="hero-points">
              <span><i>✓</i> Synced playback</span>
              <span><i>✓</i> Private rooms</span>
              <span><i>✓</i> Made for your crew</span>
            </div>
            <div className="hero-orbit orbit-one" />
            <div className="hero-orbit orbit-two" />
            <div className="hero-play">▶</div>
            <div className="floating-note note-top">✦ Movie night, sorted</div>
            <div className="floating-note note-bottom"><span className="mini-avatars"><b>A</b><b>M</b><b>J</b></span> Your people are one link away</div>
          </div>

          <section className="card lobby">
          <div className="form-kicker">LET'S GET TOGETHER</div>
          <h2>Start a watch party</h2>
          <p>Create a private room or jump into one your friend shared.</p>

          <label>
            Your name
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Enter your name"
              maxLength={30}
            />
          </label>

          <button
            className="primary full"
            disabled={!connected}
            onClick={() => enterRoom("create_room")}
          >
            Create a room
          </button>

          <div className="divider">or join a room</div>

          <label>
            Room code
            <input
              value={roomCode}
              onChange={(event) =>
                setRoomCode(event.target.value.toUpperCase())
              }
              placeholder="8-character code"
              maxLength={8}
            />
          </label>

          <button
            className="secondary full join-button"
            disabled={!connected}
            onClick={() => enterRoom("join_room")}
          >
            Join room <span aria-hidden="true">→</span>
          </button>
          <div className="secure-note"><span>⌑</span> No account needed · Just bring your link</div>
          </section>
        </section>

        <section className="feature-strip" aria-label="Watch party features">
          <article className="feature-item"><span className="feature-icon violet">◉</span><div><strong>Always in sync</strong><p>Everyone watches the same moment.</p></div></article>
          <article className="feature-item"><span className="feature-icon pink">♡</span><div><strong>Your own room</strong><p>Invite your crew with one simple link.</p></div></article>
          <article className="feature-item"><span className="feature-icon blue">✦</span><div><strong>More than watching</strong><p>Hang out while your video plays.</p></div></article>
        </section>
        </div>
      ) : (
        <>
          <div className="room-bar">
            <div className="room-identity">
              <div className="room-live-icon">▶</div>
              <div>
                <span className="muted room-label">YOU'RE WATCHING TOGETHER</span>
                <div className="room-title-line">
                  <strong className="room-code">{snapshot.roomId}</strong>
                  <span className="role-pill">{me?.role || "joining"}</span>
                </div>
              </div>
            </div>

            <div className="button-row">
              <button className="secondary" onClick={copyLink}>
                Copy invite link
              </button>
              <button className="ghost" onClick={leaveRoom}>
                Leave
              </button>
            </div>
          </div>

          <div className="layout">
            <section className="main-column">
              <div className="card player-card">
                <Player
                  state={snapshot.state}
                  onError={setNotice}
                  playerRef={playerRef}
                />

                <div className="controls">
                  <div className="control-row">
                    <button
                      className="primary"
                      onClick={() =>
                        sendAction({
                          type: snapshot.state.playing ? "pause" : "play"
                        })
                      }
                    >
                      {!canControl && "Request "}
                      {snapshot.state.playing ? "Pause" : "Play"}
                    </button>

                    <button className="secondary" onClick={enablePlayback}>
                      Enable playback / sound
                    </button>

                    <span className="time">
                      {formatTime(position)} / {formatTime(duration)}
                    </span>
                  </div>

                  <label className="seek-label">
                    {canControl ? "Seek" : "Request a seek"}
                    <input
                      type="range"
                      min="0"
                      max={Math.max(duration, 1)}
                      step="1"
                      value={Math.min(position, Math.max(duration, 1))}
                      disabled={!duration}
                      onChange={(event) => {
                        const time = Number(event.target.value);
                        setPosition(time);
                        sendAction({ type: "seek", time });
                      }}
                    />
                  </label>

                  <p className="hint">
                    {canControl
                      ? "Your playback changes are synchronized with the room."
                      : "Playback changes need approval from the host or a moderator."}
                    {" "}If playback is blocked, select “Enable playback / sound”.
                  </p>
                </div>
              </div>

              <div className="card">
                <h2>Change video</h2>
                <p>Paste a YouTube link or video ID.</p>

                <form className="video-form" onSubmit={changeVideo}>
                  <input
                    value={videoInput}
                    onChange={(event) => setVideoInput(event.target.value)}
                    placeholder="https://youtube.com/watch?v=..."
                  />
                  <button className="primary" type="submit">
                    {canControl ? "Load video" : "Request video"}
                  </button>
                </form>
              </div>

              {canControl && (
                <div className="card">
                  <h2>Playback requests</h2>

                  {snapshot.requests.length === 0 ? (
                    <p>No pending requests.</p>
                  ) : (
                    <div className="request-list">
                      {snapshot.requests.map((request) => (
                        <div className="request" key={request.id}>
                          <div>
                            <strong>{request.username}</strong>
                            <div className="muted">
                              {describeAction(request.action)}
                            </div>
                          </div>

                          <div className="button-row">
                            <button
                              className="secondary"
                              onClick={() =>
                                emit("decide_request", {
                                  requestId: request.id,
                                  approve: false
                                })
                              }
                            >
                              Decline
                            </button>
                            <button
                              className="primary"
                              onClick={() =>
                                emit("decide_request", {
                                  requestId: request.id,
                                  approve: true
                                })
                              }
                            >
                              Approve
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>

            <div className="side-column">
            <aside className="card participants">
              <div className="section-heading">
                <h2>Participants</h2>
                <span className="count">{snapshot.members.length}</span>
              </div>

              {snapshot.members.map((member) => (
                <div className="member" key={member.id}>
                  <div className="avatar">
                    {member.username.slice(0, 1).toUpperCase()}
                  </div>

                  <div className="member-info">
                    <strong>
                      {member.username}
                      {member.id === userId ? " (you)" : ""}
                    </strong>
                    <span>{member.role}</span>
                  </div>

                  {isHost && member.id !== userId && (
                    <div className="member-actions">
                      <select
                        value={member.role}
                        aria-label={`Role for ${member.username}`}
                        onChange={(event) =>
                          emit("assign_role", {
                            userId: member.id,
                            role: event.target.value
                          })
                        }
                      >
                        <option value="participant">Participant</option>
                        <option value="moderator">Moderator</option>
                      </select>

                      <button
                        className="host-transfer"
                        onClick={() => {
                          if (window.confirm(`Transfer host role to ${member.username}?`)) {
                            emit("transfer_host", { userId: member.id });
                          }
                        }}
                      >
                        Make host
                      </button>

                      <button
                        className="danger"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Remove ${member.username} from this room?`
                            )
                          ) {
                            emit("remove_participant", {
                              userId: member.id
                            });
                          }
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </aside>

            <section className="card chat-panel" aria-label="Live chat">
              <div className="section-heading chat-heading">
                <div>
                  <h2>Live chat</h2>
                  <p>Talk with everyone watching.</p>
                </div>
                <span className="chat-live"><span /> LIVE</span>
              </div>
              <div className="chat-messages" aria-live="polite">
                {(snapshot.chatMessages || []).map((message) => (
                  <article className={`chat-message ${message.userId === userId ? "mine" : ""}`} key={message.id}>
                    <div className="chat-message-top">
                      <strong>{message.username}{message.userId === userId ? " · you" : ""}</strong>
                      <time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                    </div>
                    <p>{message.message}</p>
                  </article>
                ))}
                {(snapshot.chatMessages || []).length === 0 && (
                  <div className="chat-empty"><span>✦</span><strong>Make the first comment</strong><p>Share your reaction with the room.</p></div>
                )}
                <div ref={chatEndRef} />
              </div>
              <form className="chat-form" onSubmit={sendChatMessage}>
                <input
                  value={chatDraft}
                  onChange={(event) => setChatDraft(event.target.value)}
                  placeholder="Say something nice…"
                  maxLength={500}
                  aria-label="Chat message"
                />
                <button className="primary" type="submit" disabled={!chatDraft.trim()}>Send ↗</button>
              </form>
              <div className="chat-footnote">Be kind · Up to 500 characters</div>
            </section>
            </div>
          </div>
        </>
      )}

      {!snapshot && <footer className="site-footer"><span>Made for shared moments.</span><span>WATCH TOGETHER <b>✦</b></span></footer>}
    </main>
  );
}

export default App;