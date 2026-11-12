
import time

from pinecone import Pinecone, ServerlessSpec
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_pinecone import PineconeVectorStore

from app.core.config import get_settings

settings = get_settings()

_embeddings = None
_vectorstore = None

EMBEDDING_DIMENSIONS = {
    "text-embedding-3-small": 1536,
    "text-embedding-3-large": 3072,
    "text-embedding-ada-002": 1536,
    "all-minilm-l6-v2": 384,
}


def get_embedding_dimension(model_name: str | None = None) -> int:
    name = (
        model_name or settings.embedding_model
        or "sentence-transformers/all-MiniLM-L6-v2"
    ).strip()

    normalized = name.lower()

    if normalized in EMBEDDING_DIMENSIONS:
        return EMBEDDING_DIMENSIONS[normalized]

    if "all-minilm" in normalized:
        return 384

    raise ValueError(
        f"Unsupported embedding model: {name}. "
        "Add its dimension to EMBEDDING_DIMENSIONS."
    )


def get_embeddings():
    global _embeddings

    if _embeddings is None:
        model_name = (
            settings.embedding_model
            or "sentence-transformers/all-MiniLM-L6-v2"
        )

        _embeddings = HuggingFaceEmbeddings(
            model_name=model_name,
            model_kwargs={"device": "cpu"},
            encode_kwargs={"normalize_embeddings": True},
        )

    return _embeddings


def ensure_index():
    if not settings.pinecone_api_key:
        raise RuntimeError("PINECONE_API_KEY is missing")

    desired_dimension = get_embedding_dimension()

    pc = Pinecone(api_key=settings.pinecone_api_key)

    names = [x["name"] for x in pc.list_indexes()]

    if settings.pinecone_index_name in names:

        index_info = pc.describe_index(
            settings.pinecone_index_name
        )

        current_dimension = getattr(
            index_info, "dimension", None
        )

        if current_dimension is None and isinstance(index_info, dict):
            current_dimension = index_info.get("dimension")

        if current_dimension != desired_dimension:
            raise RuntimeError(
                f"Pinecone index dimension mismatch! "
                f"Existing: {current_dimension}, "
                f"Required: {desired_dimension}. "
                "Create a new Pinecone index with the correct "
                "dimension or update PINECONE_INDEX_NAME."
            )

    else:
        pc.create_index(
            name=settings.pinecone_index_name,
            dimension=desired_dimension,
            metric="cosine",
            spec=ServerlessSpec(
                cloud="aws",
                region="us-east-1"
            ),
        )

        while not pc.describe_index(
            settings.pinecone_index_name
        ).status["ready"]:
            time.sleep(1)

    return pc.Index(settings.pinecone_index_name)


def get_vectorstore():
    global _vectorstore

    if _vectorstore is None:
        index = ensure_index()

        _vectorstore = PineconeVectorStore(
            index=index,
            embedding=get_embeddings(),
            namespace=settings.pinecone_namespace,
        )

    return _vectorstore


def get_retriever():
    return get_vectorstore().as_retriever(
        search_kwargs={"k": settings.top_k}
    )


def add_documents(chunks):
    store = get_vectorstore()
    return store.add_documents(chunks)
