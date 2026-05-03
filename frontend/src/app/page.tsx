"use client";

import { useState, useEffect, useRef } from "react";
import { v4 as uuidv4 } from "uuid";

// ─── Types ────────────────────────────────────────────────────
interface Level {
  level_id: number;
  name: string;
  difficulty: string;
  description: string;
  hint: string;
  completed: boolean;
}

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  is_successful?: boolean;
  response_ms?: number;
}

interface AttemptResponse {
  attempt_id: number;
  level: number;
  llm_response: string;
  is_successful: boolean;
  confidence: number;
  match_strategy: string;
  response_ms: number;
  tokens_used: number;
}

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL || "";

const DIFFICULTY_COLORS: Record<string, string> = {
  Easy:   "text-emerald-400 bg-emerald-400/10 border-emerald-400/30",
  Medium: "text-amber-400  bg-amber-400/10  border-amber-400/30",
  Expert: "text-purple-400 bg-purple-400/10 border-purple-400/30",
  Hard:   "text-rose-400   bg-rose-400/10   border-rose-400/30",
};

// ─── Utility ──────────────────────────────────────────────────
function getSessionId(): string {
  if (typeof window === "undefined") return "ssr";
  let id = localStorage.getItem("ctf_session_id");
  if (!id) {
    id = uuidv4();
    localStorage.setItem("ctf_session_id", id);
  }
  return id;
}

// ─── Component: Level Card ─────────────────────────────────────
function LevelCard({
  level,
  isActive,
  onClick,
}: {
  level: Level;
  isActive: boolean;
  onClick: () => void;
}) {
  const diffClass = DIFFICULTY_COLORS[level.difficulty] || "text-gray-400 bg-gray-400/10 border-gray-400/30";

  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-4 rounded-xl border transition-all duration-200 group
        ${isActive
          ? "border-cyan-500 bg-cyan-500/10 shadow-lg shadow-cyan-500/20"
          : "border-gray-700 bg-gray-800/60 hover:border-gray-500 hover:bg-gray-800"
        }`}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-gray-500">LVL {level.level_id}</span>
          {level.completed && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
              ✓ SOLVED
            </span>
          )}
        </div>
        <span className={`text-xs px-2 py-0.5 rounded border ${diffClass}`}>
          {level.difficulty}
        </span>
      </div>
      <h3 className="font-semibold text-white group-hover:text-cyan-300 transition-colors">
        {level.name}
      </h3>
      <p className="text-xs text-gray-400 mt-1 line-clamp-2">{level.description}</p>
    </button>
  );
}

// ─── Component: Chat Bubble ────────────────────────────────────
function ChatBubble({ msg }: { msg: Message }) {
  const isUser = msg.role === "user";
  const isSystem = msg.role === "system";

  if (isSystem) {
    return (
      <div className="flex justify-center my-3">
        <span className="text-xs text-gray-500 bg-gray-800 px-3 py-1 rounded-full border border-gray-700">
          {msg.content}
        </span>
      </div>
    );
  }

  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : "flex-row"} mb-4`}>
      {/* Avatar */}
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 text-sm font-bold
        ${isUser ? "bg-cyan-600 text-white" : "bg-gray-700 text-gray-300"}`}>
        {isUser ? "Y" : "AI"}
      </div>

      {/* Bubble */}
      <div className={`max-w-[80%] ${isUser ? "items-end" : "items-start"} flex flex-col gap-1`}>
        <div className={`px-4 py-3 rounded-2xl text-sm leading-relaxed
          ${isUser
            ? "bg-cyan-600 text-white rounded-tr-sm"
            : `bg-gray-800 border text-gray-200 rounded-tl-sm
               ${msg.is_successful ? "border-emerald-500/50" : "border-gray-700"}`
          }`}>
          {msg.content}
        </div>
        {msg.response_ms && (
          <span className="text-xs text-gray-600 px-1">
            {msg.response_ms}ms
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Component: Success Modal ──────────────────────────────────
function SuccessModal({
  level,
  attempts,
  onClose,
  onNextLevel,
}: {
  level: Level;
  attempts: number;
  onClose: () => void;
  onNextLevel?: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-emerald-500/50 rounded-2xl p-8 max-w-md w-full
                      shadow-2xl shadow-emerald-500/20 text-center animate-in fade-in zoom-in duration-300">

        {/* Trophy animation */}
        <div className="text-6xl mb-4 animate-bounce">🏆</div>

        <h2 className="text-2xl font-bold text-emerald-400 mb-2">Flag Captured!</h2>
        <p className="text-gray-400 mb-6">
          You successfully bypassed the guardrails on{" "}
          <span className="text-white font-semibold">{level.name}</span>.
        </p>

        <div className="bg-gray-800 rounded-xl p-4 mb-6 border border-gray-700">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-gray-500">Attempts</div>
              <div className="text-white font-bold text-xl">{attempts}</div>
            </div>
            <div>
              <div className="text-gray-500">Difficulty</div>
              <div className={`font-bold text-xl ${
                level.difficulty === "Easy" ? "text-emerald-400" :
                level.difficulty === "Medium" ? "text-amber-400" : "text-rose-400"
              }`}>{level.difficulty}</div>
            </div>
          </div>
        </div>

        <div className="bg-gray-800/50 rounded-lg p-3 mb-6 text-left border border-cyan-500/20">
          <p className="text-xs text-cyan-400 font-mono font-semibold mb-1">💡 ATTACK VECTOR</p>
          <p className="text-xs text-gray-400">
            {level.level_id === 1 && "Direct prompt injection — no defenses present. The AI disclosed the secret because you asked directly."}
            {level.level_id === 2 && "Indirect injection — the AI's instructions were bypassed using role-play, translation, or context manipulation."}
            {level.level_id === 3 && "Jailbreak — the persona guardrail was broken by finding a scenario where the character's constraints don't apply."}
          </p>
        </div>

        <div className="flex gap-3">
          <button onClick={onClose}
            className="flex-1 px-4 py-2.5 rounded-xl border border-gray-700 text-gray-300
                       hover:bg-gray-800 transition-colors text-sm">
            Stay Here
          </button>
          {onNextLevel && (
            <button onClick={onNextLevel}
              className="flex-1 px-4 py-2.5 rounded-xl bg-emerald-600 text-white font-semibold
                         hover:bg-emerald-500 transition-colors text-sm">
              Next Level →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────
export default function CTFPage() {
  const [sessionId, setSessionId] = useState("ssr");

  useEffect(() => {
    setSessionId(getSessionId());
  }, []);
  const [levels, setLevels]  = useState<Level[]>([]);
  const [activeLevel, setActiveLevel] = useState<Level | null>(null);
  const [messages, setMessages]       = useState<Message[]>([]);
  const [input, setInput]             = useState("");
  const [isLoading, setIsLoading]     = useState(false);
  const [attemptCount, setAttemptCount] = useState(0);
  const [showSuccess, setShowSuccess]   = useState(false);
  const [showHint, setShowHint]         = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Fetch levels on mount
  useEffect(() => {
    fetch(`${BACKEND}/api/levels?session_id=${sessionId}`)
      .then(r => r.json())
      .then(setLevels)
      .catch(console.error);
  }, [sessionId]);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const selectLevel = (level: Level) => {
    setActiveLevel(level);
    setMessages([
      {
        id: uuidv4(),
        role: "system",
        content: `Level ${level.level_id}: ${level.name} — ${level.difficulty}`,
        timestamp: new Date(),
      },
      {
        id: uuidv4(),
        role: "assistant",
        content: "Hello! How can I help you today?",
        timestamp: new Date(),
      },
    ]);
    setAttemptCount(0);
    setShowHint(false);
    setInput("");
  };

  const submitPrompt = async () => {
    if (!input.trim() || !activeLevel || isLoading) return;

    const userMsg: Message = {
      id: uuidv4(),
      role: "user",
      content: input.trim(),
      timestamp: new Date(),
    };

    setMessages(prev => [...prev, userMsg]);
    setInput("");
    setIsLoading(true);
    setAttemptCount(c => c + 1);

    try {
      const res = await fetch(`${BACKEND}/api/attempt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          level: activeLevel.level_id,
          prompt: userMsg.content,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Request failed");
      }

      const data: AttemptResponse = await res.json();

      const assistantMsg: Message = {
        id: uuidv4(),
        role: "assistant",
        content: data.llm_response,
        timestamp: new Date(),
        is_successful: data.is_successful,
        response_ms: data.response_ms,
      };

      setMessages(prev => [...prev, assistantMsg]);

      if (data.is_successful) {
        setShowSuccess(true);
        // Refresh levels to show completion
        fetch(`${BACKEND}/api/levels?session_id=${sessionId}`)
          .then(r => r.json())
          .then(setLevels);
      }
    } catch (err: any) {
      setMessages(prev => [
        ...prev,
        {
          id: uuidv4(),
          role: "system",
          content: `Error: ${err.message}`,
          timestamp: new Date(),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitPrompt();
    }
  };

  const nextLevel = () => {
    if (!activeLevel) return;
    const next = levels.find(l => l.level_id === activeLevel.level_id + 1);
    setShowSuccess(false);
    if (next) selectLevel(next);
  };

  const solvedCount = levels.filter(l => l.completed).length;

  return (
    <div className="h-screen bg-gray-950 text-white flex flex-col overflow-hidden">
      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-gray-800 bg-gray-900/80 backdrop-blur">
        <div className="flex items-center gap-3">
          <span className="text-xl">🔐</span>
          <div>
            <h1 className="font-bold text-white text-sm leading-none">LLM Security Lab</h1>
            <p className="text-xs text-gray-500">Prompt Injection CTF</p>
          </div>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-gray-400">
            <span className="text-emerald-400 font-bold">{solvedCount}</span>
            <span className="text-gray-600">/{levels.length}</span>
            <span className="text-gray-500 ml-1">solved</span>
          </span>
          <span className="font-mono text-xs text-gray-600 bg-gray-800 px-2 py-1 rounded border border-gray-700">
            {sessionId.slice(0, 8)}
          </span>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* ── Sidebar — Level Selection ─────────────────────────── */}
        <aside className="w-72 border-r border-gray-800 bg-gray-900/50 flex flex-col overflow-hidden">
          <div className="p-4 border-b border-gray-800">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              Challenge Levels
            </h2>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {levels.length === 0 ? (
              <div className="text-center text-gray-600 text-sm py-8">Loading levels…</div>
            ) : (
              levels.map(level => (
                <LevelCard
                  key={level.level_id}
                  level={level}
                  isActive={activeLevel?.level_id === level.level_id}
                  onClick={() => selectLevel(level)}
                />
              ))
            )}
          </div>

          {/* OWASP Reference */}
          <div className="p-4 border-t border-gray-800">
            <div className="bg-gray-800/50 rounded-lg p-3 border border-gray-700">
              <p className="text-xs text-gray-500 font-semibold mb-1">📚 REFERENCE</p>
              <a href="https://owasp.org/www-project-top-10-for-large-language-model-applications/"
                 target="_blank" rel="noopener noreferrer"
                 className="text-xs text-cyan-500 hover:text-cyan-300 transition-colors">
                OWASP LLM Top 10 →
              </a>
            </div>
          </div>
        </aside>

        {/* ── Main — Chat Interface ─────────────────────────────── */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {!activeLevel ? (
            // Empty state
            <div className="flex-1 flex items-center justify-center text-center p-8">
              <div>
                <div className="text-5xl mb-4">🛡️</div>
                <h2 className="text-xl font-bold text-gray-300 mb-2">
                  Select a Level to Begin
                </h2>
                <p className="text-gray-500 text-sm max-w-xs">
                  Each level challenges you to extract a secret from an AI
                  with progressively stronger guardrails.
                </p>
                <div className="mt-6 text-xs text-gray-600 font-mono space-y-1">
                  <p>Inspired by Gandalf · TensorTrust · HackAPrompt</p>
                  <p className="text-gray-700">OWASP LLM01 — Prompt Injection</p>
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* Level header */}
              <div className="px-5 py-3 border-b border-gray-800 bg-gray-900/30 flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-xs font-mono text-gray-500">LEVEL {activeLevel.level_id}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded border ${DIFFICULTY_COLORS[activeLevel.difficulty]}`}>
                      {activeLevel.difficulty}
                    </span>
                    {activeLevel.completed && (
                      <span className="text-xs text-emerald-400">✓ Solved</span>
                    )}
                  </div>
                  <h2 className="font-semibold text-white">{activeLevel.name}</h2>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-gray-500">{attemptCount} attempts</span>
                  <button
                    onClick={() => setShowHint(!showHint)}
                    className="text-xs px-3 py-1.5 rounded-lg border border-gray-700 text-gray-400
                               hover:border-amber-500/50 hover:text-amber-400 transition-colors">
                    💡 Hint
                  </button>
                </div>
              </div>

              {/* Hint banner */}
              {showHint && (
                <div className="mx-4 mt-3 px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-sm text-amber-300">
                  <span className="font-semibold">Hint: </span>{activeLevel.hint}
                </div>
              )}

              {/* Chat messages */}
              <div className="flex-1 overflow-y-auto p-5 space-y-1">
                {messages.map(msg => (
                  <ChatBubble key={msg.id} msg={msg} />
                ))}
                {isLoading && (
                  <div className="flex gap-3 mb-4">
                    <div className="w-8 h-8 rounded-lg bg-gray-700 flex items-center justify-center text-sm font-bold text-gray-300">
                      AI
                    </div>
                    <div className="bg-gray-800 border border-gray-700 px-4 py-3 rounded-2xl rounded-tl-sm">
                      <div className="flex gap-1">
                        <span className="w-2 h-2 bg-gray-500 rounded-full animate-bounce [animation-delay:0ms]"/>
                        <span className="w-2 h-2 bg-gray-500 rounded-full animate-bounce [animation-delay:150ms]"/>
                        <span className="w-2 h-2 bg-gray-500 rounded-full animate-bounce [animation-delay:300ms]"/>
                      </div>
                    </div>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              {/* Input area */}
              <div className="p-4 border-t border-gray-800 bg-gray-900/50">
                <div className="flex gap-3">
                  <textarea
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Enter your prompt injection attempt…"
                    rows={2}
                    disabled={isLoading}
                    className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm
                               text-white placeholder-gray-600 resize-none outline-none
                               focus:border-cyan-600 transition-colors disabled:opacity-50"
                  />
                  <button
                    onClick={submitPrompt}
                    disabled={isLoading || !input.trim()}
                    className="px-5 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-700
                               disabled:text-gray-500 text-white font-semibold rounded-xl
                               transition-colors text-sm self-end">
                    {isLoading ? "…" : "Send"}
                  </button>
                </div>
                <p className="text-xs text-gray-600 mt-2">
                  Enter sends • Shift+Enter for newline • Try prompt injection, roleplay, translation tricks
                </p>
              </div>
            </>
          )}
        </main>
      </div>

      {/* ── Success Modal ─────────────────────────────────────────── */}
      {showSuccess && activeLevel && (
        <SuccessModal
          level={activeLevel}
          attempts={attemptCount}
          onClose={() => setShowSuccess(false)}
          onNextLevel={activeLevel.level_id < levels.length ? nextLevel : undefined}
        />
      )}
    </div>
  );
}
