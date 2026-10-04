"""Backwards-compatible alias: 'discussion' == branch in Nodus.

The spec's REST surface talks about /discussions/{id}; internally a
discussion is a Branch row. This module re-exports Branch so that
`app.models.discussion` imports work and Phase-1 structure matches spec.
"""

from app.models.branch import Branch  # noqa: F401

__all__ = ["Branch"]
