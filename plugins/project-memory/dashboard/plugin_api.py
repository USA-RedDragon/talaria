"""project-memory routes for hermes-hub, mounted at /api/plugins/project-memory/ behind dashboard sign-in: the
projects, their skills, the staged project writes in Hermes's memory approval queue, and one project's notes in the shape of the device plugin's /memory with the same four changes."""
from __future__ import annotations

import asyncio
import importlib.util
import sys
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

router = APIRouter()
_CORE = "hermes_project_memory_core"


def _core():
    module = sys.modules.get(_CORE)
    if module is None:
        spec = importlib.util.spec_from_file_location(_CORE, Path(__file__).parent.parent / "core.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[_CORE] = module
        spec.loader.exec_module(module)
    return module


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": code, "message": message}, status_code=status)


async def _call(fn, *args):
    core = _core()
    try:
        return await asyncio.to_thread(fn, *args)
    except core.Refused as exc:
        return _error(exc.status, exc.code, exc.message)


async def _body(request: Request) -> Optional[dict]:
    try:
        body = await request.json()
    except Exception:
        return None
    return body if isinstance(body, dict) else None


@router.get("/projects")
async def projects():
    return await _call(_core().list_projects)


@router.get("/pending")
async def pending():
    return await _call(_core().pending)


@router.get("/projects/{project_id}")
async def project_notes(project_id: str):
    return await _call(_core().notes, project_id)


@router.get("/projects/{project_id}/skills")
async def project_skills(project_id: str):
    return await _call(_core().project_skills, project_id)


@router.get("/projects/{project_id}/skills/{name:path}")
async def project_skill(project_id: str, name: str):
    return await _call(_core().project_skill, project_id, name)


@router.delete("/projects/{project_id}/skills/{name:path}")
async def project_skill_delete(project_id: str, name: str):
    return await _call(_core().delete_project_skill, project_id, name)


_KINDS = {"topics": "topic", "paths": "path"}


@router.get("/projects/{project_id}/{kind}")
async def project_docs(project_id: str, kind: str):
    if kind not in _KINDS:
        return _error(404, "not_found", "no such route")
    return await _call(_core().docs, project_id, _KINDS[kind])


@router.get("/projects/{project_id}/{kind}/{name}")
async def project_doc(project_id: str, kind: str, name: str):
    if kind not in _KINDS:
        return _error(404, "not_found", "no such route")
    return await _call(_core().doc, project_id, _KINDS[kind], name)


@router.put("/projects/{project_id}/{kind}/{name}")
async def project_doc_put(project_id: str, kind: str, name: str, request: Request):
    if kind not in _KINDS:
        return _error(404, "not_found", "no such route")
    body = await _body(request)
    if body is None:
        return _error(400, "bad_request", "the body must be a JSON object")
    return await _call(_core().put_doc, project_id, _KINDS[kind], name, body)


@router.delete("/projects/{project_id}/{kind}/{name}")
async def project_doc_delete(project_id: str, kind: str, name: str):
    if kind not in _KINDS:
        return _error(404, "not_found", "no such route")
    return await _call(_core().delete_doc, project_id, _KINDS[kind], name)


@router.post("/projects/{project_id}/memory/{op}")
async def project_change(project_id: str, op: str, request: Request):
    core = _core()
    body = await _body(request) or {}
    if op == "add":
        return await _call(core.add, project_id, body.get("content"))
    if op == "edit":
        return await _call(core.edit, project_id, body.get("entry"), body.get("content"))
    if op == "remove":
        return await _call(core.remove, project_id, body.get("entry"))
    if op == "replace":
        return await _call(core.replace_all, project_id, body.get("text"), body.get("base"))
    return _error(404, "not_found", "unknown memory operation")
