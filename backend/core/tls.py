import os
import logging

from core.config import CA_BUNDLE as BUNDLE, NATIVE_CA, ensure_dirs

logger = logging.getLogger(__name__)

ENV_KEYS = ("REQUESTS_CA_BUNDLE", "SSL_CERT_FILE", "GRPC_DEFAULT_SSL_ROOTS_FILE_PATH")


def _combine():
    try:
        import certifi
        base = certifi.where()
    except Exception:
        base = None

    parts = []
    if base and os.path.exists(base):
        with open(base, "r", encoding="utf-8") as f:
            parts.append(f.read())
    if os.path.exists(str(NATIVE_CA)):
        with open(str(NATIVE_CA), "r", encoding="utf-8") as f:
            parts.append(f.read())

    ensure_dirs()
    body = "\n".join(parts)
    with open(str(BUNDLE), "w", encoding="utf-8") as f:
        f.write(body + "\n")


def bundle_path():
    if not os.path.exists(str(BUNDLE)):
        _combine()
    return str(BUNDLE)


def ensure_bundle():
    path = bundle_path()
    for key in ENV_KEYS:
        if not os.environ.get(key):
            os.environ[key] = path
    return path


def root_certificates_bytes():
    return open(bundle_path(), "rb").read()