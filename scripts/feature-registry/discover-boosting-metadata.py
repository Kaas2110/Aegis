"""Read installed distribution metadata only; never import a model backend.

Run with the selected ML Python environment. A found distribution is not proof
of native import/inference/training usability. No providers, fits, or installs.
"""
import json
import platform
from datetime import datetime, timezone
from importlib import metadata


def discover():
    backends = []
    for name in ("lightgbm", "catboost", "xgboost"):
        try:
            version = metadata.version(name)
            if not isinstance(version, str) or not 1 <= len(version) <= 64:
                raise ValueError("invalid_version_metadata")
            status = "distribution_found"
        except metadata.PackageNotFoundError:
            version, status = None, "distribution_not_found"
        except Exception:
            # Avoid leaking arbitrary metadata exception strings or local paths.
            version, status = None, "metadata_error"
        backends.append({"name": name, "status": status, "version": version,
                         "importUsability": "not_tested"})
    return {
        "contract": "aegis.boosting-backend-metadata.v1",
        "discovery": "stdlib_importlib_metadata_only_no_backend_import",
        "recordedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "pythonVersion": platform.python_version(),
        "platform": platform.system(),
        "backends": backends,
        "nativeImports": False,
        "fits": 0,
        "providerCalls": 0,
        "runtimeActivation": False,
    }


if __name__ == "__main__":
    print(json.dumps(discover(), sort_keys=True, separators=(",", ":")))
