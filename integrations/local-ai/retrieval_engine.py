from __future__ import annotations

from dataclasses import dataclass
import gc
from threading import Lock
from typing import Any


@dataclass
class RetrievalPaths:
    embedding: str
    reranker: str


class RetrievalEngine:
    """Loads retrieval models on demand and can release them while idle."""

    def __init__(self, paths: RetrievalPaths):
        self.paths = paths
        self._embedding_model: Any = None
        self._embedding_tokenizer: Any = None
        self._reranker_model: Any = None
        self._reranker_tokenizer: Any = None
        self._lock = Lock()

    @property
    def embedding_loaded(self) -> bool:
        return self._embedding_model is not None

    @property
    def reranker_loaded(self) -> bool:
        return self._reranker_model is not None

    def load_embedding(self) -> None:
        if self.embedding_loaded:
            return
        from mlx_embeddings import load

        with self._lock:
            if not self.embedding_loaded:
                self._embedding_model, self._embedding_tokenizer = load(self.paths.embedding)

    def unload_embedding(self) -> bool:
        with self._lock:
            was_loaded = self.embedding_loaded
            self._embedding_model = None
            self._embedding_tokenizer = None
        if was_loaded:
            release_mlx_memory()
        return was_loaded

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts or len(texts) > 128:
            raise ValueError("texts must contain 1 to 128 items")
        self.load_embedding()
        import mlx.core as mx
        from mlx_embeddings import generate

        with self._lock:
            output = generate(
                self._embedding_model,
                self._embedding_tokenizer,
                texts=texts,
                max_length=8192,
                padding=True,
                truncation=True,
            )
            mx.eval(output.text_embeds)
            return output.text_embeds.tolist()

    def _load_reranker(self) -> None:
        if self.reranker_loaded:
            return
        from mlx_lm import load

        with self._lock:
            if not self.reranker_loaded:
                self._reranker_model, self._reranker_tokenizer = load(self.paths.reranker)

    def unload_reranker(self) -> bool:
        with self._lock:
            was_loaded = self.reranker_loaded
            self._reranker_model = None
            self._reranker_tokenizer = None
        if was_loaded:
            release_mlx_memory()
        return was_loaded

    def rerank(self, query: str, documents: list[str], instruct: str | None = None) -> list[dict[str, Any]]:
        if not query.strip():
            raise ValueError("query is required")
        if not documents or len(documents) > 100:
            raise ValueError("documents must contain 1 to 100 items")
        self._load_reranker()
        import mlx.core as mx

        tokenizer = getattr(self._reranker_tokenizer, "_tokenizer", self._reranker_tokenizer)
        instruction = instruct or "Given a web search query, retrieve relevant passages that answer the query"
        prefix = (
            '<|im_start|>system\nJudge whether the Document meets the requirements '
            'based on the Query and the Instruct provided. Note that the answer can '
            'only be "yes" or "no".<|im_end|>\n<|im_start|>user\n'
        )
        suffix = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
        yes_id = tokenizer.convert_tokens_to_ids("yes")
        no_id = tokenizer.convert_tokens_to_ids("no")
        prefix_ids = tokenizer.encode(prefix, add_special_tokens=False)
        suffix_ids = tokenizer.encode(suffix, add_special_tokens=False)
        scored: list[dict[str, Any]] = []
        with self._lock:
            for index, document in enumerate(documents):
                content = f"<Instruct>: {instruction}\n<Query>: {query}\n<Document>: {document}"
                ids = prefix_ids + tokenizer.encode(content, add_special_tokens=False) + suffix_ids
                logits = self._reranker_model(mx.array([ids]))[:, -1, :]
                pair = mx.stack([logits[0, no_id], logits[0, yes_id]])
                score = float(mx.exp((pair - mx.logsumexp(pair))[1]))
                scored.append({"index": index, "document": document, "score": score})
        return sorted(scored, key=lambda row: row["score"], reverse=True)


def release_mlx_memory() -> None:
    gc.collect()
    try:
        import mlx.core as mx

        clear_cache = getattr(mx, "clear_cache", None)
        if callable(clear_cache):
            clear_cache()
    except ImportError:
        pass
