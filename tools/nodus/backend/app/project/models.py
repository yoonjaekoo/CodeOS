"""Pydantic schema for the structured Project Context produced by the analyzer."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class ProjectInfo(BaseModel):
    name: str = ""
    description: str = Field(default="", max_length=600)
    purpose: str = Field(default="", max_length=600)


class StackInfo(BaseModel):
    languages: list[str] = Field(default_factory=list)
    frameworks: list[str] = Field(default_factory=list)
    database: list[str] = Field(default_factory=list)
    infrastructure: list[str] = Field(default_factory=list)


class ArchitectureInfo(BaseModel):
    overview: str = Field(default="", max_length=1200)
    components: list[str] = Field(default_factory=list, max_length=15)
    data_flow: list[str] = Field(default_factory=list, max_length=15)


class ImportantFile(BaseModel):
    path: str
    purpose: str = Field(default="", max_length=200)
    importance: Literal["high", "medium", "low"] = "high"


class DatabaseInfo(BaseModel):
    technology: str = ""
    schema_summary: str = Field(default="", max_length=800)
    important_entities: list[str] = Field(default_factory=list, max_length=15)


class ProjectContext(BaseModel):
    project: ProjectInfo = Field(default_factory=ProjectInfo)
    stack: StackInfo = Field(default_factory=StackInfo)
    architecture: ArchitectureInfo = Field(default_factory=ArchitectureInfo)
    entry_points: list[str] = Field(default_factory=list, max_length=10)
    important_files: list[ImportantFile] = Field(default_factory=list, max_length=20)
    apis: list[str] = Field(default_factory=list, max_length=15)
    database: DatabaseInfo = Field(default_factory=DatabaseInfo)
    workflows: list[str] = Field(default_factory=list, max_length=10)
    technical_concerns: list[str] = Field(default_factory=list, max_length=10)
    development_notes: list[str] = Field(default_factory=list, max_length=10)
    context_summary: str = Field(default="", max_length=1000)


def project_context_schema() -> dict:
    """JSON schema for structured output (stripped of pydantic-only metadata)."""
    return ProjectContext.model_json_schema()
