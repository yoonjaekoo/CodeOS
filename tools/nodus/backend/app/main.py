"""Nodus backend — FastAPI app."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import branches, discussions, execution, fs, projects, stream
from app.config import settings
from app.database import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(title="Nodus API", version="0.1.0", lifespan=lifespan)

origins = settings.cors_origin_list
if "*" in origins:
    origins = ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(projects.router)
app.include_router(discussions.router)
app.include_router(branches.router)
app.include_router(stream.router)
app.include_router(fs.router)
app.include_router(execution.router)


@app.get("/api/health")
async def health():
    return {"status": "ok", "llm_configured": bool(settings.llm_api_key)}
