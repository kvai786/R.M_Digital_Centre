"""Local-only OCR endpoint for the R.M Digital Centre demo."""

from __future__ import annotations

from contextlib import asynccontextmanager
from io import BytesIO
import logging
from typing import AsyncIterator

import cv2
import easyocr
import numpy as np
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool

MAX_UPLOAD_BYTES = 8 * 1024 * 1024
MAX_IMAGE_DIMENSION = 8000
MAX_IMAGE_PIXELS = 20_000_000
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png"}
ALLOWED_ORIGINS = {"http://127.0.0.1:8000", "http://localhost:8000"}
LOGGER = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    app.state.ocr_reader = easyocr.Reader(["en", "hi"], gpu=False)
    yield


app = FastAPI(title="R.M Digital Centre local OCR", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(ALLOWED_ORIGINS),
    allow_credentials=False,
    allow_methods=["POST"],
    allow_headers=["Content-Type"],
)


@app.post("/api/scan-document")
async def scan_document(request: Request, file: UploadFile = File(...)) -> dict[str, str]:
    if request.headers.get("origin") not in ALLOWED_ORIGINS:
        raise HTTPException(status_code=403, detail="Requests must come from the local portal.")
    if file.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=415,
            detail="Select a JPEG or PNG image. PDF scanning is not supported.",
        )

    contents = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="The image must be 8 MB or smaller.")
    if not contents:
        raise HTTPException(status_code=400, detail="The uploaded image is empty.")

    try:
        with Image.open(BytesIO(contents)) as image_header:
            if image_header.format not in {"JPEG", "PNG"}:
                raise HTTPException(
                    status_code=415,
                    detail="Select a JPEG or PNG image. PDF scanning is not supported.",
                )
            width, height = image_header.size
            if (
                width > MAX_IMAGE_DIMENSION
                or height > MAX_IMAGE_DIMENSION
                or width * height > MAX_IMAGE_PIXELS
            ):
                raise HTTPException(
                    status_code=413,
                    detail="Image dimensions exceed the local scan service limit.",
                )
            image_header.verify()
    except UnidentifiedImageError as error:
        raise HTTPException(status_code=400, detail="The uploaded file is not a valid image.") from error
    except Image.DecompressionBombError as error:
        raise HTTPException(status_code=413, detail="The image dimensions exceed the scan service limit.") from error
    except (OSError, SyntaxError, ValueError) as error:
        raise HTTPException(status_code=400, detail="The uploaded image could not be decoded.") from error

    encoded_image = np.frombuffer(contents, dtype=np.uint8)
    image = cv2.imdecode(encoded_image, cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=400, detail="The uploaded file is not a readable image.")

    height, width = image.shape[:2]
    if height > MAX_IMAGE_DIMENSION or width > MAX_IMAGE_DIMENSION:
        raise HTTPException(
            status_code=413,
            detail="Image dimensions must not exceed 8000 by 8000 pixels.",
        )

    try:
        results = await run_in_threadpool(app.state.ocr_reader.readtext, image)
    except Exception as error:
        LOGGER.exception("Local document OCR failed")
        raise HTTPException(status_code=500, detail="OCR processing failed.") from error

    extracted_text = " ".join(result[1] for result in results)
    return {
        "status": "success",
        "extracted_text": extracted_text,
        "message": "Image text extraction completed. Document authenticity was not verified.",
    }
