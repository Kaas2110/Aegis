"""Owned Windows byte-range lease helper; source-only, launched by its JS port.

The permanent one-byte file is infrastructure, not ownership evidence. Ownership
exists only while this process holds the OS lock. There is no PID/age takeover.
EOF releases ownership; no subprocesses, provider calls, or background service.
"""
import json
import os
import sys


def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main():
    if os.name != "nt" or len(sys.argv) != 2:
        raise RuntimeError("windows_lease_arguments")
    import msvcrt
    root = os.path.abspath(sys.argv[1])
    if not os.path.isabs(sys.argv[1]) or not os.path.isdir(root):
        raise RuntimeError("windows_lease_directory")
    lease_path = os.path.join(root, ".artifact-writer-lease")
    with open(lease_path, "a+b", buffering=0) as handle:
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        try:
            size = os.fstat(handle.fileno()).st_size
            if size > 1:
                raise RuntimeError("windows_lease_file_size")
            if size == 0:
                handle.write(b"\0")
                os.fsync(handle.fileno())
            emit({"ready": True, "contract": "aegis.windows-held-artifact-lease.v1"})
            while True:
                line = sys.stdin.buffer.readline(513)
                if not line:
                    break
                if len(line) > 512 or not line.endswith(b"\n"):
                    raise RuntimeError("windows_lease_protocol_limit")
                request = json.loads(line)
                if set(request) != {"id", "operation"} or not isinstance(request["id"], int):
                    raise RuntimeError("windows_lease_protocol")
                if request["operation"] == "release":
                    emit({"id": request["id"], "released": True})
                    break
                if request["operation"] != "assert":
                    raise RuntimeError("windows_lease_operation")
                if not os.path.samestat(os.fstat(handle.fileno()), os.stat(lease_path)):
                    raise RuntimeError("windows_lease_path_replaced")
                emit({"id": request["id"], "held": True})
        finally:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # No paths, inherited environment, secrets or provider data in protocol.
        emit({"error": "windows_lease_failed"})
        sys.exit(1)
