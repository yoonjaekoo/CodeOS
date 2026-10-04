"""Pydantic schemas for graph extraction (structured output)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

NodeType = Literal["idea", "question", "objection", "problem", "decision", "conclusion", "evidence"]
EdgeType = Literal[
    "supports", "contradicts", "refines", "derives_from", "related_to", "duplicates", "verifies"
]
NodeStatus = Literal["active", "refined", "merged", "dropped"]


class NodeOut(BaseModel):
    id: str = Field(default="", description="Stable id if refining an existing node, else '' for new")
    type: NodeType = "idea"
    label: str = Field(max_length=120)
    description: str = Field(default="", max_length=500)
    status: NodeStatus = "active"
    source_messages: list[str] = Field(default_factory=list)


class EdgeOut(BaseModel):
    id: str = ""
    source: str
    target: str
    type: EdgeType = "related_to"


class GraphSnapshot(BaseModel):
    nodes: list[NodeOut] = Field(default_factory=list, max_length=30)
    edges: list[EdgeOut] = Field(default_factory=list, max_length=40)
    summary: str = ""
    open_questions: list[str] = Field(default_factory=list)
    conflicts: list[str] = Field(default_factory=list)


GRAPH_JSON_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "nodes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "type": {
                        "type": "string",
                        "enum": [
                            "idea",
                            "question",
                            "objection",
                            "problem",
                            "decision",
                            "conclusion",
                            "evidence",
                        ],
                    },
                    "label": {"type": "string"},
                    "description": {"type": "string"},
                    "status": {"type": "string", "enum": ["active", "refined", "merged", "dropped"]},
                    "source_messages": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["label", "type"],
            },
        },
        "edges": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "source": {"type": "string"},
                    "target": {"type": "string"},
                    "type": {
                        "type": "string",
                        "enum": [
                            "supports",
                            "contradicts",
                            "refines",
                            "derives_from",
                            "related_to",
                            "duplicates",
                            "verifies",
                        ],
                    },
                },
                "required": ["source", "target", "type"],
            },
        },
        "summary": {"type": "string"},
        "open_questions": {"type": "array", "items": {"type": "string"}},
        "conflicts": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["nodes", "edges"],
}
