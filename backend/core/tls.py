import os
import logging

logger = logging.getLogger(__name__)

CORE_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(CORE_DIR)
CERTS_DIR = os.path.join(BACKEND_DIR, "certs")
NATIVE_CA = os.path.join(CERTS_DIR, "tinkoff-national-ca.pem")
BUNDLE = os.path.join(CERTS_DIR, "ca-bundle.pem")

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
    if os.path.exists(NATIVE_CA):
        with open(NATIVE_CA, "r", encoding="utf-8") as f:
            parts.append(f.read())

    os.makedirs(CERTS_DIR, exist_ok=True)
    body = "\n".join(parts)
    with open(BUNDLE, "w", encoding="utf-8") as f:
        f.write(body + "\n")


def bundle_path():
    if not os.path.exists(BUNDLE):
        _combine()
    return BUNDLE


def ensure_bundle():
    path = bundle_path()
    for key in ENV_KEYS:
        if not os.environ.get(key):
            os.environ[key] = path
    return path


def root_certificates_bytes():
    return open(bundle_path(), "rb").read()