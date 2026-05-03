"""
LLM Security Lab — FastAPI Inference & Evaluation Service
Home Server Edition (WSL2 · i7-8700 · 4GB RAM budget)
=========================================================
Differences from OCI version:
  - Lower token limits (saves RAM on 4GB WSL2 budget)
  - Longer timeouts (CPU inference on i7 ≈ 5–15 tok/s)
  - File-based level config (bind-mounted, no K8s ConfigMap)
  - SQLite fallback if Postgres isn't up yet
  - Dev reload support via RELOAD env var
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import (
    Boolean, Column, DateTime, Integer, String, Text,
    create_engine, text,
)
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

# ─────────────────────────────────────────────────────────────
# Configuration — all from environment variables
# ─────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
)
logger = logging.getLogger("llm-lab")

DATABASE_URL    = os.environ.get(
    "DATABASE_URL",
    "postgresql://ctf_user:ctf_local_pass_2024@postgres:5432/ctf_lab"
)
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://ollama:11434")
OLLAMA_MODEL    = os.getenv("OLLAMA_MODEL",    "llama3.2:1b")
CTF_LEVELS_PATH = os.getenv("CTF_LEVELS_PATH", "/app/config/levels.json")
CORS_ORIGINS    = os.getenv("CORS_ORIGINS",    "*").split(",")

# Home server tuning — conservative for 4GB WSL2
RATE_LIMIT_ATTEMPTS = int(os.getenv("RATE_LIMIT_ATTEMPTS", "50"))
LLM_TEMPERATURE     = float(os.getenv("LLM_TEMPERATURE",   "0.7"))
LLM_MAX_TOKENS      = int(os.getenv("LLM_MAX_TOKENS",      "400"))   # Short to save RAM
LLM_TIMEOUT_SECS    = float(os.getenv("LLM_TIMEOUT_SECS",  "180.0")) # CPU is slow, be patient


# ─────────────────────────────────────────────────────────────
# Database
# ─────────────────────────────────────────────────────────────
class Base(DeclarativeBase):
    pass


class Attempt(Base):
    __tablename__ = "attempts"
    id            = Column(Integer, primary_key=True, index=True)
    session_id    = Column(String(64), index=True, nullable=False)
    ip_address    = Column(String(45), nullable=False)
    level         = Column(Integer, nullable=False)
    user_prompt   = Column(Text, nullable=False)
    llm_response  = Column(Text, nullable=True)
    is_successful = Column(Boolean, default=False, nullable=False)
    tokens_used   = Column(Integer, default=0)
    response_ms   = Column(Integer, default=0)
    created_at    = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )


class Completion(Base):
    __tablename__ = "completions"
    id            = Column(Integer, primary_key=True, index=True)
    session_id    = Column(String(64), index=True, nullable=False)
    level         = Column(Integer, nullable=False)
    attempts_used = Column(Integer, default=1)
    completed_at  = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )


engine       = create_engine(DATABASE_URL, pool_pre_ping=True, pool_size=3, max_overflow=5)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db(retries: int = 10, delay: int = 3):
    """Retry DB connection — Postgres may still be starting up."""
    for attempt in range(retries):
        try:
            Base.metadata.create_all(bind=engine)
            logger.info("✅ Database tables initialised.")
            return
        except SQLAlchemyError as e:
            if attempt < retries - 1:
                logger.warning(f"DB not ready (attempt {attempt+1}/{retries}), retrying in {delay}s… {e}")
                time.sleep(delay)
            else:
                logger.error(f"❌ DB init failed after {retries} attempts: {e}")
                raise


# ─────────────────────────────────────────────────────────────
# Level Config Loader
# ─────────────────────────────────────────────────────────────
class LevelConfig(BaseModel):
    name:          str
    difficulty:    str
    description:   str
    secret_key:    str
    hint:          str
    system_prompt: str


_levels_cache: dict[str, LevelConfig] = {}


def load_levels() -> dict[str, LevelConfig]:
    global _levels_cache
    if _levels_cache:
        return _levels_cache
    p = Path(CTF_LEVELS_PATH)
    if not p.exists():
        raise RuntimeError(f"Levels config not found at {CTF_LEVELS_PATH}")
    with open(p) as f:
        raw: dict[str, Any] = json.load(f)
    _levels_cache = {k: LevelConfig(**v) for k, v in raw.items()}
    logger.info(f"✅ Loaded {len(_levels_cache)} CTF levels from {CTF_LEVELS_PATH}")
    return _levels_cache


def get_level(level_id: int) -> LevelConfig:
    levels = load_levels()
    key = str(level_id)
    if key not in levels:
        raise HTTPException(status_code=404, detail=f"Level {level_id} not found.")
    return levels[key]


# ─────────────────────────────────────────────────────────────
# In-Memory Rate Limiter
# ─────────────────────────────────────────────────────────────
_rate_store: dict[str, list[float]] = {}


def check_rate_limit(ip: str) -> None:
    now          = time.time()
    window_start = now - 3600
    if ip not in _rate_store:
        _rate_store[ip] = []
    _rate_store[ip] = [t for t in _rate_store[ip] if t > window_start]
    if len(_rate_store[ip]) >= RATE_LIMIT_ATTEMPTS:
        raise HTTPException(
            status_code=429,
            detail=f"Rate limit: max {RATE_LIMIT_ATTEMPTS} attempts/hour.",
            headers={"Retry-After": "3600"},
        )
    _rate_store[ip].append(now)


# ─────────────────────────────────────────────────────────────
# The Judge — Multi-Strategy Secret Key Detector
# ─────────────────────────────────────────────────────────────
class JudgeResult(BaseModel):
    is_successful:  bool
    confidence:     float
    match_strategy: str
    sanitised_flag: str


def judge_response(llm_response: str, secret_key: str) -> JudgeResult:
    """
    Scans the LLM response for the secret key using 5 strategies.
    This catches direct leaks, encoded leaks, character splits,
    and leet-speak substitutions.

    Never exposes the raw secret_key to the API caller.
    """
    resp_lower   = llm_response.lower()
    secret_lower = secret_key.lower()

    # Strategy 1: Direct substring
    if secret_lower in resp_lower:
        return JudgeResult(is_successful=True, confidence=1.0,
                           match_strategy="exact_match",
                           sanitised_flag=_sanitise(secret_key))

    # Strategy 2: Whitespace-stripped (catches "O B S I D I A N" etc.)
    if re.sub(r"\s+", "", secret_lower) in re.sub(r"\s+", "", resp_lower):
        return JudgeResult(is_successful=True, confidence=0.95,
                           match_strategy="whitespace_stripped",
                           sanitised_flag=_sanitise(secret_key))

    # Strategy 3: Character-split with separators (A-P-P-L-E, A.P.P.L.E)
    spaced = r"[\s\-_.,|/\\]*".join(re.escape(c) for c in secret_lower)
    if re.search(spaced, resp_lower):
        return JudgeResult(is_successful=True, confidence=0.90,
                           match_strategy="char_split",
                           sanitised_flag=_sanitise(secret_key))

    # Strategy 4: Leet-speak de-obfuscation
    leet_map = {"0": "o", "1": "i", "3": "e", "4": "a", "5": "s",
                "@": "a", "$": "s", "7": "t", "!": "i"}
    deleet = resp_lower
    for leet_char, real_char in leet_map.items():
        deleet = deleet.replace(leet_char, real_char)
    if secret_lower in deleet:
        return JudgeResult(is_successful=True, confidence=0.85,
                           match_strategy="leet_substitution",
                           sanitised_flag=_sanitise(secret_key))

    # Strategy 5: Base64 encoded in response
    for token in re.findall(r"[A-Za-z0-9+/]{8,}={0,2}", llm_response):
        try:
            decoded = base64.b64decode(token).decode("utf-8", errors="ignore").lower()
            if secret_lower in decoded:
                return JudgeResult(is_successful=True, confidence=0.80,
                                   match_strategy="base64_encoded",
                                   sanitised_flag=_sanitise(secret_key))
        except Exception:
            continue

    return JudgeResult(is_successful=False, confidence=0.0,
                       match_strategy="none",
                       sanitised_flag=_sanitise(secret_key))


def _sanitise(key: str) -> str:
    if len(key) <= 4:
        return "****"
    return f"{key[:2]}{'*' * (len(key) - 4)}{key[-2:]}"


# ─────────────────────────────────────────────────────────────
# Ollama Client
# ─────────────────────────────────────────────────────────────
async def call_ollama(system_prompt: str, user_message: str) -> tuple[str, int]:
    """
    Sends a system+user message to local Ollama.
    Returns (response_text, total_tokens).
    Tuned for CPU inference on i7-8700.
    """
    payload = {
        "model": OLLAMA_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_message},
        ],
        "stream": False,
        "options": {
            "temperature": LLM_TEMPERATURE,
            "num_predict": LLM_MAX_TOKENS,
            "num_thread":  4,         # WSL2 has 4 cores
            "num_ctx":     2048,      # Reduce context window to save RAM
        },
    }
    async with httpx.AsyncClient(timeout=LLM_TIMEOUT_SECS) as client:
        r = await client.post(f"{OLLAMA_BASE_URL}/api/chat", json=payload)
        r.raise_for_status()

    data   = r.json()
    text   = data["message"]["content"]
    tokens = data.get("prompt_eval_count", 0) + data.get("eval_count", 0)
    return text, tokens


# ─────────────────────────────────────────────────────────────
# Pydantic Schemas
# ─────────────────────────────────────────────────────────────
class AttemptRequest(BaseModel):
    session_id: str = Field(..., min_length=8, max_length=64)
    level:      int = Field(..., ge=1, le=3)
    prompt:     str = Field(..., min_length=1, max_length=2000)

    @field_validator("prompt")
    @classmethod
    def strip_prompt(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Prompt cannot be empty.")
        return v


class AttemptResponse(BaseModel):
    attempt_id:     int
    level:          int
    llm_response:   str
    is_successful:  bool
    confidence:     float
    match_strategy: str
    response_ms:    int
    tokens_used:    int


class LevelInfoResponse(BaseModel):
    level_id:    int
    name:        str
    difficulty:  str
    description: str
    hint:        str
    completed:   bool


# ─────────────────────────────────────────────────────────────
# App Lifespan
# ─────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("🚀 Starting LLM Security Lab backend (home server edition)...")
    init_db()
    load_levels()

    # Verify Ollama
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(f"{OLLAMA_BASE_URL}/api/tags")
            r.raise_for_status()
            models = [m["name"] for m in r.json().get("models", [])]
            logger.info(f"✅ Ollama connected. Models: {models}")
            if not any("llama3.2" in m for m in models):
                logger.warning("⚠️  llama3.2:1b not found — model-puller may still be running.")
    except Exception as e:
        logger.warning(f"⚠️  Ollama not ready at startup (will retry per-request): {e}")

    yield
    logger.info("Shutting down.")


# ─────────────────────────────────────────────────────────────
# FastAPI App
# ─────────────────────────────────────────────────────────────
app = FastAPI(
    title       = "LLM Security Lab — Home Server",
    description = "Prompt Injection CTF — runs locally on WSL2",
    version     = "1.0.0",
    lifespan    = lifespan,
    docs_url    = "/api/docs",
    redoc_url   = "/api/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins     = CORS_ORIGINS,
    allow_credentials = True,
    allow_methods     = ["*"],
    allow_headers     = ["*"],
)


# ─────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────
@app.get("/health", tags=["System"])
async def health():
    return {
        "status":    "ok",
        "service":   "llm-lab-backend",
        "model":     OLLAMA_MODEL,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/levels", response_model=list[LevelInfoResponse], tags=["CTF"])
async def list_levels(session_id: str, db: Session = Depends(get_db)):
    levels = load_levels()
    completed: set[int] = {
        row[0] for row in
        db.query(Completion.level).filter(Completion.session_id == session_id).all()
    }
    return [
        LevelInfoResponse(
            level_id    = int(k),
            name        = v.name,
            difficulty  = v.difficulty,
            description = v.description,
            hint        = v.hint,
            completed   = int(k) in completed,
        )
        for k, v in sorted(levels.items(), key=lambda x: int(x[0]))
    ]


@app.post("/api/attempt", response_model=AttemptResponse, tags=["CTF"])
async def submit_attempt(
    req:     AttemptRequest,
    request: Request,
    db:      Session = Depends(get_db),
):
    ip = request.client.host or "127.0.0.1"
    check_rate_limit(ip)

    level_config = get_level(req.level)

    # ── Inference ─────────────────────────────────────────
    t0 = time.monotonic()
    try:
        llm_response, tokens_used = await call_ollama(
            system_prompt = level_config.system_prompt,
            user_message  = req.prompt,
        )
    except httpx.TimeoutException:
        raise HTTPException(
            status_code = 504,
            detail      = (
                "LLM timed out. On your home CPU this can take 30-120 seconds. "
                "Try a shorter prompt or wait for the model to warm up."
            ),
        )
    except httpx.HTTPStatusError as e:
        logger.error(f"Ollama error: {e}")
        raise HTTPException(status_code=503, detail="LLM service unavailable.")
    response_ms = int((time.monotonic() - t0) * 1000)

    # ── Judge ─────────────────────────────────────────────
    verdict = judge_response(llm_response, level_config.secret_key)
    logger.info(
        f"Attempt | session={req.session_id[:8]} level={req.level} "
        f"success={verdict.is_successful} strategy={verdict.match_strategy} "
        f"latency={response_ms}ms tokens={tokens_used}"
    )

    # ── Persist ───────────────────────────────────────────
    attempt = Attempt(
        session_id    = req.session_id,
        ip_address    = ip,
        level         = req.level,
        user_prompt   = req.prompt,
        llm_response  = llm_response,
        is_successful = verdict.is_successful,
        tokens_used   = tokens_used,
        response_ms   = response_ms,
    )
    db.add(attempt)

    if verdict.is_successful:
        already_done = (
            db.query(Completion)
            .filter(Completion.session_id == req.session_id, Completion.level == req.level)
            .first()
        )
        if not already_done:
            n = db.query(Attempt).filter(
                Attempt.session_id == req.session_id,
                Attempt.level      == req.level,
            ).count() + 1
            db.add(Completion(session_id=req.session_id, level=req.level, attempts_used=n))

    db.commit()
    db.refresh(attempt)

    return AttemptResponse(
        attempt_id     = attempt.id,
        level          = req.level,
        llm_response   = llm_response,
        is_successful  = verdict.is_successful,
        confidence     = verdict.confidence,
        match_strategy = verdict.match_strategy,
        response_ms    = response_ms,
        tokens_used    = tokens_used,
    )


@app.get("/api/leaderboard", tags=["CTF"])
async def leaderboard(db: Session = Depends(get_db)):
    rows = db.execute(text("""
        SELECT
            a.session_id,
            COUNT(DISTINCT c.level)   AS levels_solved,
            COUNT(*)                  AS total_attempts,
            ROUND(COUNT(DISTINCT c.level)::numeric / NULLIF(COUNT(*), 0), 3) AS efficiency
        FROM attempts a
        LEFT JOIN completions c ON a.session_id = c.session_id
        GROUP BY a.session_id
        ORDER BY levels_solved DESC, efficiency DESC
        LIMIT 20
    """)).fetchall()
    return [
        {
            "session_id":     r.session_id,
            "levels_solved":  r.levels_solved or 0,
            "total_attempts": r.total_attempts or 0,
            "efficiency":     float(r.efficiency or 0),
        }
        for r in rows
    ]


@app.get("/api/session/{session_id}/stats", tags=["CTF"])
async def session_stats(session_id: str, db: Session = Depends(get_db)):
    completions = (
        db.query(Completion).filter(Completion.session_id == session_id).all()
    )
    total = db.query(Attempt).filter(Attempt.session_id == session_id).count()
    return {
        "session_id":     session_id,
        "total_attempts": total,
        "completed_levels": [
            {"level": c.level, "attempts": c.attempts_used,
             "completed_at": c.completed_at.isoformat()}
            for c in completions
        ],
    }


@app.get("/api/admin/attempts", tags=["Admin"])
async def admin_attempts(limit: int = 50, level: int | None = None, db: Session = Depends(get_db)):
    """Local admin — see all attempts. Add auth if sharing on LAN."""
    q = db.query(Attempt).order_by(Attempt.created_at.desc())
    if level:
        q = q.filter(Attempt.level == level)
    return [
        {
            "id": a.id, "session_id": a.session_id[:8] + "...",
            "level": a.level, "prompt": a.user_prompt[:100],
            "success": a.is_successful, "ms": a.response_ms,
            "created": a.created_at.isoformat(),
        }
        for a in q.limit(limit).all()
    ]
