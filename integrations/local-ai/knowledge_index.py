from __future__ import annotations

import json
import math
import re
import sqlite3
from array import array
from pathlib import Path
from typing import Any


class KnowledgeIndex:
    """A small, versioned local index; business task truth remains outside this adapter."""

    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def upsert(
        self,
        *,
        name: str,
        index_version: str,
        chunk_version: str,
        model_revision: str,
        documents: list[dict[str, Any]],
        vectors: list[list[float]],
        replace: bool = False,
    ) -> dict[str, Any]:
        if len(documents) != len(vectors):
            raise ValueError("documents and vectors must have the same length")
        if not documents or len(documents) > 128:
            raise ValueError("documents must contain 1 to 128 items")
        dimensions = len(vectors[0])
        if dimensions == 0 or any(len(vector) != dimensions for vector in vectors):
            raise ValueError("all vectors must have the same non-zero dimensions")

        path = self._path(name)
        if replace and path.exists():
            path.unlink()
        with self._connect(path) as connection:
            self._create_schema(connection)
            current = self._read_meta(connection)
            expected = {
                "index_version": required_identifier(index_version, "indexVersion"),
                "chunk_version": required_identifier(chunk_version, "chunkVersion"),
                "model_revision": model_revision,
                "dimensions": str(dimensions),
            }
            if current and any(current.get(key) != value for key, value in expected.items()):
                raise ValueError("index metadata mismatch; use replace=true or a new indexVersion")
            connection.executemany(
                "INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)",
                expected.items(),
            )
            for document, vector in zip(documents, vectors):
                document_id = required_identifier(str(document.get("id") or ""), "document id")
                text = str(document.get("text") or "").strip()
                if not text:
                    raise ValueError(f"document {document_id} text is required")
                metadata = document.get("metadata") or {}
                if not isinstance(metadata, dict):
                    raise ValueError(f"document {document_id} metadata must be an object")
                access_scope = str(document.get("accessScope") or "local-private")
                connection.execute(
                    """
                    INSERT OR REPLACE INTO chunks(document_id, text, metadata_json, access_scope, vector)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        document_id,
                        text[:100_000],
                        json.dumps(metadata, ensure_ascii=False, sort_keys=True),
                        access_scope[:200],
                        vector_blob(vector),
                    ),
                )
            connection.commit()
            count = connection.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        return {
            "indexName": name,
            "indexVersion": index_version,
            "chunkVersion": chunk_version,
            "dimensions": dimensions,
            "documentCount": count,
            "artifactPath": str(path),
        }

    def candidates(
        self,
        *,
        name: str,
        index_version: str,
        query_vector: list[float],
        access_scopes: list[str],
        top_k: int,
    ) -> list[dict[str, Any]]:
        path = self._path(name)
        if not path.is_file():
            raise ValueError(f"knowledge index does not exist: {name}")
        with self._connect(path) as connection:
            meta = self._read_meta(connection)
            if meta.get("index_version") != index_version:
                raise ValueError("indexVersion does not match the stored index")
            if int(meta.get("dimensions", "0")) != len(query_vector):
                raise ValueError("query embedding dimensions do not match the index")
            params: list[Any] = []
            where = ""
            if access_scopes:
                placeholders = ",".join("?" for _ in access_scopes)
                where = f"WHERE access_scope IN ({placeholders})"
                params.extend(access_scopes)
            rows = connection.execute(
                f"SELECT document_id, text, metadata_json, access_scope, vector FROM chunks {where}",
                params,
            ).fetchall()
        query = normalized(query_vector)
        scored = []
        for row in rows:
            score = sum(left * right for left, right in zip(query, normalized(blob_vector(row[4]))))
            scored.append(
                {
                    "documentId": row[0],
                    "text": row[1],
                    "metadata": json.loads(row[2]),
                    "accessScope": row[3],
                    "vectorScore": score,
                }
            )
        return sorted(scored, key=lambda item: item["vectorScore"], reverse=True)[:top_k]

    def _path(self, name: str) -> Path:
        safe_name = required_identifier(name, "indexName")
        return self.root / f"{safe_name}.sqlite3"

    @staticmethod
    def _connect(path: Path) -> sqlite3.Connection:
        return sqlite3.connect(path, timeout=30)

    @staticmethod
    def _create_schema(connection: sqlite3.Connection) -> None:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chunks (
                document_id TEXT PRIMARY KEY,
                text TEXT NOT NULL,
                metadata_json TEXT NOT NULL,
                access_scope TEXT NOT NULL,
                vector BLOB NOT NULL
            );
            CREATE INDEX IF NOT EXISTS chunks_access_scope ON chunks(access_scope);
            """
        )

    @staticmethod
    def _read_meta(connection: sqlite3.Connection) -> dict[str, str]:
        try:
            return dict(connection.execute("SELECT key, value FROM metadata").fetchall())
        except sqlite3.OperationalError:
            return {}


def required_identifier(value: str, field: str) -> str:
    candidate = value.strip()
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,120}", candidate):
        raise ValueError(f"{field} must use letters, numbers, dot, underscore or dash")
    return candidate


def normalized(values: list[float]) -> list[float]:
    magnitude = math.sqrt(sum(value * value for value in values))
    if magnitude == 0:
        raise ValueError("zero-length embedding cannot be indexed or searched")
    return [value / magnitude for value in values]


def vector_blob(values: list[float]) -> bytes:
    return array("f", normalized(values)).tobytes()


def blob_vector(value: bytes) -> list[float]:
    output = array("f")
    output.frombytes(value)
    return output.tolist()
